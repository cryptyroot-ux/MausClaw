import type {
  AgentRunStore,
  AgentToolOutputRecord,
  CapabilityCall,
  CapabilityDescriptor,
  CapabilityGrant,
  CapabilityProvider,
  CapabilityResult,
  CapabilityId,
  CapabilitySession,
  RunId,
} from "./contracts.ts";

export const TOOL_OUTPUT_READ_CAPABILITY = "tool_output_read";
export const TOOL_OUTPUT_READ_MAX_CHARS = 20_000;

const toolOutputReadDescriptor: CapabilityDescriptor = {
  id: TOOL_OUTPUT_READ_CAPABILITY,
  name: TOOL_OUTPUT_READ_CAPABILITY,
  description: "Read part of a tool output that was truncated to fit the model window. Use the callId from the output's outputRef.",
  schema: {
    type: "object",
    properties: {
      callId: { type: "string" },
      offset: { type: "integer", minimum: 0 },
      limit: { type: "integer", minimum: 1, maximum: TOOL_OUTPUT_READ_MAX_CHARS },
    },
    required: ["callId"],
    additionalProperties: false,
  },
  risk: "read",
  sideEffect: false,
  timeoutMs: 5_000,
};

export interface RunScopedCapabilitySession extends CapabilitySession {
  recordToolOutput(callId: string, content: string): boolean;
}

function capabilityPermitted(id: string, grant: CapabilityGrant): boolean {
  if (grant.denied.has(id)) return false;
  return grant.allowed.size === 0 || grant.allowed.has(id);
}

function capabilityGrantFailure(id: string, grant: CapabilityGrant): string | undefined {
  if (grant.denied.has(id)) return `Capability denied: ${id}`;
  if (grant.allowed.size > 0 && !grant.allowed.has(id)) return `Capability not allowed: ${id}`;
  return undefined;
}

function parseToolOutputReadArguments(value: unknown): { readonly callId: string; readonly offset: number; readonly limit: number } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("tool_output_read arguments must be an object");
  const args = value as { callId?: unknown; offset?: unknown; limit?: unknown };
  if (typeof args.callId !== "string" || !args.callId.trim()) throw new Error("tool_output_read needs the callId whose output was truncated");
  if (args.offset !== undefined && (typeof args.offset !== "number" || !Number.isSafeInteger(args.offset) || args.offset < 0)) {
    throw new Error("tool_output_read offset must be a non-negative integer");
  }
  if (args.limit !== undefined && (typeof args.limit !== "number" || !Number.isSafeInteger(args.limit) || args.limit < 1)) {
    throw new Error("tool_output_read limit must be a positive integer");
  }
  return {
    callId: args.callId,
    offset: args.offset as number | undefined ?? 0,
    limit: Math.min(args.limit as number | undefined ?? TOOL_OUTPUT_READ_MAX_CHARS, TOOL_OUTPUT_READ_MAX_CHARS),
  };
}

/** Adds run-owned output retrieval to the same grant/validate/invoke/close session as other capabilities. */
export function createRunScopedCapabilitySession(
  session: CapabilitySession,
  options: { readonly runId: RunId; readonly store: Pick<AgentRunStore, "recordToolOutput" | "readToolOutput"> },
): RunScopedCapabilitySession {
  const availableOutputs = new Set<string>();
  let closed = false;
  const assertOpen = (): void => {
    if (closed) throw new Error("Capability session is closed");
  };
  const validateOutputRead = (call: CapabilityCall, grant: CapabilityGrant) => {
    assertOpen();
    const failure = capabilityGrantFailure(TOOL_OUTPUT_READ_CAPABILITY, grant);
    if (failure) throw new Error(failure);
    if (call.runId !== options.runId) throw new Error("Tool output belongs to another run");
    const args = parseToolOutputReadArguments(call.arguments);
    if (!availableOutputs.has(args.callId)) throw new Error(`No stored output exists for call ${args.callId}`);
    if (!options.store.readToolOutput?.(options.runId, args.callId)) throw new Error(`Stored output for call ${args.callId} was not found`);
    return args;
  };

  return {
    list(grant): ReadonlyArray<CapabilityDescriptor> {
      if (closed) return [];
      const available = session.list(grant);
      if (!availableOutputs.size || !capabilityPermitted(TOOL_OUTPUT_READ_CAPABILITY, grant)
        || available.some((item) => item.id === TOOL_OUTPUT_READ_CAPABILITY)) return available;
      return [...available, toolOutputReadDescriptor];
    },

    validate(call, grant): void {
      if (call.capabilityId === TOOL_OUTPUT_READ_CAPABILITY) {
        validateOutputRead(call, grant);
        return;
      }
      assertOpen();
      session.validate(call, grant);
    },

    async invoke(call, context): Promise<CapabilityResult> {
      if (call.capabilityId !== TOOL_OUTPUT_READ_CAPABILITY) {
        if (closed) return { callId: call.callId, ok: false, content: "Capability session is closed", error: "closed" };
        return session.invoke(call, context);
      }
      const denied = capabilityGrantFailure(TOOL_OUTPUT_READ_CAPABILITY, context.grant);
      if (closed || denied) {
        return { callId: call.callId, ok: false, content: denied ?? "Capability session is closed", error: denied ? "denied" : "closed" };
      }
      try {
        const args = validateOutputRead(call, context.grant);
        context.signal.throwIfAborted();
        const record = options.store.readToolOutput?.(options.runId, args.callId);
        if (!record) return { callId: call.callId, ok: false, content: `Stored output for call ${args.callId} was not found`, error: "not_found" };
        const content = record.content.slice(args.offset, args.offset + args.limit);
        const nextOffset = args.offset + content.length < record.content.length ? args.offset + content.length : null;
        return {
          callId: call.callId,
          ok: true,
          content: JSON.stringify({ callId: args.callId, offset: args.offset, limit: args.limit, totalChars: record.content.length, content, nextOffset }),
        };
      } catch (error) {
        return {
          callId: call.callId,
          ok: false,
          content: error instanceof Error ? error.message : String(error),
          error: context.signal.aborted ? "interrupted" : "invalid_arguments",
        };
      }
    },

    recordToolOutput(callId, content): boolean {
      if (closed || !options.store.recordToolOutput || !options.store.readToolOutput) return false;
      const record: AgentToolOutputRecord = {
        runId: options.runId,
        callId,
        content,
        bytes: Buffer.byteLength(content),
        createdAt: Date.now(),
      };
      options.store.recordToolOutput(record);
      availableOutputs.add(callId);
      return true;
    },

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      availableOutputs.clear();
      await session.close();
    },
  };
}

export interface CapabilityHandler {
  (call: CapabilityCall, context: { grant: CapabilityGrant; signal: AbortSignal }): Promise<CapabilityResult>;
}

/**
 * In-process capability session used by fixtures and tests. It enforces the
 * same grant and lifecycle rules as production sessions without owning a
 * transport.
 */
export class InMemoryCapabilitySession implements CapabilitySession {
  private descriptors = new Map<string, CapabilityDescriptor>();
  private handlers = new Map<string, CapabilityHandler>();
  private closed = false;

  register(descriptor: CapabilityDescriptor, handler: CapabilityHandler): void {
    if (this.closed) throw new Error("Capability session is closed");
    this.descriptors.set(descriptor.id, descriptor);
    this.handlers.set(descriptor.id, handler);
  }

  list(grant: CapabilityGrant): ReadonlyArray<CapabilityDescriptor> {
    if (this.closed) return [];
    return Array.from(this.descriptors.values()).filter((descriptor) => this.permitted(descriptor.id, grant));
  }

  validate(call: CapabilityCall, grant: CapabilityGrant): void {
    this.assertOpen();
    const descriptor = this.descriptors.get(call.capabilityId);
    if (!descriptor) throw new Error(`Unknown capability: ${call.capabilityId}`);
    if (grant.denied.has(call.capabilityId)) throw new Error(`Capability denied: ${call.capabilityId}`);
    if (grant.allowed.size > 0 && !grant.allowed.has(call.capabilityId)) {
      throw new Error(`Capability not allowed: ${call.capabilityId}`);
    }
  }

  async invoke(
    call: CapabilityCall,
    context: { grant: CapabilityGrant; signal: AbortSignal },
  ): Promise<CapabilityResult> {
    if (this.closed) {
      return { callId: call.callId, ok: false, content: "Capability session is closed", error: "closed" };
    }
    const handler = this.handlers.get(call.capabilityId);
    if (!handler) {
      return { callId: call.callId, ok: false, content: `Unknown capability: ${call.capabilityId}`, error: "unknown_capability" };
    }
    if (context.grant.denied.has(call.capabilityId)) {
      return { callId: call.callId, ok: false, content: `Capability denied: ${call.capabilityId}`, error: "denied" };
    }
    if (context.grant.allowed.size > 0 && !context.grant.allowed.has(call.capabilityId)) {
      return { callId: call.callId, ok: false, content: `Capability not allowed: ${call.capabilityId}`, error: "not_allowed" };
    }
    try {
      return await handler(call, context);
    } catch (error) {
      return {
        callId: call.callId,
        ok: false,
        content: error instanceof Error ? error.message : String(error),
        error: "execution_error",
      };
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.handlers.clear();
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Capability session is closed");
  }

  private permitted(id: string, grant: CapabilityGrant): boolean {
    return capabilityPermitted(id, grant);
  }
}

import { readFileSync } from "node:fs";
import { enabledSkillFile, resolveBotSkills } from "../skills.ts";
import { allowsTool } from "../../shared/tool-scope.ts";

/** Adapts an existing CapabilitySession to a CapabilityProvider so legacy bridges (MCP, etc.)
 *  participate in the unified lifecycle without a rewrite. */
export class SessionCapabilityProvider implements CapabilityProvider {
  readonly id: CapabilityId;
  readonly kind: CapabilityProvider["kind"];
  private readonly session: CapabilitySession;
  private readonly label: string;
  private closed = false;

  constructor(id: string, kind: CapabilityProvider["kind"], session: CapabilitySession, label: string) {
    this.id = id as CapabilityId;
    this.kind = kind;
    this.session = session;
    this.label = label;
  }

  list(grant: CapabilityGrant): ReadonlyArray<CapabilityDescriptor> {
    if (this.closed) return [];
    return this.session.list(grant);
  }

  validate(call: CapabilityCall, grant: CapabilityGrant): void {
    if (this.closed) throw new Error("Capability runtime is closed");
    this.session.validate(call, grant);
  }

  async mount(): Promise<void> { /* session already mounted by caller */ }

  async invoke(call: CapabilityCall, context: { readonly grant: CapabilityGrant; readonly signal: AbortSignal }): Promise<CapabilityResult> {
    if (this.closed) return { callId: call.callId, ok: false, content: "closed", error: "closed" };
    return this.session.invoke(call, context);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.session.close().catch(() => {});
  }

  describe(): string { return this.label; }
}

/** Composite capability runtime: aggregates multiple CapabilityProviders behind one
 *  CapabilitySession so a turn uses one mount/invoke/close path and one policy. */
export type CapabilityPolicy = (call: CapabilityCall, grant: CapabilityGrant) => { readonly allowed: boolean; readonly reason?: string };

export class CompositeCapabilityRuntime implements CapabilitySession {
  private readonly providers: CapabilityProvider[];
  private readonly policy: CapabilityPolicy;
  private mounted = false;
  private closed = false;

  constructor(providers: CapabilityProvider[], policy?: CapabilityPolicy) {
    this.providers = providers;
    this.policy = policy ?? ((call, grant) => {
      if (grant.denied.has(call.capabilityId)) return { allowed: false, reason: `Capability denied: ${call.capabilityId}` };
      if (grant.allowed.size > 0 && !grant.allowed.has(call.capabilityId)) return { allowed: false, reason: `Capability not allowed: ${call.capabilityId}` };
      return { allowed: true };
    });
  }

  async mountAll(context: { readonly grant: CapabilityGrant; readonly signal: AbortSignal }): Promise<void> {
    if (this.closed) throw new Error("Capability runtime is closed");
    if (this.mounted) return;
    for (const provider of this.providers) await provider.mount(context);
    this.mounted = true;
  }

  list(grant: CapabilityGrant): ReadonlyArray<CapabilityDescriptor> {
    if (this.closed) return [];
    const out: CapabilityDescriptor[] = [];
    for (const provider of this.providers) out.push(...provider.list(grant));
    return out;
  }

  validate(call: CapabilityCall, grant: CapabilityGrant): void {
    if (this.closed) throw new Error("Capability runtime is closed");
    const provider = this.providers.find((p) => p.list(grant).some((d) => d.id === call.capabilityId));
    if (!provider) throw new Error(`Capability not found: ${call.capabilityId}`);
    const decision = this.policy(call, grant);
    if (!decision.allowed) throw new Error(decision.reason ?? `Capability denied: ${call.capabilityId}`);
    provider.validate(call, grant);
  }

  async invoke(call: CapabilityCall, context: { readonly grant: CapabilityGrant; readonly signal: AbortSignal }): Promise<CapabilityResult> {
    if (this.closed) return { callId: call.callId, ok: false, content: "Capability runtime is closed", error: "closed" };
    // Every provider that offers this capability is a fallback candidate: if the
    // first one fails (crash or execution error), try the next before giving up.
    // Policy is global — if it denies, no provider can help — so it is checked once.
    const candidates = this.providers.filter((p) => p.list(context.grant).some((d) => d.id === call.capabilityId));
    if (candidates.length === 0) return { callId: call.callId, ok: false, content: `Capability not found: ${call.capabilityId}`, error: "not_found" };
    const decision = this.policy(call, context.grant);
    if (!decision.allowed) {
      return { callId: call.callId, ok: false, content: decision.reason ?? "denied", error: "denied" };
    }
    let lastResult: CapabilityResult | undefined;
    for (const provider of candidates) {
      try {
        provider.validate(call, context.grant);
      } catch (error) {
        lastResult = { callId: call.callId, ok: false, content: error instanceof Error ? error.message : String(error), error: "denied" };
        continue;
      }
      try {
        context.signal.throwIfAborted();
        const result = await provider.invoke(call, context);
        if (result.ok) return result;
        // Non-ok result: cascade only on provider-level execution failures, not on
        // policy denials, interrupts, invalid arguments, or closed sessions — those
        // would not differ on another provider.
        lastResult = result;
        if (result.error === "denied" || result.error === "interrupted" || result.error === "invalid_arguments" || result.error === "closed") {
          return result;
        }
        continue;
      } catch (error) {
        if (context.signal.aborted) return { callId: call.callId, ok: false, content: "interrupted", error: "interrupted" };
        lastResult = { callId: call.callId, ok: false, content: error instanceof Error ? error.message : String(error), error: "failed" };
        continue;
      }
    }
    return lastResult ?? { callId: call.callId, ok: false, content: `Capability not found: ${call.capabilityId}`, error: "not_found" };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const provider of this.providers) await provider.close().catch(() => {});
  }
}

/** Skill capability provider: exposes enabled skills as capabilities. Invoke returns the
 *  skill's SKILL.md content so the model follows it (same as reading the file, but
 *  governed by the capability lifecycle and grant). */
export class SkillCapabilityProvider implements CapabilityProvider {
  readonly id: CapabilityId;
  readonly kind = "skill" as const;
  private readonly botId: string;
  private readonly assignedLibrary?: readonly string[];
  private readonly scope: unknown;
  private closed = false;

  constructor(botId: string, assignedLibrary?: readonly string[], scope?: unknown) {
    this.botId = botId;
    this.assignedLibrary = assignedLibrary;
    this.scope = scope;
    this.id = `skill:${botId}`;
  }

  private enabledSkills() {
    return resolveBotSkills(this.botId, this.assignedLibrary).filter((s) => s.enabled);
  }

  list(grant: CapabilityGrant): ReadonlyArray<CapabilityDescriptor> {
    if (this.closed) return [];
    return this.enabledSkills().flatMap((skill) => {
      const name = `skill_${skill.name}`.toLowerCase().replace(/[^a-z0-9_]+/g, "_");
      const id = `skill:${skill.name}`;
      if (!allowsTool(this.scope, { kind: "native", name })) return [];
      if (grant.denied.has(id) || grant.denied.has(name)) return [];
      if (grant.allowed.size > 0 && !grant.allowed.has(id) && !grant.allowed.has(name)) return [];
      return [{
        id,
        name,
        description: skill.description || `Skill ${skill.name}`,
        schema: { type: "object", properties: {}, additionalProperties: false },
        risk: "read" as const,
        sideEffect: false,
        timeoutMs: 5_000,
      }];
    });
  }

  validate(call: CapabilityCall, grant: CapabilityGrant): void {
    if (this.closed) throw new Error("Capability runtime is closed");
    const skill = this.enabledSkills().find((entry) => `skill:${entry.name}` === call.capabilityId);
    if (!skill) {
      throw new Error(`Unknown capability: ${call.capabilityId}`);
    }
    const name = `skill_${skill.name}`.toLowerCase().replace(/[^a-z0-9_]+/g, "_");
    if (!allowsTool(this.scope, { kind: "native", name })) throw new Error(`Capability not allowed: ${name}`);
    if (grant.denied.has(call.capabilityId) || grant.denied.has(name)) throw new Error(`Capability denied: ${name}`);
    if (grant.allowed.size > 0 && !grant.allowed.has(call.capabilityId) && !grant.allowed.has(name)) {
      throw new Error(`Capability not allowed: ${name}`);
    }
  }

  async mount(_ctx: { readonly grant: CapabilityGrant; readonly signal: AbortSignal }): Promise<void> { /* skills are files; nothing to mount */ }

  async invoke(call: CapabilityCall, context: { readonly grant: CapabilityGrant; readonly signal: AbortSignal }): Promise<CapabilityResult> {
    if (this.closed) return { callId: call.callId, ok: false, content: "closed", error: "closed" };
    const skillName = String(call.capabilityId).replace(/^skill:/, "");
    const file = enabledSkillFile(this.botId, skillName, this.assignedLibrary);
    if (!file) return { callId: call.callId, ok: false, content: `Skill not found: ${skillName}`, error: "not_found" };
    try {
      this.validate(call, context.grant);
      context.signal.throwIfAborted();
      const content = readFileSync(file, "utf8");
      return { callId: call.callId, ok: true, content: `Skill ${skillName} (read ${file}):\n\n${content}` };
    } catch (error) {
      return { callId: call.callId, ok: false, content: error instanceof Error ? error.message : String(error), error: context.signal.aborted ? "interrupted" : "denied" };
    }
  }

  async close(): Promise<void> { this.closed = true; }

  describe(): string { return `skill provider for bot ${this.botId}`; }
}
