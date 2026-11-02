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
}

export class BudgetGuard {
  private readonly perThreadLimit: number;
  private readonly perRunLimit: number;
  private readonly threadSpend = new Map<string, number>();
  private runSpend = 0;

  constructor(
    limits: BudgetGuardLimits | number = {},
    perRunLimit?: number,
  ) {
    if (typeof limits === "number") {
      this.perThreadLimit = Number.isFinite(limits) ? limits : Infinity;
      this.perRunLimit = typeof perRunLimit === "number" && Number.isFinite(perRunLimit) ? perRunLimit : Infinity;
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

  check(cost: unknown, threadId?: string): boolean {
    const normalizedCost = this.toCost(cost);
    const key = threadId ?? "";
    const threadTotal = (this.threadSpend.get(key) ?? 0) + normalizedCost;
    const runTotal = this.runSpend + normalizedCost;
    return threadTotal <= this.perThreadLimit && runTotal <= this.perRunLimit;
  }

  record(cost: unknown, threadId?: string): void {
    const normalizedCost = this.toCost(cost);
    const key = threadId ?? "";
    this.threadSpend.set(key, (this.threadSpend.get(key) ?? 0) + normalizedCost);
    this.runSpend += normalizedCost;
  }

  getThreadSpend(threadId?: string): number {
    return this.threadSpend.get(threadId ?? "") ?? 0;
  }

  getRunSpend(): number {
    return this.runSpend;
  }

  resetRun(): void {
    this.runSpend = 0;
  }

  reset(): void {
    this.resetRun();
  }

  resetThread(threadId?: string): void {
    this.threadSpend.delete(threadId ?? "");
  }

  resetAll(): void {
    this.threadSpend.clear();
    this.runSpend = 0;
  }

  toBudget(): Budget {
    return { maxCost: this.perThreadLimit };
  }
}
