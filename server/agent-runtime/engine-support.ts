// MausClaw adalah platform agen AI mandiri. Semua driver agen eksternal
// (CLI/ACP: Claude, Codex, Hermes, Pi, Antigravity, OpenCode, Qwen, Cursor,
// dll.) telah dihapus total. Hanya driver API native yang dijalankan di atas
// MausClaw-owned native agent engine. Provider/model dihubungkan melalui
// ModelAdapter, bukan melalui CLI atau proses ACP eksternal.

/** API drivers whose turns run on the MausClaw-owned native loop. */
const NATIVE_API_DRIVER_KINDS = new Set([
  "openai-compat",
  "grok",
  "groq",
  "meta",
  "minimax",
  "mistral",
  "cerebras",
  "anthropic",
  "gemini",
  "openai-responses",
]);

export function usesNativeAgentEngine(driverKind: string): boolean {
  return NATIVE_API_DRIVER_KINDS.has(driverKind);
}

export function supportedAgentDrivers<T extends { readonly driverKind: string }>(
  drivers: readonly T[],
): readonly T[] {
  return drivers.filter((driver) => usesNativeAgentEngine(driver.driverKind));
}
