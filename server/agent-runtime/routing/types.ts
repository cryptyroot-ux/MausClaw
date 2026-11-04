// Routing types for the MausClaw-native intelligence layer.
// Additive to MausClaw's existing contracts; no existing types are modified.
export interface ModelCost {
  readonly input: number;
  readonly output: number;
}

export interface RoutingRule {
  readonly primary: string;
  readonly fallbacks: ReadonlyArray<string>;
  readonly qualityScores?: Readonly<Record<string, number>>;
  /** Provider that owns the primary/fallback models. Empty string is rejected:
   * hard-coded cross-provider routes that do not correspond to configured
   * adapters are not allowed (M8). */
  readonly provider: string;
}

export interface Budget {
  readonly maxCost: number;
}

export interface ModelAssignment {
  readonly stepId?: string;
  readonly primary: {
    readonly provider: string;
    readonly model: string;
    readonly estimatedCost: number;
  };
  readonly fallbacks: ReadonlyArray<string>;
  readonly reasoning?: string;
}
