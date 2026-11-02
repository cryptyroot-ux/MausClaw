// Fallback chain: try the primary model, then fallbacks in order, up to maxRetries attempts.
// Additive port of OpenMausBot-Pivot's server/routing/fallback-chain.ts.

import { failoverKind, failoverHold, type FailoverKind } from "../../drivers/failover.ts";

export interface FallbackChainOptions {
  readonly maxRetries?: number;
  readonly threadId?: string;
  readonly executor?: (model: string, input: unknown) => Promise<unknown>;
}

export class FallbackChain {
  private executor: ((model: string, input: unknown) => Promise<unknown>) | undefined;
  private readonly options: FallbackChainOptions;
  /** Model that ultimately succeeded on the most recent execute() call. */
  public lastSucceededModel: string | undefined;
  /** Last classified failover kind and its hold info (observation only; throw/continue behavior unchanged). */
  public lastFailoverKind: FailoverKind | null = null;
  public lastFailoverHold: ReturnType<typeof failoverHold> | null = null;

  static execute(...args: unknown[]): Promise<unknown> {
    return new FallbackChain().execute(...args);
  }

  constructor(
    executorOrOptions?: ((model: string, input: unknown) => Promise<unknown>) | FallbackChainOptions,
    options?: FallbackChainOptions,
  ) {
    if (typeof executorOrOptions === "function") {
      this.executor = executorOrOptions;
      this.options = options ?? {};
    } else {
      this.executor = executorOrOptions?.executor;
      this.options = executorOrOptions ?? {};
      if (options) {
        this.options = { ...this.options, ...options };
        if (typeof options.executor === "function") this.executor = options.executor;
      }
    }
  }

  /** Last classified failover kind and hold info from the most recent execute() call; null when no error was classified. */
  get lastFailover(): { kind: FailoverKind | null; hold: ReturnType<typeof failoverHold> | null } {
    return { kind: this.lastFailoverKind, hold: this.lastFailoverHold };
  }

  async execute(...args: unknown[]): Promise<unknown> {
    let primaryModel: string;
    let fallbackList: ReadonlyArray<string> = [];
    const rest: unknown[] = [];

    const first = args[0];
    if (typeof first === "string") {
      primaryModel = first;
      if (Array.isArray(args[1])) fallbackList = args[1] as ReadonlyArray<string>;
      rest.push(...args.slice(2));
    } else if (first && typeof first === "object") {
      const assignment = first as {
        primary?: unknown;
        fallbacks?: ReadonlyArray<string>;
        model?: string;
      };
      if (assignment.primary && typeof assignment.primary === "object") {
        primaryModel = (assignment.primary as { model?: string }).model ?? String(assignment.primary);
      } else {
        primaryModel = String(assignment.primary ?? assignment.model ?? "");
      }
      fallbackList = Array.isArray(assignment.fallbacks) ? assignment.fallbacks : [];
      rest.push(...args.slice(1));
    } else {
      primaryModel = "";
      rest.push(...args);
    }

    let executor = this.executor;
    let input: unknown = {};
    let maxRetries = this.options.maxRetries;

    for (const arg of rest) {
      if (typeof arg === "function") {
        executor = arg as (model: string, input: unknown) => Promise<unknown>;
      } else if (arg && typeof arg === "object") {
        const obj = arg as Record<string, unknown>;
        input = obj;
        if (typeof obj.executor === "function") executor = obj.executor as (model: string, input: unknown) => Promise<unknown>;
        if (typeof obj.maxRetries === "number") maxRetries = obj.maxRetries;
      }
    }

    if (!executor) {
      throw new Error("No executor provided to FallbackChain");
    }

    const limit = typeof maxRetries === "number" ? maxRetries : Infinity;
    const models: string[] = [];
    const seen = new Set<string>();
    for (const model of [primaryModel, ...fallbackList]) {
      if (seen.has(model)) continue;
      seen.add(model);
      models.push(model);
    }
    const attempts = models.slice(0, Math.max(0, Number.isFinite(limit) ? limit : models.length));

    let lastError: unknown;
    this.lastSucceededModel = undefined;

    // Failover cooldown carried over from the previous execute() turn. A model that failed with
    // a holdable kind stays out of rotation until limitResetsAt passes; an engine-wide (quota)
    // hold or an auth-required stop halts the chain outright.
    const priorHold = this.lastFailoverHold;
    if (
      priorHold?.limit === "model" &&
      typeof priorHold.limitResetsAt === "number" &&
      Date.now() >= priorHold.limitResetsAt
    ) {
      // Hold expired: clear so the lastFailover getter stays accurate.
      this.lastFailoverKind = null;
      this.lastFailoverHold = null;
    }

    for (let i = 0; i < attempts.length; i++) {
      const model = attempts[i];

      // Enforce the failover cooldown before dispatching to a model.
      if (priorHold) {
        if (priorHold.stopReason === "auth_required") {
          throw new Error("failover: auth required (stop)");
        }
        if (priorHold.limit === "engine") {
          throw new Error("failover: engine-wide hold (quota)");
        }
        if (
          priorHold.limit === "model" &&
          typeof priorHold.limitResetsAt === "number" &&
          Date.now() < priorHold.limitResetsAt
        ) {
          continue; // model still in cooldown; try the next one
        }
      }

      try {
        const result = await executor(model, input);
        const failed = !!result && typeof result === "object" && (result as { ok?: unknown }).ok === false;
        if (failed) {
          lastError = new Error(
            (result as { error?: string; text?: string }).error ??
              (result as { text?: string }).text ??
              "model returned failure",
          );
          continue;
        }
        this.lastSucceededModel = model;
        if (result && typeof result === "object") {
          return result;
        }
        return result;
      } catch (error) {
        lastError = error;
        const state = { aborted: false, produced: false, tooLarge: false };
        const kind = failoverKind(error as Error, state);
        if (kind) {
          this.lastFailoverKind = kind;
          this.lastFailoverHold = failoverHold(kind);
        }
      }
    }

    if (lastError) {
      throw lastError instanceof Error ? lastError : new Error(String(lastError));
    }
    throw new Error("Fallback chain exhausted");
  }
}
