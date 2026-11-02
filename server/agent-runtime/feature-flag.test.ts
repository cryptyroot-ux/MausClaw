import { describe, it, expect } from "vitest";
import { isIntelligenceEnabled } from "./feature-flag.ts";

describe("isIntelligenceEnabled", () => {
  it("returns true when config.intelligenceLayer is true", () => {
    expect(isIntelligenceEnabled({ intelligenceLayer: true } as any)).toBe(true);
  });

  it("returns true when config.intelligence.enabled is true", () => {
    expect(isIntelligenceEnabled({ intelligence: { enabled: true } } as any)).toBe(true);
  });

  it("returns true when MAUSCLAW_INTELLIGENCE_LAYER=true", () => {
    const orig = process.env.MAUSCLAW_INTELLIGENCE_LAYER;
    process.env.MAUSCLAW_INTELLIGENCE_LAYER = "true";
    expect(isIntelligenceEnabled({} as any)).toBe(true);
    if (orig === undefined) delete process.env.MAUSCLAW_INTELLIGENCE_LAYER;
    else process.env.MAUSCLAW_INTELLIGENCE_LAYER = orig;
  });

  it("returns false by default", () => {
    expect(isIntelligenceEnabled({} as any)).toBe(false);
    expect(isIntelligenceEnabled(null as any)).toBe(false);
    expect(isIntelligenceEnabled(undefined as any)).toBe(false);
  });

  it("returns false when MAUSCLAW_INTELLIGENCE_LAYER is not true", () => {
    const orig = process.env.MAUSCLAW_INTELLIGENCE_LAYER;
    process.env.MAUSCLAW_INTELLIGENCE_LAYER = "false";
    expect(isIntelligenceEnabled({} as any)).toBe(false);
    if (orig === undefined) delete process.env.MAUSCLAW_INTELLIGENCE_LAYER;
    else process.env.MAUSCLAW_INTELLIGENCE_LAYER = orig;
  });
});
