// POST /api/updates/apply: trigger an in-place update for git/docker/npm installs.
// Spawns the update command in the background and restarts the service.
import { spawn } from "node:child_process";
import { SERVER_ROOT } from "../proxy-paths.ts";
import { PASS, type RouteHandler } from "./table.ts";

export function createUpdateApplyRoutes(): RouteHandler {
  return async ({ res, path, method, json }) => {
    if (path !== "/api/updates/apply" || method !== "POST") return PASS;
    try {
      // Determine install kind
      const isGit = (await import("node:fs")).existsSync(`${SERVER_ROOT}/../.git`);
      if (!isGit) {
        return json(res, 400, { error: "Auto-update only supported for git installs" });
      }
      // Spawn update in background
      const child = spawn("bash", ["-c", "cd /root/MausClaw && git pull && pnpm install && pnpm build && systemctl restart mausclaw.service"], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      return json(res, 200, { ok: true, message: "Update started in background. Service will restart shortly." });
    } catch (error) {
      return json(res, 500, { error: `Update failed: ${error instanceof Error ? error.message : String(error)}` });
    }
  };
}
