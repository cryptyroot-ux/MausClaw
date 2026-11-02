// Whether a turn's agents proxy lists its tools through the tool bridge.
// Security invariant: the default is no bridge.
import { TOOL_BRIDGE_ENV } from "./drivers/agents-bridge.ts";
import { AGENTS_NODE_FLAG, SPAWNED_PROXIES } from "./proxy-paths.ts";

export { TOOL_BRIDGE_ENV };

/** The command that starts a turn's agents proxy. */
export const agentsProxyLaunch = () => ({ command: process.execPath, args: [SPAWNED_PROXIES.agents] });

/** Every agents proxy's starting environment. The bridge is always set, never inherited. */
export const AGENTS_PROXY_ENV = { ...AGENTS_NODE_FLAG, [TOOL_BRIDGE_ENV]: "0" } as const;

type BridgeConfig = { features?: { agentsToolBridge?: boolean } };

/** The workspace switch: `{"features": {"agentsToolBridge": true}}` in config, or MAUSCLAW_AGENTS_TOOL_BRIDGE env. */
export function agentsToolBridgeEnabled(cfg: BridgeConfig, env: NodeJS.ProcessEnv = process.env): boolean {
  const override = env[TOOL_BRIDGE_ENV];
  if (override === "1") return true;
  if (override === "0") return false;
  return cfg.features?.agentsToolBridge === true;
}

/** The engine a turn runs on, as far as the decision reads it. */
export interface BridgeEngine {
  driverKind: string;
  instanceId?: string;
  config?: unknown;
  environment?: Record<string, string | undefined>;
  version?: string | null;
  cwd?: string;
}

/** A turn's engine from its live instance, the instance configs, its last snapshot and its folder. */
export function turnEngine(
  instance: { instanceId: string; driverKind: string },
  configs: Record<string, { config?: unknown; environment?: Record<string, string> } | undefined>,
  snapshot: { version?: string | null } | undefined,
  cwd: string | undefined,
): BridgeEngine {
  const { config, environment } = configs[instance.instanceId] ?? {};
  return {
    driverKind: instance.driverKind,
    instanceId: instance.instanceId,
    ...(config !== undefined ? { config } : {}),
    ...(environment !== undefined ? { environment } : {}),
    ...(snapshot?.version != null ? { version: snapshot.version } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
  };
}

const CHAT_RUNTIME_DRIVERS: ReadonlySet<string> = new Set(["cerebras", "grok", "groq", "meta", "minimax", "mistral", "openai-compat"]);

/** Why a turn of `bot` on `engine` is not bridged, or null: the one decision. */
export function engineBridgeRefusal(
  _cfg: BridgeConfig,
  engine: BridgeEngine | null | undefined,
  _env: NodeJS.ProcessEnv = process.env,
  _host: { home: string; managedPolicyFiles: readonly string[] } = { home: "", managedPolicyFiles: [] },
): string | null {
  if (!engine) return "no engine";
  const { driverKind } = engine;
  if (CHAT_RUNTIME_DRIVERS.has(driverKind)) return null;
  return "this engine keeps its own tool permissions";
}

/** Why a turn of `bot` on `engine` is not bridged, or null: the one decision. */
export function agentsToolBridgeRefusal(
  _cfg: BridgeConfig,
  engine: BridgeEngine | null | undefined,
  _env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (!engine) return "no engine";
  const { driverKind } = engine;
  if (CHAT_RUNTIME_DRIVERS.has(driverKind)) return null;
  return "this engine keeps its own tool permissions";
}

export const BRIDGED_THREADS_MAX = 5_000;

export function bridgedAgents<Agents extends { env: Record<string, string> }>(
  agents: Agents,
  cfg: BridgeConfig,
  env: NodeJS.ProcessEnv = process.env,
): Agents | null {
  if (!agentsToolBridgeEnabled(cfg, env)) return null;
  if (agentsToolBridgeRefusal(cfg, { driverKind: "native", config: agents.env, environment: agents.env }, env)) return null;
  return agents;
}

export function applyAgentsBridge<Agents extends Record<string, unknown>>(
  _threadId: string,
  agents: Agents,
  _cfg: BridgeConfig,
  _bot: { modelSelection: { instanceId: string } },
  _engine: BridgeEngine,
  _env: NodeJS.ProcessEnv = process.env,
): Agents {
  return agents;
}

export function bridgedToolTitle(_threadId: string, title: string, _input: unknown): string {
  return title;
}
