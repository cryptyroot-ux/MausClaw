// Verifier: LLM-based step verification. After a step produces output, the verifier
// checks whether the actual result satisfies its success criteria.
// Additive port of MausClaw-Pivot's server/intelligence/verifier.ts.
import type { PlanStep, VerificationResult } from "./types.ts";
import { extractJson } from "../extract-json.ts";

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function serializeResult(result: unknown): string {
  if (result == null) return "";
  if (typeof result === "string") return result;
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

export class Verifier {
  private readonly modelCaller: (prompt: string) => Promise<string>;

  constructor(modelCaller: (prompt: string) => Promise<string>) {
    this.modelCaller = modelCaller;
  }

  async verify(step: PlanStep, _threadId: string = ""): Promise<VerificationResult> {
    const prompt = [
      "You are a verification agent. Determine whether the step's actual result satisfies its success criteria.",
      `Step description: ${step.description}`,
      `Success criteria: ${step.successCriteria}`,
      `Actual result: ${serializeResult(step.result)}`,
      "Return JSON only: { \"verified\": boolean, \"evidence\": string, \"confidence\": number (0-1), \"reworkSuggestions\": string[] }.",
      "Be conservative: only mark verified true when the evidence clearly shows the criteria are met.",
    ].join("\n");

    try {
      const raw = await this.modelCaller(prompt);
      let parsed: unknown;
      try {
        parsed = extractJson(raw, "verification");
      } catch {
        return { verified: false, evidence: "", confidence: 0 };
      }

      const obj = (parsed ?? {}) as Record<string, unknown>;
      const verified = obj.verified === true;
      const evidence = typeof obj.evidence === "string" ? obj.evidence : "";
      const confidence = clamp(typeof obj.confidence === "number" ? obj.confidence : 0);
      const reworkSuggestions = Array.isArray(obj.reworkSuggestions)
        ? obj.reworkSuggestions.filter((x): x is string => typeof x === "string")
        : undefined;

      return {
        verified,
        evidence,
        confidence,
        reworkSuggestions,
      };
    } catch {
      return { verified: false, evidence: "", confidence: 0 };
    }
  }
}
