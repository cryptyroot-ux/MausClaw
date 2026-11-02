// A shell exporting MAUSCLAW_* / MAUSCLAW_* leaks them into every child and import-time env snapshot.

const AMBIENT_PREFIXES = ["MAUSCLAW_", "MAUSCLAW_"] as const;

export function isAmbientMausclawKey(key: string): boolean {
  return AMBIENT_PREFIXES.some((prefix) => key.startsWith(prefix));
}

export function stripMausclawEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (!isAmbientMausclawKey(key)) clean[key] = value;
  }
  return clean;
}

export function childEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...stripMausclawEnv(process.env), ...overrides };
}
