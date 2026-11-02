import { describe, expect, it } from "vitest";

import {
  checkSentinelInstall, launchdPlist, sentinelCommand, sentinelLaunchdPlist, sentinelServicePlan, sentinelSystemdService, sentinelSystemdTimer,
  sentinelUnitCommand, serviceCommand, servicePlan, shippedSentinelCli, systemdUnit, unstableInstallWarning, type ServiceSpec,
} from "./service-unit.ts";

const spec: ServiceSpec = {
  node: "/usr/bin/node",
  script: "/usr/lib/node_modules/mausclaw/cli.js",
  serveArgs: ["--port", "8799", "--data-dir", "/home/maus/.mausclaw", "--domain", "maus.example.com", "--no-pair"],
  dataDir: "/home/maus/.mausclaw",
  user: "maus",
  home: "/home/maus",
  bindsLowPorts: true,
  label: "agentada",
};

describe("service units", () => {
  it("runs the same serve command, with strip-types only for a checkout", () => {
    expect(serviceCommand(spec)).toEqual(["/usr/bin/node", "/usr/lib/node_modules/mausclaw/cli.js", "serve", ...spec.serveArgs]);
    expect(serviceCommand({ ...spec, script: "/srv/MausClaw/server/mausclaw.ts" })[1]).toBe("--experimental-strip-types");
  });

  it("renders a systemd unit that restarts, runs as the user, and grants low ports only for --domain", () => {
    const unit = systemdUnit(spec);
    expect(unit).toContain("Description=MausClaw (agentada)");
    expect(unit).toContain("User=maus");
    expect(unit).toContain("Environment=MAUSCLAW_DATA_DIR=/home/maus/.mausclaw");
    expect(unit).toContain("ExecStart=/usr/bin/node /usr/lib/node_modules/mausclaw/cli.js serve --port 8799 --data-dir /home/maus/.mausclaw --domain maus.example.com --no-pair");
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("AmbientCapabilities=CAP_NET_BIND_SERVICE");
    expect(unit).toContain("WantedBy=multi-user.target");
    const local = systemdUnit({ ...spec, bindsLowPorts: false, serveArgs: ["--port", "8799", "--data-dir", "/home/maus/.mausclaw"] });
    expect(local).not.toContain("CAP_NET_BIND_SERVICE");
    expect(systemdUnit({ ...spec, dataDir: "/home/maus/My Data", serveArgs: ["--data-dir", "/home/maus/My Data"] })).toContain('ExecStart=/usr/bin/node /usr/lib/node_modules/mausclaw/cli.js serve --data-dir "/home/maus/My Data"');
  });

  it("renders a launchd agent that keeps the server alive and logs under the data dir", () => {
    const plist = launchdPlist({ ...spec, home: "/Users/maus", dataDir: "/Users/maus/.mausclaw" });
    expect(plist).toContain("<string>com.mausclaw.serve</string>");
    expect(plist).toContain("<string>/usr/bin/node</string>");
    expect(plist).toContain("<string>serve</string>");
    expect(plist).toContain("<string>maus.example.com</string>");
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("/Users/maus/.mausclaw/logs/service.log");
    expect(launchdPlist({ ...spec, serveArgs: ["--label", "a & b <c>"] })).toContain("<string>a &amp; b &lt;c&gt;</string>");
  });

  it("refuses to point a service at an npx cache, and knows where each platform's file goes", () => {
    expect(unstableInstallWarning("/home/maus/.npm/_npx/abc123/node_modules/mausclaw/cli.js")).toMatch(/npm install -g mausclaw/);
    expect(unstableInstallWarning("/usr/lib/node_modules/mausclaw/cli.js")).toBeNull();
    const linux = servicePlan("linux", "/home/maus/.mausclaw");
    expect(linux?.installed).toBe("/etc/systemd/system/mausclaw.service");
    expect(linux?.activate.join("\n")).toContain("systemctl enable --now mausclaw");
    const mac = servicePlan("darwin", "/Users/maus/.mausclaw", "/Users/maus");
    expect(mac?.installed).toBe("/Users/maus/Library/LaunchAgents/com.mausclaw.serve.plist");
    expect(mac?.activate.join("\n")).toContain("launchctl bootstrap gui/$(id -u)");
    expect(servicePlan("win32", "C:\\x")).toBeNull();
  });

  it("renders Sentinel as a launchd agent on an interval, under its own label, logging outside the data dir", () => {
    const out = "/Users/maus/Library/Application Support/mausclaw-sentinel";
    const sentinel = { node: "/usr/bin/node", script: "/usr/lib/node_modules/mausclaw/cli.js", dataDir: "/Users/maus/.mausclaw", home: "/Users/maus", out };
    expect(sentinelCommand(sentinel)).toEqual(["/usr/bin/node", "/usr/lib/node_modules/mausclaw/cli.js", "sentinel", "--once", "--data-dir", "/Users/maus/.mausclaw", "--out", out]);
    expect(sentinelCommand({ ...sentinel, script: "/srv/MausClaw/server/mausclaw.ts" })[1]).toBe("--experimental-strip-types");
    const plist = sentinelLaunchdPlist(sentinel);
    expect(plist).toContain("<string>com.mausclaw.sentinel</string>");
    expect(plist).toContain("<key>StartInterval</key>\n\t<integer>120</integer>");
    expect(plist).toContain("<string>sentinel</string>");
    expect(plist).not.toContain("KeepAlive");
    expect(plist).toContain(`<string>${out}/sentinel.log</string>`);
    expect(plist).not.toContain(".mausclaw/logs");
    const mac = sentinelServicePlan("darwin", out, "/Users/maus");
    expect(mac?.files).toEqual([{ name: "com.mausclaw.sentinel.plist", installed: "/Users/maus/Library/LaunchAgents/com.mausclaw.sentinel.plist" }]);
    // a path with a space is one argument in the printed commands
    expect(mac?.activate[0]).toBe("mkdir -p /Users/maus/Library/LaunchAgents && cp '/Users/maus/Library/Application Support/mausclaw-sentinel/com.mausclaw.sentinel.plist' /Users/maus/Library/LaunchAgents/com.mausclaw.sentinel.plist");
    expect(mac?.deactivate[0]).toBe("launchctl bootout gui/$(id -u)/com.mausclaw.sentinel");
  });

  it("renders Sentinel as a systemd user timer, with no root", () => {
    const sentinel = { node: "/usr/bin/node", script: "/usr/lib/node_modules/mausclaw/cli.js", dataDir: "/home/maus/My Data", home: "/home/maus", out: "/home/maus/.local/state/mausclaw-sentinel" };
    const unit = sentinelSystemdService(sentinel);
    expect(unit).toContain("Type=oneshot");
    expect(unit).toContain('ExecStart=/usr/bin/node /usr/lib/node_modules/mausclaw/cli.js sentinel --once --data-dir "/home/maus/My Data" --out /home/maus/.local/state/mausclaw-sentinel');
    expect(unit).not.toContain("User=");
    expect(sentinelSystemdTimer()).toContain("OnUnitActiveSec=120s");
    expect(sentinelSystemdTimer()).toContain("WantedBy=timers.target");
    const linux = sentinelServicePlan("linux", sentinel.out, "/home/maus");
    expect(linux?.files.map((file) => file.installed)).toEqual(["/home/maus/.config/systemd/user/mausclaw-sentinel.service", "/home/maus/.config/systemd/user/mausclaw-sentinel.timer"]);
    expect(linux?.activate[0]).toContain("cp /home/maus/.local/state/mausclaw-sentinel/mausclaw-sentinel.service");
    expect(linux?.activate.join("\n")).toContain("systemctl --user enable --now mausclaw-sentinel.timer");
    expect(linux?.activate.join("\n")).not.toContain("sudo");
    expect(sentinelServicePlan("win32", "C:\\x")).toBeNull();
  });

  it("finds the CLI the installed desktop app ships, and runs it as Node", () => {
    const app = "/Applications/MausClaw.app/Contents";
    const present = new Set([`${app}/MacOS/MausClaw`, `${app}/Resources/server/mausclaw.js`]);
    expect(shippedSentinelCli("darwin", "/Users/maus", (path) => present.has(path))).toEqual({ node: `${app}/MacOS/MausClaw`, script: `${app}/Resources/server/mausclaw.js` });
    const user = "/Users/maus/Applications/MausClaw.app/Contents";
    expect(shippedSentinelCli("darwin", "/Users/maus", (path) => path.startsWith(user))?.script).toBe(`${user}/Resources/server/mausclaw.js`);
    expect(shippedSentinelCli("linux", "/home/maus", (path) => path.startsWith("/opt/MausClaw/"))).toEqual({ node: "/opt/MausClaw/mausclaw", script: "/opt/MausClaw/resources/server/mausclaw.js" });
    // an app with its script missing, or one released before Sentinel, is no CLI for it
    expect(shippedSentinelCli("darwin", "/Users/maus", (path) => path.endsWith("MacOS/MausClaw"))).toBeNull();
    expect(shippedSentinelCli("darwin", "/Users/maus", (path) => present.has(path), () => false)).toBeNull();
    expect(shippedSentinelCli("win32", "C:\\Users\\maus", () => true)).toBeNull();

    const spec = { node: `${app}/MacOS/MausClaw`, script: `${app}/Resources/server/mausclaw.js`, dataDir: "/Users/maus/.mausclaw", home: "/Users/maus", out: "/tmp/s", electronRunAsNode: true };
    expect(sentinelLaunchdPlist(spec)).toContain("<key>ELECTRON_RUN_AS_NODE</key>\n\t\t<string>1</string>");
    expect(sentinelSystemdService(spec)).toContain("Environment=ELECTRON_RUN_AS_NODE=1");
    expect(sentinelLaunchdPlist({ ...spec, electronRunAsNode: false })).not.toContain("ELECTRON_RUN_AS_NODE");
  });

  it("keeps every path one quoted value in the systemd unit, and refuses one no unit can hold", () => {
    const spec = { node: "/usr/bin/node", script: "/srv/mausclaw/cli.js", dataDir: "/home/maus/100% $HOME\\", home: "/home/my maus", out: "/home/my maus/.local/state/mausclaw-sentinel" };
    const unit = sentinelSystemdService(spec);
    expect(unit).toContain('Environment="HOME=/home/my maus"');
    // % is no specifier, $ no variable, and the trailing backslash no continuation
    expect(unit).toContain('"/home/maus/100%% $$HOME\\\\"');
    expect(sentinelUnitCommand(unit)).toEqual({ node: "/usr/bin/node", script: "/srv/mausclaw/cli.js" });
    expect(sentinelUnitCommand(sentinelSystemdService({ ...spec, script: "/srv/100% $x/cli.js" }))?.script).toBe("/srv/100% $x/cli.js");
    for (const bad of ["/home/maus\n[Service]\nExecStartPre=/bin/true", "/home/maus\r", "/home/\0maus"]) {
      expect(() => sentinelSystemdService({ ...spec, home: bad })).toThrow(/line break or NUL/);
      expect(() => sentinelLaunchdPlist({ ...spec, dataDir: bad })).toThrow(/line break or NUL/);
    }
  });

  it("reads back what an installed unit runs, and calls it stale when either path is gone", () => {
    const spec = { node: "/opt/node & co/bin/node", script: "/srv/mausclaw/cli.js", dataDir: "/home/maus/My Data", home: "/home/maus", out: "/home/maus/.local/state/mausclaw-sentinel" };
    expect(sentinelUnitCommand(sentinelLaunchdPlist(spec))).toEqual({ node: "/opt/node & co/bin/node", script: "/srv/mausclaw/cli.js" });
    expect(sentinelUnitCommand(sentinelSystemdService(spec))).toEqual({ node: "/opt/node & co/bin/node", script: "/srv/mausclaw/cli.js" });
    expect(sentinelUnitCommand("[Service]\nType=oneshot\n")).toBeNull();

    const unit = "/home/maus/.config/systemd/user/mausclaw-sentinel.service";
    const timer = "/home/maus/.config/systemd/user/mausclaw-sentinel.timer";
    const files = new Map([[unit, sentinelSystemdService(spec)]]);
    const fs = (present: string[]) => ({ exists: (path: string) => files.has(path) || present.includes(path), read: (path: string) => files.get(path)! });
    expect(checkSentinelInstall("linux", "/home/maus", fs([spec.node, spec.script, timer]))).toMatchObject({ status: "ok", unit });
    expect(checkSentinelInstall("linux", "/home/maus", fs([spec.node, timer]))).toMatchObject({ status: "stale", missing: ["/srv/mausclaw/cli.js"] });
    // the service without its timer never runs
    expect(checkSentinelInstall("linux", "/home/maus", fs([spec.node, spec.script]))).toMatchObject({ status: "stale", missing: [timer] });
    expect(checkSentinelInstall("darwin", "/Users/maus", fs([]))).toEqual({ status: "not_installed", unit: "/Users/maus/Library/LaunchAgents/com.mausclaw.sentinel.plist" });
    files.set(unit, "garbage");
    expect(checkSentinelInstall("linux", "/home/maus", fs([]))).toEqual({ status: "unreadable", unit });
    expect(checkSentinelInstall("win32", "C:\\Users\\maus", fs([]))).toEqual({ status: "unsupported" });
  });
});
