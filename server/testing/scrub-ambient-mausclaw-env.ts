// Side-effect import that scrubs ambient MausClaw env before a module snapshots it (scripts/mcp-server.ts reads
// MAUSCLAW_URL / MAUSCLAW_PORT at evaluation). Import order is the contract: keep it above the module under test.
import { isAmbientMausclawKey } from "./mausclaw-env.ts";

for (const key of Object.keys(process.env)) {
  if (isAmbientMausclawKey(key)) delete process.env[key];
}
