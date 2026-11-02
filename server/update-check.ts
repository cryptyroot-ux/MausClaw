// A self-hosted server cannot replace itself, so this only says whether a newer release exists and how this install is updated.
import { existsSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";

export const LATEST_RELEASE_URL = "https://api.github.com/repos/cryptyroot-ux/MausClaw/commits/feature/native-agent-engine";
const CACHE_MS = 60 * 60_000;

/** "managed" is a hosted or Cloud server that is updated for its owner. */
export type InstallKind = "desktop" | "managed" | "docker" | "podman" | "npm" | "git" | "unknown";

/** As docs/self-hosting.md and deploy/podman/README.md give them. */
export const UPDATE_COMMANDS: Partial<Record<InstallKind, { command: string; restart: boolean }>> = {
  docker: { command: "docker compose pull mausclaw && docker compose up -d", restart: false },
  podman: { command: "git pull && cd deploy/podman && PODMAN_COMPOSE_PROVIDER=podman-compose podman compose --env-file .env -f compose.yaml up -d --build", restart: false },
  npm: { command: "npm install -g mausclaw@latest", restart: true },
  git: { command: "git pull && pnpm install && pnpm build", restart: true },
};

export function installKind(input: {
  desktopManaged: boolean;
  managed: boolean;
  serverRoot: string;
  exists?: (path: string) => boolean;
}): InstallKind {
  const exists = input.exists ?? existsSync;
  if (input.desktopManaged) return "desktop";
  if (input.managed) return "managed";
  if (exists("/.dockerenv")) return "docker";
  if (exists("/run/.containerenv")) return "podman";
  if (input.serverRoot.split(sep).includes("node_modules")) return "npm";
  if (exists(join(input.serverRoot, "..", ".git"))) return "git";
  return "unknown";
}

/** Semver order on tags such as "v0.1.92"; a prerelease sorts before its release, and anything unparseable is never an update. */
export function isNewerVersion(latest: string, current: string): boolean {
  const parse = (version: string) => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version.trim());
    return match ? { core: match.slice(1, 4).map(Number), pre: match[4]?.split(".") ?? [] } : null;
  };
  const a = parse(latest);
  const b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a.core[i]! !== b.core[i]!) return a.core[i]! > b.core[i]!;
  }
  if (!a.pre.length || !b.pre.length) return !a.pre.length && b.pre.length > 0;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === undefined || y === undefined) return y === undefined;
    if (x === y) continue;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) return Number(x) > Number(y);
    if (xn !== yn) return yn;
    return x > y;
  }
  return false;
}

export interface UpdateCheck {
  current: string;
  install: InstallKind;
  latest?: string;
  available: boolean;
  releaseUrl?: string;
  command?: string;
  restart?: boolean;
}

/** One cached GitHub lookup an hour, shared by every caller. */
export function createUpdateChecker(options: {
  current: string;
  install: InstallKind;
  fetch?: typeof fetch;
  now?: () => number;
}) {
  const fetchRelease = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  let cached: { at: number; result: UpdateCheck } | undefined;
  let inflight: Promise<UpdateCheck> | undefined;
  const base = (): UpdateCheck => ({
    current: options.current,
    install: options.install,
    available: false,
    ...UPDATE_COMMANDS[options.install],
  });

  return async function check(): Promise<UpdateCheck> {
    if (options.install === "desktop" || options.install === "managed") return base();
    if (cached && now() - cached.at < CACHE_MS) return cached.result;
    inflight ??= (async () => {
      try {
        const response = await fetchRelease(LATEST_RELEASE_URL, {
          headers: {
            accept: "application/vnd.github+json",
            "user-agent": "mausclaw-update-check",
            ...(() => {
              // Try env vars first
              const envToken = process.env.GITHUB_PERSONAL_ACCESS_TOKEN || process.env.GITHUB_TOKEN;
              if (envToken) return { authorization: `token ${envToken}` };
              // Fall back to gh CLI config
              try {
                const yaml = readFileSync("/root/.config/gh/hosts.yml", "utf8");
                const match = yaml.match(/oauth_token:\s*(\S+)/);
                if (match) return { authorization: `token ${match[1]}` };
              } catch {}
              return {};
            })(),
          },
          signal: AbortSignal.timeout(8_000),
        });
        if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
        const data = await response.json() as { sha?: unknown; html_url?: unknown; tag_name?: unknown };
        // Handle both commit and release responses
        let latest: string;
        let releaseUrl: string | undefined;
        if (typeof data.sha === "string") {
          // Commit response: use short SHA as version identifier
          latest = data.sha.slice(0, 9);
          releaseUrl = typeof data.html_url === "string" ? data.html_url : undefined;
          // An update is available if the remote SHA differs from local HEAD
          const { execSync } = await import("node:child_process");
          let currentSha = "";
          try { currentSha = execSync("git rev-parse --short HEAD", { cwd: "/root/MausClaw", encoding: "utf8" }).trim(); } catch {}
          const available = currentSha !== "" && currentSha !== latest;
          const result: UpdateCheck = {
            ...base(),
            latest,
            available,
            ...(releaseUrl ? { releaseUrl } : {}),
          };
          cached = { at: now(), result };
          return result;
        }
        // Release response
        if (typeof data.tag_name !== "string") throw new Error("GitHub sent no release tag");
        latest = data.tag_name.replace(/^v/, "");
        releaseUrl = typeof data.html_url === "string" ? data.html_url : undefined;
        const result: UpdateCheck = {
          ...base(),
          latest,
          available: isNewerVersion(latest, options.current),
          ...(releaseUrl ? { releaseUrl } : {}),
        };
        cached = { at: now(), result };
        return result;
      } finally {
        inflight = undefined;
      }
    })();
    return inflight;
  };
}
