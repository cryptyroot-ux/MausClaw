// Budget guard: enforces per-thread and per-run cost limits.
// Additive port of MausClaw-Pivot's server/routing/budget-guard.ts.
import type { Budget } from "./types.ts";

export interface BudgetGuardLimits {
  readonly perThreadLimit?: number;
  readonly perRunLimit?: number;
  readonly threadLimit?: number;
  readonly runLimit?: number;
  readonly maxThreadCost?: number;
  readonly maxRunCost?: number;
  readonly perThread?: number;
  readonly perRun?: number;
  readonly thread?: number;
  readonly maxThread?: number;
  readonly maxRun?: number;
  /** Optional per-category limits, e.g. { engine: 10, verifier: 5, compaction: 3 }. */
  readonly perCategory?: Readonly<Record<string, number>>;
}

export interface CategoryCost {
  readonly category: string;
  readonly primary?: { readonly estimatedCost?: number; readonly cost?: number; readonly [key: string]: unknown };
  readonly estimatedCost?: number;
  readonly cost?: number;
  readonly [key: string]: unknown;
}

export class BudgetGuard {
  private readonly perThreadLimit: number;
  private readonly perRunLimit: number;
  private readonly perCategoryLimits: Readonly<Record<string, number>>;
  private readonly threadSpend = new Map<string, number>();
  private readonly categorySpend = new Map<string, Map<string, number>>();
  private runSpend = 0;

  constructor(
    limits: BudgetGuardLimits | number = {},
    perRunLimit?: number,
  ) {
    if (typeof limits === "number") {
      this.perThreadLimit = Number.isFinite(limits) ? limits : Infinity;
      this.perRunLimit = typeof perRunLimit === "number" && Number.isFinite(perRunLimit) ? perRunLimit : Infinity;
      this.perCategoryLimits = {};
      return;
    }
    const l = limits ?? {};
    const finite = (v: unknown): number | undefined =>
      typeof v === "number" && Number.isFinite(v) ? v : undefined;
    this.perThreadLimit =
      finite(l.perThreadLimit) ??
      finite(l.perThread) ??
      finite(l.threadLimit) ??
      finite(l.thread) ??
      finite(l.maxThreadCost) ??
      finite(l.maxThread) ??
      Infinity;
    this.perRunLimit =
      finite(l.perRunLimit) ??
      finite(l.perRun) ??
      finite(l.runLimit) ??
      finite(l.maxRunCost) ??
      finite(l.maxRun) ??
      Infinity;
    this.perCategoryLimits = l.perCategory ?? {};
  }

  private toCost(cost: unknown): number {
    if (cost && typeof cost === "object") {
      const obj = cost as Record<string, unknown>;
      if (obj.primary && typeof obj.primary === "object") {
        const primary = obj.primary as Record<string, unknown>;
        const candidate =
          primary.estimatedCost ?? primary.cost ?? primary.maxCost ?? primary.price ?? primary.amount;
        cost = candidate;
      } else {
        const candidate =
          obj.estimatedCost ?? obj.cost ?? obj.maxCost ?? obj.price ?? obj.amount;
        cost = candidate;
      }
    }
    const num = typeof cost === "string" ? Number(cost) : cost;
    if (typeof num !== "number" || !Number.isFinite(num)) return 0;
    return Math.max(0, num);
  }

  private categoryOf(cost: unknown): string {
    if (cost && typeof cost === "object") {
      const obj = cost as Record<string, unknown>;
      if (typeof obj.category === "string") return obj.category;
    }
    return "default";
  }

  check(cost: unknown, threadId?: string): boolean {
    const normalizedCost = this.toCost(cost);
    const key = threadId ?? "";
    const category = this.categoryOf(cost);

    // Overall thread and run limits.
    const threadTotal = (this.threadSpend.get(key) ?? 0) + normalizedCost;
    const runTotal = this.runSpend + normalizedCost;
    if (threadTotal > this.perThreadLimit) return false;
    if (runTotal > this.perRunLimit) return false;

    // Per-category thread limit.
    const catLimit = this.perCategoryLimits[category];
    if (catLimit !== undefined) {
      const catSpendMap = this.categorySpend.get(key) ?? new Map();
      const catTotal = (catSpendMap.get(category) ?? 0) + normalizedCost;
      if (catTotal > catLimit) return false;
    }

    return true;
  }

  record(cost: unknown, threadId?: string): void {
    const normalizedCost = this.toCost(cost);
    const key = threadId ?? "";
    const category = this.categoryOf(cost);

    this.threadSpend.set(key, (this.threadSpend.get(key) ?? 0) + normalizedCost);
    this.runSpend += normalizedCost;

    let catSpendMap = this.categorySpend.get(key);
    if (!catSpendMap) {
      catSpendMap = new Map();
      this.categorySpend.set(key, catSpendMap);
    }
    catSpendMap.set(category, (catSpendMap.get(category) ?? 0) + normalizedCost);
  }

  getThreadSpend(threadId?: string): number {
    return this.threadSpend.get(threadId ?? "") ?? 0;
  }

  getRunSpend(): number {
    return this.runSpend;
  }

  getCategorySpend(category: string, threadId?: string): number {
    return this.categorySpend.get(threadId ?? "")?.get(category) ?? 0;
  }

  resetRun(): void {
    this.runSpend = 0;
  }

  reset(): void {
    this.resetRun();
  }

  resetThread(threadId?: string): void {
    this.threadSpend.delete(threadId ?? "");
    this.categorySpend.delete(threadId ?? "");
  }

  resetAll(): void {
    this.threadSpend.clear();
    this.categorySpend.clear();
    this.runSpend = 0;
  }

  toBudget(): Budget {
    return { maxCost: this.perThreadLimit };
  }
}
