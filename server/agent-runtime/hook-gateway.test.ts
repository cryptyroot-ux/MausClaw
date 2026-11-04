import { describe, expect, it } from "vitest";
import type { CapabilityDescriptor } from "./contracts.ts";
import { createHookGateway } from "./hook-gateway.ts";
import { createHookRegistry } from "./hooks.ts";

const shell = {
  id: "shell",
  name: "shell",
  description: "Run a shell command",
  schema: {
    type: "object",
    properties: { command: { type: "string" } },
    required: ["command"],
    additionalProperties: false,
  },
} as unknown as CapabilityDescriptor;

const context = {
  runId: "run-1",
  threadId: "thread-1",
  botId: "bot-1",
  capabilityId: "shell",
  callId: "call-1",
  arguments: { command: "ls" },
};

describe("createHookGateway", () => {
  it("returns a hook's valid modified arguments", async () => {
    const registry = createHookRegistry();
    registry.register("pre_tool_use", () => ({ allow: true, modifiedArguments: { command: "pwd" } }));
    const gateway = createHookGateway(registry, () => shell);

    const result = await gateway.run("pre_tool_use", context);

    expect(result.allow).toBe(true);
    expect(result.modifiedArguments).toEqual({ command: "pwd" });
  });

  it("discards modified arguments that violate the tool schema and keeps the originals", async () => {
    const registry = createHookRegistry();
    registry.register("pre_tool_use", () => ({ allow: true, modifiedArguments: { command: 42, extra: true } }));
    const gateway = createHookGateway(registry, () => shell);

    const result = await gateway.run("pre_tool_use", context);

    expect(result.allow).toBe(true);
    expect(result.modifiedArguments).toEqual({ command: "ls" });
    expect(result.messages.join(" ")).toMatch(/Hook argument validation rejected/);
    expect(result.messages.join(" ")).toMatch(/command.*must be a string|unknown argument/);
  });

  it("discards a missing required argument", async () => {
    const registry = createHookRegistry();
    registry.register("pre_tool_use", () => ({ allow: true, modifiedArguments: {} }));
    const gateway = createHookGateway(registry, () => shell);

    const result = await gateway.run("pre_tool_use", context);

    expect(result.modifiedArguments).toEqual({ command: "ls" });
    expect(result.messages.join(" ")).toMatch(/missing required argument: command/);
  });

  it("leaves arguments alone when no capability is named", async () => {
    const registry = createHookRegistry();
    registry.register("stop", () => ({ allow: true, modifiedArguments: { anything: true } }));
    const gateway = createHookGateway(registry, () => shell);

    const result = await gateway.run("stop", { runId: "run-1", threadId: "thread-1", botId: "bot-1" });

    expect(result.modifiedArguments).toEqual({ anything: true });
    expect(result.messages).toEqual([]);
  });
});
