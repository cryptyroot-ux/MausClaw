import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ENGINE_TASKS, type EngineTask } from "./tasks.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function seed(task: EngineTask, overlay: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), `engine-task-${task.id}-`));
  dirs.push(dir);
  for (const [name, text] of Object.entries({ ...task.files, ...overlay })) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

const BASIC = ["fix-function", "bug-from-log", "rename-symbol", "create-file", "csv-transform"];
const HARD = [
  "multi-refactor",
  "failing-test",
  "apply-diff",
  "long-context",
  "parallel-reads",
  "web-lookup",
  "skill-use",
  "async-bug",
  "cli-flag",
  "ini-to-json",
];

describe("engine task catalog", () => {
  it("has the exact ordered ids, five basic and ten hard, all unique", () => {
    expect(ENGINE_TASKS.map((task) => task.id)).toEqual([...BASIC, ...HARD]);
    expect(ENGINE_TASKS.filter((task) => (task.suite ?? "basic") === "basic").map((task) => task.id)).toEqual(BASIC);
    expect(ENGINE_TASKS.filter((task) => task.suite === "hard").map((task) => task.id)).toEqual(HARD);
    expect(new Set(ENGINE_TASKS.map((task) => task.id)).size).toBe(ENGINE_TASKS.length);
  });

  for (const task of ENGINE_TASKS) {
    it(`${task.id}: rejects the seed, accepts the known fix, and leaves protected files alone`, () => {
      expect(task.check(seed(task)).pass).toBe(false);

      const dir = seed(task, task.solution);
      expect(task.check(dir)).toEqual({ pass: true, why: "ok" });

      for (const [name, original] of Object.entries(task.files)) {
        if (Object.hasOwn(task.solution, name)) continue;
        expect(readFileSync(join(dir, name), "utf8"), name).toBe(original);
      }
    });
  }

  it("rejects a fix that edits a protected test file", () => {
    const task = ENGINE_TASKS.find((entry) => entry.id === "fix-function")!;
    expect(task.check(seed(task, { "stats.test.mjs": 'console.log("stats ok")\n' })).pass).toBe(false);
  });
});
