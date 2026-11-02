// The native-only build has no fake Claude engine, so the UI fixture seeds its bot on a loopback
// chat-completions provider and drives the real renderer. The assertions prove the turn the person sees came from the
// MausClaw-owned loop: the provider answered, the reply is in the DOM, and agent_runs records one completed native run.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";

import { resolveAgentBrowserBinary } from "../server/browser-engine.ts";
import { waitForExit } from "../server/testing/cleanup.ts";
import { runControlMausclaw } from "../scripts/control-mausclaw.ts";
import { UI_TOOLS_DIR } from "../scripts/testing/control-mausclaw-ui.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = join(ROOT, "scripts", "control-mausclaw.ts");
const forced = process.env.MAUSCLAW_UI_E2E === "1";
const binary = resolveAgentBrowserBinary({ dataDir: UI_TOOLS_DIR, env: process.env });
const enabled = forced || Boolean(binary);
if (!enabled) console.log("skipping native UI e2e: no agent-browser; set MAUSCLAW_UI_E2E=1 to install the pinned release");
const run = enabled ? it : it.skip;
const LAUNCH_TIMEOUT_MS = forced ? 600_000 : 180_000;

const REPLY = "Native UI verified.";

function frame(delta: unknown, finishReason: string | null): string {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
}

interface Info { ui: string; url: string; previewUrl: string; botId: string; dataDir: string; logPath: string }

describe("a native bot turn through the real renderer", () => {
  const children: Array<ReturnType<typeof spawn>> = [];
  const servers: Array<ReturnType<typeof createServer>> = [];

  afterAll(async () => {
    for (const child of children) {
      if (child.pid && process.platform !== "win32") {
        try { process.kill(-child.pid, "SIGINT"); } catch {}
      } else child.kill("SIGINT");
      await waitForExit(child, { graceMs: 30_000 });
    }
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  run("shows a turn produced by the MausClaw native loop", async () => {
    const requests: Array<{ messages: Array<{ role: string }> }> = [];
    const upstream = createServer(async (request, response) => {
      if (request.url === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "fixture-model" }] }));
        return;
      }
      let body = "";
      for await (const chunk of request) body += chunk;
      requests.push(JSON.parse(body) as typeof requests[number]);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(frame({ content: REPLY }, "stop") + "data: [DONE]\n\n");
    });
    servers.push(upstream);
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("fixture provider address missing");

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      MAUSCLAW_UI_NATIVE_URL: `http://127.0.0.1:${address.port}/v1`,
      MAUSCLAW_UI_NATIVE_KEY: "synthetic-ui-key",
      MAUSCLAW_UI_NATIVE_MODEL: "fixture-model",
    };
    const chrome = process.env.AGENT_BROWSER_EXECUTABLE_PATH?.trim();
    if (chrome) env.AGENT_BROWSER_EXECUTABLE_PATH = chrome;
    const child = spawn(process.execPath, ["--experimental-strip-types", CLI, "ui", "launch"], {
      cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32",
    });
    children.push(child);
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (chunk: Buffer) => { stdout += String(chunk); });
    child.stderr!.on("data", (chunk: Buffer) => { stderr += String(chunk); });
    let info: Info | undefined;
    await expect.poll(() => {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`UI launcher exited: ${stderr}`);
      try { info = JSON.parse(stdout) as Info; return Boolean(info.ui); } catch { return false; }
    }, { timeout: LAUNCH_TIMEOUT_MS + 120_000, interval: 250 }).toBe(true);
    const handle = info!;
    const ui = (verb: string, ...args: string[]) => runControlMausclaw(["ui", verb, "--ui", handle.ui, ...args]) as Promise<Record<string, any>>;

    await ui("type", "--name", "Message Pepper", "--text", "Say hello through the native loop.");
    await ui("press", "--keys", "Enter");

    const api = async (path: string) => fetch(`${handle.url}${path}`, { headers: { origin: handle.url } }).then((response) => response.json() as Promise<any>);
    const pepperReply = async () => {
      const bots = await api("/api/bots");
      const pepper = bots.bots.find((bot: any) => bot.id === handle.botId);
      return pepper?.messages?.some((message: any) => message.role === "bot" && message.text === REPLY) === true;
    };
    // wait-settle can return before a just-sent turn starts, so wait for the turn's own reply first.
    await expect.poll(pepperReply, { timeout: 60_000, interval: 250 }).toBe(true);
    const settled = await ui("wait-settle", "--timeout", "60");
    expect(settled.ok, JSON.stringify(settled)).toBe(true);

    const bots = await api("/api/bots");
    const pepper = bots.bots.find((bot: any) => bot.id === handle.botId);
    expect(pepper.messages.some((message: any) => message.role === "bot" && message.text === REPLY)).toBe(true);
    expect(requests).toHaveLength(1);

    const db = new DatabaseSync(join(handle.dataDir, "messages.db"));
    const runs = db.prepare("SELECT status, model_rounds, tool_calls FROM agent_runs").all() as Array<{ status: string; model_rounds: number; tool_calls: number }>;
    db.close();
    expect(runs).toEqual([{ status: "completed", model_rounds: 1, tool_calls: 0 }]);

    const rendered = await ui("eval", "--js", `document.body.innerText.includes(${JSON.stringify(REPLY)})`);
    expect(rendered.result).toBe(true);
    expect(existsSync(handle.logPath)).toBe(true);
  }, 240_000);
});
