// server/routing/types.ts

export interface ModelCost {
  input: number;
  output: number;
}

export interface RoutingRule {
  primary: string;
  fallbacks: string[];
  qualityScores?: Record<string, number>;
  /** Provider that owns the primary/fallback models. Empty string is rejected:
   * hard-coded cross-provider routes that do not correspond to configured
   * adapters are not allowed (M8). */
  provider: string;
}

export interface Budget {
  maxCost: number;
}

export interface ModelAssignment {
  stepId?: string;
  primary: {
    provider: string;
    model: string;
    estimatedCost: number;
  };
  fallbacks: string[];
  reasoning?: string;
}
