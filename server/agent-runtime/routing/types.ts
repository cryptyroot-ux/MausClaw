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
