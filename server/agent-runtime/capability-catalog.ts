// Capability Catalog and Tool Surface for deferred tool discovery.
// Provides a searchable index of all available capabilities and manages
// the subset of capabilities exposed to the model in each turn.

import type {
  CapabilityCall,
  CapabilityDescriptor,
  CapabilityGrant,
  CapabilityProvider,
  CapabilityResult,
} from "./contracts.ts";

/** Entry in the capability catalog index. */
interface CatalogEntry {
  readonly descriptor: CapabilityDescriptor;
  readonly provider: CapabilityProvider;
  mounted: boolean;
  mountPromise?: Promise<void>;
}

/** Result slot keyed by callId for ordered result collection. */
interface ResultSlot {
  callId: string;
  descriptor: CapabilityDescriptor;
  result: CapabilityResult;
}

/**
 * CapabilityCatalog: holds all registered providers and supports search,
 * direct lookup, and on-demand MCP mounting.
 */
export class CapabilityCatalog {
  private entries = new Map<string, CatalogEntry>();
  private providers: CapabilityProvider[];
  private grant: CapabilityGrant;
  private closed = false;

  constructor(providers: CapabilityProvider[], grant: CapabilityGrant) {
    this.providers = providers;
    this.grant = grant;
    this.buildIndex();
  }

  /** Rebuild the catalog index from current providers. */
  private buildIndex(): void {
    this.entries.clear();
    for (const provider of this.providers) {
      for (const descriptor of provider.list(this.grant)) {
        const id = descriptor.id;
        if (this.entries.has(id)) {
          throw new Error(`Duplicate capability ID in catalog: ${id}`);
        }
        this.entries.set(id, {
          descriptor,
          provider,
          mounted: false,
        });
      }
    }
  }

  /** Get a capability by ID. Returns undefined if not found. */
  get(id: string): CapabilityDescriptor | undefined {
    return this.entries.get(id)?.descriptor;
  }

  /** Get the provider for a capability ID. */
  getProvider(id: string): CapabilityProvider | undefined {
    return this.entries.get(id)?.provider;
  }

  /** Search capabilities by keyword (matches name or description). */
  search(query: string, limit: number = 20): ReadonlyArray<CapabilityDescriptor> {
    if (this.closed) return [];
    const q = query.toLowerCase().trim();
    if (!q) return [];
    const results: CapabilityDescriptor[] = [];
    for (const entry of this.entries.values()) {
      const d = entry.descriptor;
      if (
        d.name.toLowerCase().includes(q) ||
        d.description.toLowerCase().includes(q)
      ) {
        results.push(d);
        if (results.length >= limit) break;
      }
    }
    return results;
  }

  /** List all capabilities for the initial tool surface. */
  listInitial(): ReadonlyArray<CapabilityDescriptor> {
    if (this.closed) return [];
    const out: CapabilityDescriptor[] = [];
    for (const entry of this.entries.values()) {
      const d = entry.descriptor;
      // Initial surface: native tools, tool_search, tool_output_read, ask_user
      // MCP tools are NOT included initially (mounted on-demand)
      if (
        d.id.startsWith("native:") ||
        d.id === "native:tool-search" ||
        d.id === "tool_output_read" ||
        d.id === "ask_user"
      ) {
        out.push(d);
      }
    }
    return out;
  }

  /** Mount the provider for a capability (on-demand for MCP). */
  async mount(id: string, context: { readonly grant: CapabilityGrant; readonly signal: AbortSignal }): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`Capability not found: ${id}`);
    if (entry.mounted) return;
    if (entry.mountPromise) return entry.mountPromise;
    entry.mountPromise = entry.provider.mount(context).then(() => {
      entry.mounted = true;
    });
    return entry.mountPromise;
  }

  /** Update the grant and rebuild index (e.g., when approval changes). */
  updateGrant(grant: CapabilityGrant): void {
    this.grant = grant;
    this.buildIndex();
  }

  close(): void {
    this.closed = true;
    this.entries.clear();
  }
}

/**
 * ToolSurface: the subset of capabilities actually sent to the model in a turn.
 * Manages the initial surface + on-demand additions from tool_search.
 */
export class ToolSurface {
  private catalog: CapabilityCatalog;
  private surface = new Map<string, CapabilityDescriptor>();
  private initialBuilt = false;

  constructor(catalog: CapabilityCatalog) {
    this.catalog = catalog;
  }

  /** Get the current surface as an array for the model. */
  getDescriptors(): ReadonlyArray<CapabilityDescriptor> {
    if (!this.initialBuilt) {
      this.buildInitial();
    }
    return Array.from(this.surface.values());
  }

  /** Build the initial surface (native tools, tool_search, tool_output_read, ask_user). */
  private buildInitial(): void {
    this.initialBuilt = true;
    for (const descriptor of this.catalog.listInitial()) {
      this.surface.set(descriptor.id, descriptor);
    }
  }

  /** Search the catalog and optionally add matches to the surface. */
  async search(query: string, limit: number = 20, addToSurface: boolean = false): Promise<ReadonlyArray<CapabilityDescriptor>> {
    const results = this.catalog.search(query, limit);
    if (addToSurface) {
      for (const descriptor of results) {
        if (!this.surface.has(descriptor.id)) {
          this.surface.set(descriptor.id, descriptor);
        }
      }
    }
    return results;
  }

  /** Add a specific capability to the surface by ID (after tool_search discovery). */
  async add(capabilityId: string): Promise<CapabilityDescriptor | undefined> {
    const descriptor = this.catalog.get(capabilityId);
    if (descriptor && !this.surface.has(capabilityId)) {
      this.surface.set(capabilityId, descriptor);
      return descriptor;
    }
    return descriptor;
  }

  /** Add a capability to the surface directly (bypassing catalog lookup). */
  addDescriptor(descriptor: CapabilityDescriptor): void {
    this.surface.set(descriptor.id, descriptor);
  }

  /** Check if a capability is in the current surface. */
  has(capabilityId: string): boolean {
    return this.surface.has(capabilityId);
  }

  /** Get a capability from the surface. */
  get(capabilityId: string): CapabilityDescriptor | undefined {
    return this.surface.get(capabilityId);
  }

  /** Reset the surface (for new turn). */
  reset(): void {
    this.initialBuilt = false;
    this.surface.clear();
  }
}

/**
 * Safe scheduling state for a turn.
 */
export interface SchedulingState {
  readonly catalog: CapabilityCatalog;
  readonly surface: ToolSurface;
  readonly readCache: Map<string, CapabilityResult>;
  readonly effectTracker: Set<string>;
  readonly concurrencyGates: Map<string, Promise<void>>;
}

/** Key for the read cache: capabilityId + JSON args. */
function readCacheKey(call: CapabilityCall): string {
  return `${call.capabilityId}:${JSON.stringify(call.arguments)}`;
}

/** Key for the effect tracker: capabilityId + JSON args (for mutating tools). */
function effectKey(call: CapabilityCall): string {
  return `${call.capabilityId}:${JSON.stringify(call.arguments)}`;
}

/**
 * Execute a batch of capability calls with safe scheduling:
 * - parallelSafe read-only tools run concurrently (bounded)
 * - Tools sharing concurrencyKey serialize
 * - Repeated read calls reuse cached results
 * - Repeated mutating calls with same args are rejected
 *
 * Returns results in the same order as the input batch.
 */
export async function executeWithScheduling(
  state: SchedulingState,
  batch: ReadonlyArray<{ call: CapabilityCall; descriptor: CapabilityDescriptor }>,
  invokeFn: (call: CapabilityCall, context: { grant: CapabilityGrant; signal: AbortSignal }) => Promise<CapabilityResult>,
  context: { grant: CapabilityGrant; signal: AbortSignal }
): Promise<ReadonlyArray<ResultSlot>> {
  const { readCache, effectTracker, concurrencyGates } = state;

  // Result slots, pre-filled with a flag so we can return in batch order.
  const slots: Array<ResultSlot | null> = batch.map(() => null);

  // First pass: check cache/dedup, collect items that still need execution.
  const toExecute: Array<{ index: number; call: CapabilityCall; descriptor: CapabilityDescriptor }> = [];
  for (let i = 0; i < batch.length; i++) {
    const { call, descriptor } = batch[i];
    const isReadOnly = descriptor.risk === "read" && descriptor.sideEffect === false;

    if (isReadOnly) {
      const cacheKey = readCacheKey(call);
      const cached = readCache.get(cacheKey);
      if (cached) {
        slots[i] = { callId: call.callId, descriptor, result: cached };
        continue;
      }
    } else {
      // Mutating tool: check for duplicate effect
      const ekey = effectKey(call);
      if (effectTracker.has(ekey)) {
        const denied: CapabilityResult = {
          callId: call.callId,
          ok: false,
          content: `Duplicate effect: ${call.capabilityId} with identical arguments was already executed in this turn.`,
          error: "duplicate_effect",
        };
        slots[i] = { callId: call.callId, descriptor, result: denied };
        continue;
      }
      effectTracker.add(ekey);
    }
    toExecute.push({ index: i, call, descriptor });
  }

  // Group by concurrencyKey for serialization.
  const keyGroups = new Map<string, Array<{ index: number; call: CapabilityCall; descriptor: CapabilityDescriptor }>>();
  const noKeyItems: Array<{ index: number; call: CapabilityCall; descriptor: CapabilityDescriptor }> = [];

  for (const item of toExecute) {
    const key = item.descriptor.concurrencyKey;
    if (key) {
      const group = keyGroups.get(key) ?? [];
      group.push(item);
      keyGroups.set(key, group);
    } else {
      noKeyItems.push(item);
    }
  }

  // Execute groups sequentially (each group serializes by its key).
  for (const [, group] of keyGroups) {
    const previousGate = concurrencyGates.get(group[0].descriptor.concurrencyKey!);
    if (previousGate) {
      await previousGate;
    }

    const gate = executeGroupItems(group, invokeFn, context, slots, readCache);
    concurrencyGates.set(group[0].descriptor.concurrencyKey!, gate);
    await gate;
  }

  // Execute items without concurrencyKey.
  if (noKeyItems.length > 0) {
    await executeGroupItems(noKeyItems, invokeFn, context, slots, readCache);
  }

  // Collect results in original batch order.
  const results: ResultSlot[] = [];
  for (let i = 0; i < batch.length; i++) {
    if (slots[i]) results.push(slots[i]!);
  }
  return results;
}

/** Execute a group of items: parallelSafe items concurrent, others sequential. */
async function executeGroupItems(
  group: ReadonlyArray<{ index: number; call: CapabilityCall; descriptor: CapabilityDescriptor }>,
  invokeFn: (call: CapabilityCall, context: { grant: CapabilityGrant; signal: AbortSignal }) => Promise<CapabilityResult>,
  context: { grant: CapabilityGrant; signal: AbortSignal },
  slots: Array<ResultSlot | null>,
  readCache: Map<string, CapabilityResult>
): Promise<void> {
  const parallelSafeItems = group.filter(({ descriptor }) => descriptor.parallelSafe === true);
  const sequentialItems = group.filter(({ descriptor }) => descriptor.parallelSafe !== true);

  // Run parallelSafe items concurrently (bounded by a reasonable limit).
  const MAX_CONCURRENT_READS = 8;
  if (parallelSafeItems.length > 0) {
    const chunks: Array<Array<{ index: number; call: CapabilityCall; descriptor: CapabilityDescriptor }>> = [];
    for (let i = 0; i < parallelSafeItems.length; i += MAX_CONCURRENT_READS) {
      chunks.push(parallelSafeItems.slice(i, i + MAX_CONCURRENT_READS));
    }
    for (const chunk of chunks) {
      await Promise.all(
        chunk.map(async ({ index, call, descriptor }) => {
          context.signal.throwIfAborted();
          const result = await invokeFn(call, context);
          if (descriptor.risk === "read" && descriptor.sideEffect === false) {
            readCache.set(readCacheKey(call), result);
          }
          slots[index] = { callId: call.callId, descriptor, result };
        })
      );
    }
  }

  // Run sequential items one by one.
  for (const { index, call, descriptor } of sequentialItems) {
    context.signal.throwIfAborted();
    const result = await invokeFn(call, context);
    if (descriptor.risk === "read" && descriptor.sideEffect === false) {
      readCache.set(readCacheKey(call), result);
    }
    slots[index] = { callId: call.callId, descriptor, result };
  }
}
