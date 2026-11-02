import type { ModelCatalog } from "../contracts.ts";
import type { AgentEngine, ModelAdapter, ModelCapabilities, ProviderModelRef } from "../agent-runtime/contracts.ts";
import { createAgentEngine } from "../agent-runtime/runtime.ts";
import { createOpenAICompatibleModelAdapter } from "../agent-runtime/model-adapter.ts";
import { probeCapabilities } from "../agent-runtime/capability-probe.ts";
import { probeLive } from "../agent-runtime/capability-probe.ts";
import { heuristicVerifier } from "../agent-runtime/verifier.ts";
import { createModelCaller } from "../agent-runtime/model-caller.ts";
import { Verifier } from "../intelligence/verifier.ts";
import { createIntelligenceLayer } from "../agent-runtime/intelligence-layer.ts";
import { isIntelligenceEnabled } from "../intelligence/feature-flag.ts";
import { BudgetGuard } from "../routing/budget-guard.ts";
import { defaultModelTiers } from "../agent-runtime/model-router.ts";
import { createPluginRegistry, validateManifest, loadPlugin } from "../agent-runtime/plugin-loader.ts";
import { createOrchestrator } from "../agent-runtime/orchestrator.ts";
import { createOrchestratorStore } from "../agent-runtime/orchestrator-store.ts";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createSqliteAgentRunStore } from "../agent-runtime/run-store.ts";
import { appendCompaction } from "./compaction-journal.ts";

/** Chat-completions drivers share one native engine shape: an OpenAI-compatible adapter over the same catalog the
 * driver shows in Settings, and the OMB-owned run journal. Provider quirks stay in the adapter options, never in the
 * loop. */
export interface NativeChatEngineOptions {
  readonly providerId: string;
  readonly apiUrl: string;
  readonly apiKey: string;
  readonly catalog: () => ModelCatalog;
  readonly reasoning?: boolean;
  readonly httpErrorLabel?: string;
  /** `config.tools === false` keeps tools unmounted; the model must not then be told it can call them. */
  readonly toolsEnabled?: boolean;
  readonly imageInput?: (modelId: string) => boolean;
  readonly audioInput?: (modelId: string) => boolean;
  /** Optional pre-built adapter (e.g. Anthropic Messages). When provided, the OpenAI-compatible adapter is not created. */
  readonly modelAdapter?: ModelAdapter;
  /** Optional directory for the compaction audit journal (NDJSON). When omitted no journal is written. */
  readonly dataDir?: string;
}

export async function createNativeChatEngine(options: NativeChatEngineOptions): Promise<AgentEngine> {
  const baseAdapter = options.modelAdapter ?? createOpenAICompatibleModelAdapter({
    providerId: options.providerId,
    apiUrl: options.apiUrl,
    apiKey: options.apiKey,
    catalog: options.catalog,
    reasoning: options.reasoning ?? false,
    httpErrorLabel: options.httpErrorLabel,
    capabilities: (modelId): ModelCapabilities => probeCapabilities(modelId, options.catalog, {
      toolsEnabled: options.toolsEnabled,
      imageInput: options.imageInput,
      audioInput: options.audioInput,
    }),
  });

  // Cache for fallback adapters per model
  const fallbackAdapterCache = new Map<string, ModelAdapter>();

  function getAdapterForModel(modelId: string): ModelAdapter {
    if (modelId === options.catalog().default) return baseAdapter;
    const cached = fallbackAdapterCache.get(modelId);
    if (cached) return cached;
    const adapter = createOpenAICompatibleModelAdapter({
      providerId: options.providerId,
      apiUrl: options.apiUrl,
      apiKey: options.apiKey,
      catalog: options.catalog,
      reasoning: options.reasoning ?? false,
      httpErrorLabel: options.httpErrorLabel,
      capabilities: (mId): ModelCapabilities => probeCapabilities(mId, options.catalog, {
        toolsEnabled: options.toolsEnabled,
        imageInput: options.imageInput,
        audioInput: options.audioInput,
      }),
    });
    fallbackAdapterCache.set(modelId, adapter);
    return adapter;
  }
  // Load plugins from plugins directory (if exists).
  const pluginRegistry = createPluginRegistry();
  const pluginsDir = join(process.cwd(), "plugins");
  if (existsSync(pluginsDir)) {
    for (const entry of readdirSync(pluginsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifestPath = join(pluginsDir, entry.name, "plugin.json");
      if (!existsSync(manifestPath)) continue;
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        if (validateManifest(manifest)) {
          const plugin = await loadPlugin(manifest, join(pluginsDir, entry.name));
          pluginRegistry.register(plugin);
        }
      } catch {
        // Skip invalid plugins.
      }
    }
  }

  // Model router config for task-based routing with fallbacks
  const modelRouterConfig = {
    rules: {
      coding: { primary: "gpt-4o", fallbacks: ["gpt-4o-mini", "claude-3-5-sonnet"] },
      research: { primary: "gpt-4o", fallbacks: ["gpt-4o-mini", "claude-3-5-sonnet"] },
      analysis: { primary: "gpt-4o", fallbacks: ["gpt-4o-mini", "claude-3-5-sonnet"] },
      writing: { primary: "gpt-4o", fallbacks: ["gpt-4o-mini", "claude-3-5-sonnet"] },
      debugging: { primary: "gpt-4o", fallbacks: ["gpt-4o-mini", "claude-3-5-sonnet"] },
      general: { primary: "gpt-4o", fallbacks: ["gpt-4o-mini", "claude-3-5-sonnet"] },
    },
    costTable: {
      "gpt-4o": { input: 0.005, output: 0.015 },
      "gpt-4o-mini": { input: 0.00015, output: 0.0006 },
      "claude-3-5-sonnet": { input: 0.003, output: 0.015 },
    },
  };

  const store = createSqliteAgentRunStore();
  if (options.dataDir) {
    const dataDir = options.dataDir;
    const original = store.recordCompaction;
    store.recordCompaction = (record) => {
      original?.(record);
      try {
        appendCompaction(dataDir, {
          id: `${record.runId}-${record.sequence}`,
          runId: record.runId,
          threadId: "",
          botId: undefined,
          round: record.sequence,
          reason: record.trigger === "auto" ? "budget" : "overflow",
          messagesBefore: 0,
          messagesAfter: 0,
          tokensBefore: record.tokenEstimate,
          tokensAfter: 0,
          tokensSaved: 0,
          summary: record.summary,
          timestamp: record.createdAt,
        });
      } catch {
        // Journal append failures must not break compaction recording.
      }
    };
  }

  const engine = createAgentEngine({
    adapters: { resolve: (ref: ProviderModelRef) => getAdapterForModel(ref.modelId) },
    store,
    cacheEnabled: true,
    plugins: pluginRegistry,
    intelligence: {
      enabled: isIntelligenceEnabled(undefined, process.env),
      decide: (input: any) => {
        const decision = createIntelligenceLayer({ enabled: isIntelligenceEnabled(undefined, process.env), tiers: defaultModelTiers({ providerId: options.providerId, modelId: options.catalog().default }) }).decide(input as any);
        // Wire our per-process BudgetGuard (global, per-run).
        try {
          const guard = new BudgetGuard({});
          const cost = (decision && decision.costEstimate && typeof decision.costEstimate.estimatedCostUsd === "number")
            ? decision.costEstimate.estimatedCostUsd
            : 0;
          const assignment = { primary: { estimatedCost: cost } };
          const allowed = guard.check(assignment, "");
          if (!allowed) {
            return { ...decision, allowed: false, reason: decision.reason || "budget exceeded (guard)" } as any;
          }
          guard.record(assignment, "");
        } catch {
          // never block on guard errors
        }
        // Enhance route with fallbacks from model router
        if (decision.route && decision.route.candidates && decision.route.candidates.length > 0) {
          const primary = decision.route.candidates[0];
          const taskType = input.hasCode ? "coding" : input.hasImages ? "analysis" : "general";
          const routingRule = modelRouterConfig.rules[taskType] ?? modelRouterConfig.rules.general;
          const fallbacks = routingRule.fallbacks.filter((m: string) => m !== primary.modelId);
          const newCandidates = [primary, ...fallbacks.map((m: string) => ({ providerId: options.providerId, modelId: m }))];
          return {
            ...decision,
            route: {
              ...decision.route,
              candidates: newCandidates,
            },
          } as any;
        }
        return decision;
      },
      verify: async (output: any, step?: any) => {
        try {
          const modelCaller = createModelCaller(baseAdapter, options.catalog().default);
          const v = new Verifier(modelCaller);
          const ps = {
            id: step?.id ?? "step",
            description: (step && typeof step.description === "string") ? step.description : (step && typeof step.text === "string") ? step.text : String(output ?? ""),
            type: "think",
            expectedTools: [],
            dependencies: [],
            successCriteria: (step && typeof step.successCriteria === "string") ? step.successCriteria : ((step && typeof step.text === "string") ? step.text : String(output ?? "")),
            result: output,
          } as any;
          const vr = await v.verify(ps, "");
          return { ok: vr.verified, feedback: vr.reworkSuggestions?.join("; ") || vr.evidence || "" };
        } catch {
          return heuristicVerifier(typeof output === "string" ? output : String(output));
        }
      },
    },
    ...(options.apiKey
      ? {
          probe: {
            run: async (adapter, modelId) => {
              const result = await probeLive(adapter, modelId);
              return result.error ? null : result;
            },
          },
        }
      : {}),
  });

  // Create orchestrator for multi-step task orchestration with swarm support.
  // The orchestrator wraps the engine and uses intelligence for plan/execute/verify.
  const orchestratorStore = createOrchestratorStore();
  const orchestrator = createOrchestrator({
    engine,
    store: orchestratorStore,
    intelligence: {
      enabled: isIntelligenceEnabled(undefined, process.env),
      decide: (input: any) => createIntelligenceLayer({ enabled: isIntelligenceEnabled(undefined, process.env), tiers: defaultModelTiers({ providerId: options.providerId, modelId: options.catalog().default }) }).decide(input as any),
      verify: async (output: any, step?: any) => {
        try {
          const modelCaller = createModelCaller(baseAdapter, options.catalog().default);
          const v = new Verifier(modelCaller);
          const ps = {
            id: step?.id ?? "step",
            description: (step && typeof step.description === "string") ? step.description : (step && typeof step.text === "string") ? step.text : String(output ?? ""),
            type: "think",
            expectedTools: [],
            dependencies: [],
            successCriteria: (step && typeof step.successCriteria === "string") ? step.successCriteria : ((step && typeof step.text === "string") ? step.text : String(output ?? "")),
            result: output,
          } as any;
          const vr = await v.verify(ps, "");
          return { ok: vr.verified, feedback: vr.reworkSuggestions?.join("; ") || vr.evidence || "" };
        } catch {
          return heuristicVerifier(typeof output === "string" ? output : String(output));
        }
      },
    },
    swarm: { enabled: true },
  });

  // Attach orchestrator to engine for external access.
  (engine as { orchestrator?: typeof orchestrator }).orchestrator = orchestrator;
  return engine;
}
