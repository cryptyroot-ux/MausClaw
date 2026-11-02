import { providerIconError } from "../../shared/provider-icon.ts";
import { z } from "zod";
import { persistableInstanceConfigs, saveConfig, withInstanceCli, type AppConfig } from "../config.ts";
import { addEndpoint, addEndpointSchema, isAddedEndpoint, withEndpointUrls } from "../openai-compat-endpoints.ts";
import type { InstanceConfigMap, ModelSelection, ProviderInstance } from "../contracts.ts";
import { BUILT_IN_DRIVERS } from "../drivers/builtIn.ts";
import { findCliCandidates, resetPathCache } from "../env-path.ts";
import type { ProviderRegistry } from "../harness/registry.ts";
import { checkEngine, type EngineCheck } from "../engine-check.ts";
import { HOSTED_PROVIDER_SETTINGS_ERROR } from "../hosted-models.ts";
import type { ProviderAuthSessions } from "../provider-auth-sessions.ts";
import { providerIconPatchSchema, withInstanceIcon } from "../provider-icon.ts";
import { isLoopbackHost, isProxied } from "../request-auth.ts";
import type { SessionRegistry } from "../sessions.ts";
import type { Store } from "../store.ts";
import type { BusyFlag, ConfigStatus } from "./config.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface InstanceRouteDeps {
  store: Pick<Store, "bots" | "tasks">;
  cfg: AppConfig;
  registry: Pick<ProviderRegistry, "get" | "refreshModels" | "installRuntime" | "cliTarget" | "forgetSnapshots">;
  sessions: Pick<SessionRegistry, "isLive">;
  providerAuthSessions: Pick<ProviderAuthSessions, "status" | "start" | "revokeOwner" | "signOut" | "complete" | "cancel">;
  hostedModels: boolean;
  providerConfigBusy: BusyFlag;
  providerInstancesChanging: Pick<Set<string>, "add" | "delete">;
  describeInstances(): Promise<unknown>;
  persistProviderInstance(instanceId: string, instances: InstanceConfigMap): Promise<void>;
  configStatus(): ConfigStatus;
  broadcast(payload: Record<string, unknown>): void;
  testCliBinary(cli: string, driver: (typeof BUILT_IN_DRIVERS)[number] | undefined): Promise<unknown>;
  threadBusy(botId: string, threadId: string): boolean;
  botForThread(botId: string, threadId: string): Pick<{ modelSelection: ModelSelection }, "modelSelection"> | null;
  activeGroupTurnForBot(botId: string): { threadId: string } | null;
  /** The server's tested-AI record (server/tested-ai.ts): a check there also settles the new-bot default. */
  checkInstance?(instance: ProviderInstance): Promise<EngineCheck>;
}

export function createInstanceRoutes(deps: InstanceRouteDeps): RouteHandler {
  const instanceSettingsSchema = z.object({
    cli: z.string().max(4096).optional(),
    tools: z.boolean().optional(),
    displayName: z.string().trim().min(1).max(80).optional(),
    replyWaitMinutes: z.number().int().min(1).max(60).nullable().optional(),
  }).strict().refine((value) => Object.keys(value).length > 0, "No settings supplied");
  const {
    store, cfg, registry, sessions, providerAuthSessions, hostedModels, providerConfigBusy, providerInstancesChanging,
    persistProviderInstance, configStatus, broadcast, testCliBinary, threadBusy,
    botForThread, activeGroupTurnForBot,
  } = deps;
  const describeInstances = async () => hostedModels ? deps.describeInstances() : withEndpointUrls(await deps.describeInstances(), cfg.instances ?? {});
  const busyProviderSelections = () => store.bots.flatMap((bot) => {
    const busyTasks = store.tasks(bot.id).filter((task) => threadBusy(bot.id, task.threadId));
    const selections = busyTasks.map((task) => botForThread(bot.id, task.threadId)!.modelSelection);
    if (activeGroupTurnForBot(bot.id) || (bot.busy && busyTasks.length === 0)) selections.push(bot.modelSelection);
    return selections;
  });
  /** After the app installed its own copy of an engine whose CLI found a copy that does not start: point the engine at the
   * app's copy, as Set CLI would. Not while provider settings are changing or a bot is using the engine. */
  const useAppCopy = async (instanceId: string, cli: string): Promise<boolean> => {
    if (providerConfigBusy.get() || busyProviderSelections().some((selection) => selection.instanceId === instanceId)) return false;
    providerConfigBusy.set(true);
    providerInstancesChanging.add(instanceId);
    try {
      const result = withInstanceCli(cfg, instanceId, cli);
      const instances = persistableInstanceConfigs(result.config);
      if (!result.ok || !Object.hasOwn(instances, instanceId)) return false;
      await persistProviderInstance(instanceId, instances);
      return true;
    } finally {
      providerInstancesChanging.delete(instanceId);
      providerConfigBusy.set(false);
    }
  };
  return async ({ req, res, url, path, method, auth, json, readBody }) => {
    if (method === "GET" && path === "/api/instances") {
      // Rescan PATH: Windows never pushes PATH changes into a live process, so a CLI installed since launch stays invisible.
      resetPathCache();
      return json(res, 200, { instances: await describeInstances() });
    }
    const companyMutation = /^\/api\/instances\/(company\.[\w.-]+)(?:\/|$)/.exec(path);
    if (hostedModels && path.startsWith("/api/instances/") && method !== "GET") return json(res, 403, { error: HOSTED_PROVIDER_SETTINGS_ERROR });
    if (companyMutation && method !== "GET") return json(res, 403, { error: "Company accounts are read-only here. Manage this connection in desktop Settings." });

    const instanceIconPatch = /^\/api\/instances\/([\w.-]+)\/icon$/.exec(path);
    if (method === "PATCH" && instanceIconPatch) {
      if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      const parsed = providerIconPatchSchema.safeParse(await readBody(req, 192 * 1024));
      if (!parsed.success) {
        const detail = parsed.error.issues[0]?.message;
        return json(res, 400, { error: detail && detail !== "Invalid input" ? detail : "Choose a built-in icon or upload a PNG, JPEG, or WebP image up to 128 KB." });
      }
      if (parsed.data.icon) {
        const invalid = providerIconError(parsed.data.icon);
        if (invalid) return json(res, 400, { error: invalid });
      }
      if (providerConfigBusy.get()) return json(res, 409, { error: "provider settings are already being updated" });
      providerConfigBusy.set(true);
      try {
        const changed = withInstanceIcon(cfg, instanceIconPatch[1], parsed.data.icon);
        if (!changed.ok) return json(res, 404, { error: `unknown instance "${instanceIconPatch[1]}"` });
        saveConfig({ instances: changed.instances }, { replaceInstances: true });
        cfg.instances = changed.instances;
        broadcast({ kind: "config", ...configStatus() });
        return json(res, 200, { instances: await describeInstances() });
      } finally { providerConfigBusy.set(false); }
    }

    if (method === "POST" && path === "/api/instances/openai-compat") {
      if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) return json(res, 415, { error: "content-type must be application/json" });
      const parsed = addEndpointSchema.safeParse(await readBody(req, 8192));
      if (!parsed.success) return json(res, 400, { error: "Enter a display name (up to 80 characters), a base URL and an API key." });
      if (providerConfigBusy.get()) return json(res, 409, { error: "provider settings are already being updated" });
      providerConfigBusy.set(true);
      try {
        const instances = persistableInstanceConfigs(cfg);
        const added = addEndpoint(instances, parsed.data);
        if ("error" in added) return json(res, 400, { error: added.error });
        await persistProviderInstance(added.instanceId, instances);
        return json(res, 201, { instanceId: added.instanceId, instances: await describeInstances() });
      } finally { providerConfigBusy.set(false); }
    }

    const authStatus = /^\/api\/instances\/([\w.-]+)\/auth\/status$/.exec(path);
    if (method === "GET" && authStatus) {
      res.setHeader("cache-control", "no-store");
      const state = await providerAuthSessions.status(authStatus[1], auth.kind === "session" ? auth.session.id : "loopback", url.searchParams.get("flowId") ?? "");
      if (state.phase !== "waiting") registry.forgetSnapshots();
      return json(res, 200, { auth: state });
    }
    const instanceAction = /^\/api\/instances\/([\w.-]+)\/(refresh-models|install|check|auth\/start|auth\/complete|auth\/cancel|auth\/sign-out)$/.exec(path);
    if (method === "POST" && instanceAction) {
      if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      const instanceId = instanceAction[1];
      const action = instanceAction[2];
      const owner = auth.kind === "session" ? auth.session.id : "loopback";
      if (action.startsWith("auth/")) res.setHeader("cache-control", "no-store");
      try {
        if (action === "check") {
          const instance = registry.get(instanceId);
          if (!instance) return json(res, 404, { error: "unknown instance" });
          res.setHeader("cache-control", "no-store");
          return json(res, 200, await (deps.checkInstance ?? checkEngine)(instance));
        }
        if (action === "refresh-models") {
          if (!(await registry.refreshModels(instanceId))) return json(res, 404, { error: "unknown instance" });
          return json(res, 200, { instances: await describeInstances() });
        }
        if (action === "install") {
          const installed = await registry.installRuntime(instanceId);
          if (!installed) return json(res, 404, { error: "Installing this engine from Settings is not available on this server. Use the install command on the machine running MausClaw." });
          const usingAppCopy = installed !== true && await useAppCopy(instanceId, installed.useCli);
          return json(res, 200, { instances: await describeInstances(), ...(usingAppCopy ? { usingAppCopy: true } : {}) });
        }
        if (action === "auth/start") {
          const instance = registry.get(instanceId);
          if (!instance) return json(res, 404, { error: "unknown instance" });
          if (instance.authenticationMethod === "browser-pkce" && (isProxied(req) || !isLoopbackHost(req.socket.remoteAddress))) {
            return json(res, 403, { error: "Continue on the computer running MausClaw." });
          }
          const started = await providerAuthSessions.start(instance, owner);
          if (started.phase === "succeeded") registry.forgetSnapshots();
          if (auth.kind === "session" && !sessions.isLive(auth.session.id)) {
            providerAuthSessions.revokeOwner(owner);
            return json(res, 401, { error: "Your session ended. Start a new sign-in." });
          }
          return json(res, 200, { auth: started });
        }
        if (action === "auth/sign-out") {
          const instance = registry.get(instanceId);
          if (!instance) return json(res, 404, { error: "unknown instance" });
          await providerAuthSessions.signOut(instance, owner);
          registry.forgetSnapshots();
          return json(res, 200, { instances: await describeInstances() });
        }
        if (action === "auth/complete") {
          const body = await readBody(req);
          const flowId = typeof body?.flowId === "string" ? body.flowId : "";
          const callbackUrl = typeof body?.callbackUrl === "string" ? body.callbackUrl : typeof body?.code === "string" ? body.code : "";
          if (!flowId || !callbackUrl) return json(res, 400, { error: "flowId and a code or callbackUrl are required" });
          await providerAuthSessions.complete(instanceId, owner, flowId, callbackUrl);
          registry.forgetSnapshots();
          return json(res, 200, { ok: true });
        }
        const body = await readBody(req, 4096);
        await providerAuthSessions.cancel(instanceId, owner, typeof body?.flowId === "string" ? body.flowId : "");
        return json(res, 200, { ok: true });
      } catch (error) {
        const requestedStatus = error && typeof error === "object" ? (error as { status?: unknown }).status : undefined;
        const status = typeof requestedStatus === "number" && [400, 401, 404, 409, 413, 415].includes(requestedStatus) ? requestedStatus : 500;
        return json(res, status, { error: error instanceof Error ? error.message : String(error) });
      }
    }

    // ?name=claude → every `claude` on the augmented PATH, in PATH order (first = what a bare name runs).
    if (method === "GET" && path === "/api/cli-candidates") {
      const name = url.searchParams.get("name") ?? "";
      resetPathCache();
      return json(res, 200, { candidates: findCliCandidates(name) });
    }

    // POST {cli, driver} → spawn `<cli> --version` with the PATH a turn would use.
    if (method === "POST" && path === "/api/cli-test") {
      if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      const body = await readBody(req);
      const cli = typeof body?.cli === "string" ? body.cli.trim() : "";
      if (!cli || /[\n\r]/.test(cli)) return json(res, 400, { error: "cli must be a non-empty path" });
      const driver = typeof body?.driver === "string" ? BUILT_IN_DRIVERS.find((d) => d.driverKind === body.driver) : undefined;
      const probe = await testCliBinary(cli, driver);
      return json(res, 200, probe);
    }

    // PATCH /api/instances/:id {cli: "/path/to/cli" | ""}: "" reverts to the driver default.
    const instancePatch = /^\/api\/instances\/([\w.-]+)$/.exec(path);
    if (method === "PATCH" && instancePatch) {
      if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      const parsed = instanceSettingsSchema.safeParse(await readBody(req, 16384));
      if (!parsed.success) return json(res, 400, { error: "Supply a valid CLI path, account name, configuration directory, boolean tools setting or a reply wait of 1 to 60 minutes." });
      const body = parsed.data;
      const instanceId = instancePatch[1];
      if (providerConfigBusy.get()) return json(res, 409, { error: "provider settings are already being updated" });
      if (busyProviderSelections().some((selection) => selection.instanceId === instanceId)) {
        return json(res, 409, { error: "Wait for bots using this account to finish before changing its settings." });
      }
      providerConfigBusy.set(true);
      providerInstancesChanging.add(instanceId);
      try {
        const result = body.cli === undefined ? { ok: true, config: cfg } : withInstanceCli(cfg, instanceId, body.cli);
        const instances = persistableInstanceConfigs(result.config);
        if (!result.ok || !Object.hasOwn(instances, instanceId)) return json(res, 404, { error: `unknown instance "${instanceId}"` });
        const entry = instances[instanceId];
        if (body.tools !== undefined) {
          if (!["openai-compat", "grok", "minimax", "mistral", "cerebras", "groq", "meta"].includes(entry.driver)) {
            return json(res, 400, { error: "The tools setting is available for OpenAI-compatible, Grok API, MiniMax API, Mistral API, Cerebras API, Groq API and Meta API instances only." });
          }
          entry.config = { ...entry.config as Record<string, unknown>, tools: body.tools };
        }
        if (body.replyWaitMinutes !== undefined) {
          if (entry.driver !== "openai-compat") return json(res, 400, { error: "The reply wait is available for OpenAI-compatible servers only." });
          const { replyWaitMinutes: _previous, ...rest } = entry.config as Record<string, unknown>;
          entry.config = body.replyWaitMinutes === null ? rest : { ...rest, replyWaitMinutes: body.replyWaitMinutes };
        }
        if (body.displayName !== undefined) entry.displayName = body.displayName;
        await persistProviderInstance(instanceId, instances);
        return json(res, 200, { instances: await describeInstances() });
      } finally {
        providerInstancesChanging.delete(instanceId);
        providerConfigBusy.set(false);
      }
    }

    if (method === "DELETE" && instancePatch) {
      const instanceId = instancePatch[1];
      if (providerConfigBusy.get()) return json(res, 409, { error: "provider settings are already being updated" });
      const instances = persistableInstanceConfigs(cfg);
      if (!Object.hasOwn(instances, instanceId)) return json(res, 404, { error: "unknown instance" });
      if (!isAddedEndpoint(instanceId, instances[instanceId])) {
        return json(res, 400, { error: "Only OpenAI-compatible endpoints can be removed here." });
      }
      if (cfg.defaultModelSelection?.instanceId === instanceId || store.bots.some((bot) =>
        bot.modelSelection.instanceId === instanceId || bot.fallback?.some(candidate => candidate.instanceId === instanceId) || store.tasks(bot.id).some((task) => task.modelSelection?.instanceId === instanceId)) ||
        busyProviderSelections().some((selection) => selection.instanceId === instanceId)) {
        return json(res, 409, { error: "Choose another account for the bots and default model using this account before removing it." });
      }
      providerConfigBusy.set(true);
      providerInstancesChanging.add(instanceId);
      try {
        delete instances[instanceId];
        await persistProviderInstance(instanceId, instances);
        return json(res, 200, { instances: await describeInstances() });
      } finally {
        providerInstancesChanging.delete(instanceId);
        providerConfigBusy.set(false);
      }
    }
    return PASS;
  };
}
