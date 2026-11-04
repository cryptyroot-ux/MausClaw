import { beforeEach, describe, expect, it, vi } from "vitest";

import { createOrchestrator } from "./orchestrator.ts";
import type {
  AgentEngine,
  AgentEvent,
  AgentRunHandle,
  AgentRunRecord,
  AgentRunStatus,
  CapabilityDescriptor,
  CapabilityGrant,
  CapabilitySession,
  Orchestrator,
  OrchestratorContext,
  OrchestratorStore,
  PlanStatus,
  PlanResult,
  PlanStep,
  StepRecord,
  StepStatus,
} from "./contracts.ts";

interface TestOrchestratorStore extends OrchestratorStore {
  readonly plans: Map<string, PlanRecordLike>;
  readonly steps: Map<string, StepRecord>;
}

interface PlanRecordLike {
  readonly planId: string;
  readonly status: PlanStatus;
  readonly steps: string[];
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly contextVariables: Map<string, string>;
}

function testOrchestratorStore(): TestOrchestratorStore {
  const plans = new Map<string, PlanRecordLike>();
  const steps = new Map<string, StepRecord>();
  return {
    plans,
    steps,
    createPlan(record) {
      plans.set(record.planId, {
        planId: record.planId,
        status: record.status,
        steps: record.steps.slice(),
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        contextVariables: new Map(record.contextVariables),
      });
    },
    getPlan(planId: string) {
      return plans.get(planId);
    },
    updatePlanStatus(planId: string, status: PlanStatus, updatedAt: number) {
      const current = plans.get(planId);
      if (!current) return false;
      plans.set(planId, { ...current, status, updatedAt });
      return true;
    },
    createStep(record: StepRecord) {
      steps.set(record.stepId, { ...record });
    },
    getStep(stepId: string) {
      return steps.get(stepId);
    },
    updateStepStatus(stepId: string, status: StepStatus, _updatedAt: number, result?: PlanResult) {
      const current = steps.get(stepId);
      if (!current) return false;
      steps.set(stepId, { ...current, status, ...(result === undefined ? {} : { result }) });
      return true;
    },
    listSteps(planId: string) {
      return [...steps.values()].filter((step) => step.planId === planId);
    },
    recoverUnsettledPlans() {},
  };
}

const grant: CapabilityGrant = {
  botId: "bot-1",
  threadId: "thread-1",
  approvalMode: "full",
  allowed: new Set(["read-a"]),
  denied: new Set(),
};

function descriptor(id: string): CapabilityDescriptor {
  return {
    id,
    name: id,
    description: `Fixture capability ${id}`,
    schema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
    risk: "read",
    sideEffect: false,
    timeoutMs: 5_000,
  };
}

interface TestCapabilitySession extends CapabilitySession {
  readonly invocations: string[];
}

function testCapabilitySession(): TestCapabilitySession {
  const invocations: string[] = [];
  return {
    invocations,
    list(): readonly CapabilityDescriptor[] {
      return [descriptor("read-a")];
    },
    validate() {},
    async invoke() {
      return { callId: "call-x", ok: true, content: "fixture result" };
    },
    async close() {},
  };
}

interface TestAgentEngine extends AgentEngine {
  readonly runs: Map<string, AgentRunRecord>;
  readonly requests: Array<{ botId: string; threadId: string; text: string }>;
}

function testAgentEngine(
  outcomes: ReadonlyArray<{ status: AgentRunStatus; failureCode?: string; modelRounds?: number; toolCalls?: number; output?: string }>,
): TestAgentEngine {
  const runs = new Map<string, AgentRunRecord>();
  const requests: Array<{ botId: string; threadId: string; text: string }> = [];
  return {
    engineId: "engine-1",
    runs,
    requests,
    async run(request) {
      const runId = `run-${requests.length}`;
      const outcome = outcomes[requests.length] ?? outcomes[outcomes.length - 1] ?? { status: "completed", output: "done" };
      requests.push({ botId: request.botId, threadId: request.threadId, text: request.text });
      runs.set(runId, {
        runId,
        botId: request.botId,
        threadId: request.threadId,
        engineId: "engine-1",
        providerModel: request.providerModel,
        status: outcome.status,
        startedAt: Date.now(),
        updatedAt: Date.now(),
        modelRounds: outcome.modelRounds ?? 1,
        toolCalls: outcome.toolCalls ?? 0,
        ...(outcome.failureCode ? { failureCode: outcome.failureCode } : {}),
      });
      const handle: AgentRunHandle = { runId, done: Promise.resolve() };
      return handle;
    },
    async interrupt() {},
    async steer() {
      return "refused";
    },
    getState(runId: string) {
      return runs.get(runId);
    },
    onEvent(_threadId: string, listener: (event: AgentEvent) => void) {
      const outcome = outcomes[requests.length - 1] ?? { output: "done" };
      if (outcome.output) {
        const event: AgentEvent = { type: "model.delta", runId: `run-${Math.max(0, requests.length - 1)}`, kind: "assistant_text", delta: outcome.output };
        listener(event);
      }
      return () => {};
    },
  };
}

function contextFor(_steps: PlanStep[]): OrchestratorContext {
  return {
    planId: "plan-1",
    contextVariables: new Map(),
    signal: new AbortController().signal,
    approvalMode: "full",
  };
}

describe("createOrchestrator", () => {
  let store: TestOrchestratorStore;
  let engine: TestAgentEngine;
  let orchestrator: Orchestrator;

  beforeEach(() => {
    store = testOrchestratorStore();
    engine = testAgentEngine([{ status: "completed", output: "step one output" }]);
    orchestrator = createOrchestrator({ engine, store });
  });

  it("runs a single step plan and records results", async () => {
    const steps: PlanStep[] = [
      { id: "s1", text: "Say hello.", providerModel: { providerId: "fixture", modelId: "fixture-model" }, grant, capabilities: testCapabilitySession() },
    ];

    const { planId, done } = orchestrator.runPlan(steps, contextFor(steps));
    await done;

    expect(planId).toBe("plan-1");
    const plan = store.plans.get(planId);
    expect(plan?.status).toBe("completed");
    const stepResults = store.listSteps(planId);
    expect(stepResults).toHaveLength(1);
    expect(stepResults[0]?.status).toBe("completed");
    expect(stepResults[0]?.result?.output).toBe("step one output");
    expect(engine.runs.size).toBe(1);
  });

  it("runs sequential steps carrying context between them", async () => {
    const steps: PlanStep[] = [
      { id: "s1", text: "First step.", providerModel: { providerId: "fixture", modelId: "fixture-model" }, grant, capabilities: testCapabilitySession() },
      { id: "s2", text: "Second step.", providerModel: { providerId: "fixture", modelId: "fixture-model" }, grant, capabilities: testCapabilitySession() },
    ];
    const engine = testAgentEngine([
      { status: "completed", output: "output one" },
      { status: "completed", output: "output two" },
    ]);
    const orch = createOrchestrator({ engine, store });
    const { done } = orch.runPlan(steps, contextFor(steps));
    await done;

    const stepResults = store.listSteps("plan-1");
    expect(stepResults).toHaveLength(2);
    expect(stepResults[0]?.result?.output).toBe("output one");
    expect(stepResults[1]?.result?.output).toBe("output two");
    expect(engine.requests.map((r) => r.text)).toEqual(["First step.", "Second step."]);
  });

  it("stops plan on step failure", async () => {
    const steps: PlanStep[] = [
      { id: "s1", text: "First step.", providerModel: { providerId: "fixture", modelId: "fixture-model" }, grant, capabilities: testCapabilitySession() },
      { id: "s2", text: "Second step.", providerModel: { providerId: "fixture", modelId: "fixture-model" }, grant, capabilities: testCapabilitySession() },
    ];
    const engine = testAgentEngine([
      { status: "failed", failureCode: "boom" },
      { status: "completed", output: "should not run" },
    ]);
    const orch = createOrchestrator({ engine, store });
    const { done } = orch.runPlan(steps, contextFor(steps));
    await done;

    const stepResults = store.listSteps("plan-1");
    expect(stepResults).toHaveLength(1);
    expect(stepResults[0]?.status).toBe("failed");
    const plan = store.plans.get("plan-1");
    expect(plan?.status).toBe("failed");
    expect(engine.requests).toHaveLength(1);
  });

  it("skips steps whose dependencies were not completed", async () => {
    const steps: PlanStep[] = [
      { id: "s1", text: "First.", providerModel: { providerId: "fixture", modelId: "fixture-model" }, grant, capabilities: testCapabilitySession() },
      { id: "s2", text: "Second.", providerModel: { providerId: "fixture", modelId: "fixture-model" }, grant, capabilities: testCapabilitySession(), dependsOn: ["s1"] },
      { id: "s3", text: "Third.", providerModel: { providerId: "fixture", modelId: "fixture-model" }, grant, capabilities: testCapabilitySession(), dependsOn: ["missing"] },
    ];
    const engine = testAgentEngine([
      { status: "completed", output: "ok" },
    ]);
    const orch = createOrchestrator({ engine, store });
    const { done } = orch.runPlan(steps, contextFor(steps));
    await done;

    const stepResults = store.listSteps("plan-1");
    expect(stepResults.map((s) => s.status).sort()).toEqual(["completed", "completed", "skipped"]);
  });

  it("waits for step-level approval before running", async () => {
    const steps: PlanStep[] = [
      { id: "s1", text: "Needs approval.", providerModel: { providerId: "fixture", modelId: "fixture-model" }, grant, capabilities: testCapabilitySession(), approval: "ask" },
    ];
    const engine = testAgentEngine([{ status: "completed", output: "approved" }]);
    const orch = createOrchestrator({ engine, store });
    const { done } = orch.runPlan(steps, contextFor(steps));

    expect(store.listSteps("plan-1")[0]?.status).toBe("approval_required");
    expect(engine.requests).toHaveLength(0);

    orch.approve("plan-1", "s1");
    await done;

    expect(store.listSteps("plan-1")[0]?.status).toBe("completed");
    expect(engine.requests).toHaveLength(1);
  });

  it("fails plan when step is rejected", async () => {
    const steps: PlanStep[] = [
      { id: "s1", text: "Needs approval.", providerModel: { providerId: "fixture", modelId: "fixture-model" }, grant, capabilities: testCapabilitySession(), approval: "ask" },
    ];
    const engine = testAgentEngine([]);
    const orch = createOrchestrator({ engine, store });
    const { done } = orch.runPlan(steps, contextFor(steps));

    orch.reject("plan-1", "s1", "user declined");
    await done;

    const plan = store.plans.get("plan-1");
    expect(plan?.status).toBe("failed");
    expect(engine.requests).toHaveLength(0);
  });

  it("interrupts a running plan", async () => {
    const steps: PlanStep[] = [
      { id: "s1", text: "First.", providerModel: { providerId: "fixture", modelId: "fixture-model" }, grant, capabilities: testCapabilitySession() },
      { id: "s2", text: "Second.", providerModel: { providerId: "fixture", modelId: "fixture-model" }, grant, capabilities: testCapabilitySession() },
    ];
    const engine = testAgentEngine([{ status: "completed", output: "ok" }]);
    const orch = createOrchestrator({ engine, store });
    const { done } = orch.runPlan(steps, contextFor(steps));
    await done;

    const plan = store.plans.get("plan-1");
    expect(plan?.status).toBe("completed");

    const interruptStore = testOrchestratorStore();
    const engine2 = testAgentEngine([]);
    const orch2 = createOrchestrator({ engine: engine2, store: interruptStore });
    const { done: done2 } = orch2.runPlan(steps, { ...contextFor(steps), planId: "plan-2" });
    orch2.interrupt("plan-2");
    await done2;

    const plan2 = interruptStore.plans.get("plan-2");
    expect(plan2?.status).toBe("interrupted");
  });

  it("getPlanResults returns undefined for unknown plan", async () => {
    expect(orchestrator.getPlanResults("nope")).toBeUndefined();
  });

  it("returns store engineId", async () => {
    expect(orchestrator.engineId).toBe("engine-1");
  });

  // M10: engine run returns recovery_required → mark step recovery_required and stop plan
  it("marks step as recovery_required when engine run returns recovery_required", async () => {
    const steps: PlanStep[] = [
      { id: "s1", text: "First step.", providerModel: { providerId: "fixture", modelId: "fixture-model" }, grant, capabilities: testCapabilitySession() },
      { id: "s2", text: "Second step.", providerModel: { providerId: "fixture", modelId: "fixture-model" }, grant, capabilities: testCapabilitySession() },
    ];
    const engine = testAgentEngine([
      { status: "recovery_required" as AgentRunStatus },
      { status: "completed", output: "should not run" },
    ]);
    const orch = createOrchestrator({ engine, store });
    const { done } = orch.runPlan(steps, contextFor(steps));
    await done;

    const stepResults = store.listSteps("plan-1");
    expect(stepResults).toHaveLength(1);
    expect(stepResults[0]?.status).toBe("recovery_required");
    const plan = store.plans.get("plan-1");
    expect(plan?.status).toBe("recovery_required");
    expect(engine.requests).toHaveLength(1);
  });

  // M10: verification not-run when no verifier configured
  it("records verification not_run when no verifier configured", async () => {
    const steps: PlanStep[] = [
      { id: "s1", text: "Say hello.", providerModel: { providerId: "fixture", modelId: "fixture-model" }, grant, capabilities: testCapabilitySession() },
    ];
    const { planId, done } = orchestrator.runPlan(steps, contextFor(steps));
    await done;

    const stepResults = store.listSteps(planId);
    expect(stepResults).toHaveLength(1);
    expect(stepResults[0]?.status).toBe("completed");
    const verification = stepResults[0]?.result?.verification;
    expect(verification).toEqual({ verified: false, reason: "not_run" });
  });

  // M10: verification ok when verifier configured and passes
  it("records verification verified when verifier passes", async () => {
    const steps: PlanStep[] = [
      { id: "s1", text: "Say hello.", providerModel: { providerId: "fixture", modelId: "fixture-model" }, grant, capabilities: testCapabilitySession() },
    ];
    const verify = vi.fn().mockResolvedValue({ ok: true, feedback: "" });
    const decide = vi.fn().mockReturnValue({ allowed: true, route: { candidates: [{ providerId: "fixture", modelId: "fixture-model" }] } });
    const orch = createOrchestrator({ engine, store, intelligence: { enabled: false, verify, decide } });
    const { done } = orch.runPlan(steps, contextFor(steps));
    await done;

    const stepResults = store.listSteps("plan-1");
    expect(stepResults[0]?.status).toBe("completed");
    expect(verify).toHaveBeenCalledTimes(1);
  });

  // M10: verification failure triggers retry then fail
  it("retry then fail when verification rejects", async () => {
    const steps: PlanStep[] = [
      { id: "s1", text: "Say hello.", providerModel: { providerId: "fixture", modelId: "fixture-model" }, grant, capabilities: testCapabilitySession() },
    ];
    const engine = testAgentEngine([
      { status: "completed", output: "wrong answer" },
      { status: "completed", output: "still wrong" },
    ]);
    const verify = vi.fn().mockResolvedValue({ ok: false, feedback: "not good enough" });
    const decide = vi.fn().mockReturnValue({ allowed: true, route: { candidates: [{ providerId: "fixture", modelId: "fixture-model" }] } });
    const orch = createOrchestrator({ engine, store, intelligence: { enabled: true, verify, decide } });
    const { done } = orch.runPlan(steps, contextFor(steps));
    await done;

    const stepResults = store.listSteps("plan-1");
    expect(stepResults[0]?.status).toBe("failed");
    expect(verify).toHaveBeenCalledTimes(3);
  });
});
