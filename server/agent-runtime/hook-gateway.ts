// Hook gateway: final-argument revalidation for hook handlers.
//
// Hook handlers can observe, block, or modify arguments before tool dispatch.
// The gateway validates modified arguments against the tool descriptor's JSON
// schema before they are used, preventing hook-produced arguments from bypassing
// the type/safety contract of the underlying capability.

import type { CapabilityDescriptor } from "./contracts.ts";
import type { HookContext, HookEvent } from "./hooks.ts";

export interface HookRunResult {
  readonly allow: boolean;
  readonly messages: ReadonlyArray<string>;
  readonly modifiedArguments?: unknown;
}

/** The gateway only runs hooks; callers may supply just that half of a registry. */
export interface HookRunner {
  run(event: HookEvent, context: HookContext): Promise<HookRunResult>;
}

/** Minimal JSON Schema subset for validation. */
interface JSONSchema {
  readonly type?: "string" | "number" | "boolean" | "integer" | "array" | "object";
  readonly properties?: Record<string, JSONSchema>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
}

/** Validate an unknown value against a JSON Schema (subset: type, properties, required, additionalProperties). */
function validateAgainstSchema(value: unknown, schema: JSONSchema | undefined): { ok: boolean; error?: string } {
  if (!schema || schema.type !== "object") return { ok: true };
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "arguments must be a JSON object" };
  }
  const obj = value as Record<string, unknown>;
  const required = schema.required ?? [];
  for (const key of required) {
    if (!(key in obj)) return { ok: false, error: `missing required argument: ${key}` };
  }
  const properties = schema.properties ?? {};
  const additional = schema.additionalProperties ?? true;
  for (const [key, val] of Object.entries(obj)) {
    const propSchema = properties[key];
    if (propSchema === undefined) {
      if (additional === false) return { ok: false, error: `unknown argument: ${key}` };
      continue;
    }
    if (propSchema.type === "string" && typeof val !== "string") {
      return { ok: false, error: `argument "${key}" must be a string` };
    }
    if (propSchema.type === "number" && typeof val !== "number") {
      return { ok: false, error: `argument "${key}" must be a number` };
    }
    if (propSchema.type === "boolean" && typeof val !== "boolean") {
      return { ok: false, error: `argument "${key}" must be a boolean` };
    }
    if (propSchema.type === "integer" && !Number.isInteger(val)) {
      return { ok: false, error: `argument "${key}" must be an integer` };
    }
    if (propSchema.type === "array" && !Array.isArray(val)) {
      return { ok: false, error: `argument "${key}" must be an array` };
    }
    if (propSchema.type === "object" && (val === null || typeof val !== "object" || Array.isArray(val))) {
      return { ok: false, error: `argument "${key}" must be an object` };
    }
  }
  return { ok: true };
}

/**
 * Wraps a HookRegistry with final-argument revalidation.
 *
 * When hooks return `modifiedArguments`, those arguments are revalidated against
 * the target capability's JSON schema before being returned to the caller.
 * If validation fails, the modified arguments are discarded and the original
 * arguments are preserved.
 */
export function createHookGateway(
  registry: HookRunner,
  /** Look up a capability descriptor by capabilityId. */
  descriptorFor: (capabilityId: string) => CapabilityDescriptor | undefined,
): HookRunner {
  return {
    async run(event: HookEvent, context: HookContext): Promise<HookRunResult> {
      const originalArguments = context.arguments;
      const result = await registry.run(event, context);

      // Final-argument revalidation: if hooks modified arguments, validate against schema.
      if (result.modifiedArguments !== undefined && context.capabilityId) {
        const descriptor = descriptorFor(context.capabilityId);
        const schema = descriptor?.schema as JSONSchema | undefined;
        const validation = validateAgainstSchema(result.modifiedArguments, schema);
        if (!validation.ok) {
          // Discard modified arguments; keep originals. Report the violation.
          return {
            allow: result.allow,
            messages: [...result.messages, `Hook argument validation rejected: ${validation.error}; using original arguments.`],
            modifiedArguments: originalArguments,
          };
        }
      }

      return result;
    },
  };
}

export type { HookEvent, HookContext, HookResult, HookHandler } from "./hooks.ts";
