// INTELLIGENCE_LAYER feature flag. Off by default; either the persisted config
// (`intelligenceLayer: true`) or `MAUSCLAW_INTELLIGENCE_LAYER=true` turns it on.
type ConfigStatus = Record<string, unknown>;

export function isIntelligenceEnabled(
  config: ConfigStatus | null | undefined = {},
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const cfg = (config ?? {}) as { intelligenceLayer?: unknown; intelligence?: { enabled?: unknown } };
  if (cfg.intelligenceLayer === true) return true;
  if (cfg.intelligence?.enabled === true) return true;
  const value = env?.MAUSCLAW_INTELLIGENCE_LAYER;
  if (typeof value === "string" && value.trim() === "true") return true;
  return false;
}
