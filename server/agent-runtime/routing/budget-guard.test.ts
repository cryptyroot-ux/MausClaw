import { describe, it, expect } from "vitest";
import { BudgetGuard } from "./budget-guard.ts";
import type { Budget } from "./types.ts";

describe("BudgetGuard", () => {
  it("allows cost within per-thread and per-run limits", () => {
    const guard = new BudgetGuard({ perThreadLimit: 10, perRunLimit: 100 });
    expect(guard.check(5, "t1")).toBe(true);
    guard.record(5, "t1");
    expect(guard.check(5, "t1")).toBe(true);
    guard.record(5, "t1");
    expect(guard.getThreadSpend("t1")).toBe(10);
    expect(guard.getRunSpend()).toBe(10);
  });

  it("rejects cost exceeding per-thread limit", () => {
    const guard = new BudgetGuard({ perThreadLimit: 10, perRunLimit: 100 });
    guard.record(8, "t1");
    expect(guard.check(5, "t1")).toBe(false);
  });

  it("rejects cost exceeding per-run limit", () => {
    const guard = new BudgetGuard({ perThreadLimit: 100, perRunLimit: 10 });
    guard.record(8, "t1");
    expect(guard.check(5, "t2")).toBe(false);
  });

  it("accepts numeric limits constructor", () => {
    const guard = new BudgetGuard(50);
    expect(guard.check(30, "t1")).toBe(true);
    guard.record(30, "t1");
    expect(guard.check(30, "t1")).toBe(false);
  });

  it("reset and resetAll", () => {
    const guard = new BudgetGuard({ perThreadLimit: 100, perRunLimit: 100 });
    guard.record(30, "t1");
    guard.record(30, "t2");
    expect(guard.getRunSpend()).toBe(60);
    guard.resetRun();
    expect(guard.getRunSpend()).toBe(0);
    expect(guard.getThreadSpend("t1")).toBe(30);
    guard.resetAll();
    expect(guard.getThreadSpend("t1")).toBe(0);
    expect(guard.getRunSpend()).toBe(0);
  });

  it("toBudget returns maxCost", () => {
    const guard = new BudgetGuard({ perThreadLimit: 42 });
    expect(guard.toBudget()).toEqual({ maxCost: 42 } as Budget);
  });

  // M10: per-category budget tracking
  it("tracks cost by category", () => {
    const guard = new BudgetGuard({ perThreadLimit: 100, perRunLimit: 1000 });
    guard.record({ category: "engine", primary: { estimatedCost: 5 } }, "t1");
    guard.record({ category: "verifier", primary: { estimatedCost: 3 } }, "t1");
    guard.record({ category: "compaction", primary: { estimatedCost: 2 } }, "t1");
    expect(guard.getThreadSpend("t1")).toBe(10);
    expect(guard.getRunSpend()).toBe(10);
  });

  it("rejects cost exceeding per-category limit", () => {
    const guard = new BudgetGuard({ perThreadLimit: 100, perRunLimit: 1000 });
    guard.record({ category: "engine", primary: { estimatedCost: 5 } }, "t1");
    guard.record({ category: "verifier", primary: { estimatedCost: 3 } }, "t1");
    expect(guard.check({ category: "engine", primary: { estimatedCost: 100 } }, "t1")).toBe(false);
    // But a different category could still fit within overall run limit
    expect(guard.check({ category: "compaction", primary: { estimatedCost: 1 } }, "t1")).toBe(true);
  });
});
