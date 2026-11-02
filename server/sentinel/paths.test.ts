import { describe, expect, it } from "vitest";

import { defaultSentinelOut, isInside } from "./paths.ts";

describe("sentinel paths", () => {
  it("keeps Sentinel's files in the platform's state folder, outside the data dir", () => {
    expect(defaultSentinelOut("/Users/maus/.mausclaw", "darwin", "/Users/maus", {})).toBe("/Users/maus/Library/Application Support/mausclaw-sentinel");
    expect(defaultSentinelOut("/home/maus/.mausclaw", "linux", "/home/maus", {})).toBe("/home/maus/.local/state/mausclaw-sentinel");
    expect(defaultSentinelOut("/home/maus/.mausclaw", "linux", "/home/maus", { XDG_STATE_HOME: "/var/state/maus" })).toBe("/var/state/maus/mausclaw-sentinel");
    // a relative XDG_STATE_HOME is invalid by the spec and ignored
    expect(defaultSentinelOut("/home/maus/.mausclaw", "linux", "/home/maus", { XDG_STATE_HOME: "state" })).toBe("/home/maus/.local/state/mausclaw-sentinel");
    expect(defaultSentinelOut("C:\\Users\\maus\\.mausclaw", "win32", "C:\\Users\\maus", { LOCALAPPDATA: "D:\\Local" })).toBe("D:\\Local\\mausclaw-sentinel");
  });

  it("gives any other data dir its own subfolder, the same one every time", () => {
    const other = defaultSentinelOut("/srv/mausclaw-data", "linux", "/home/maus", {});
    expect(other).toMatch(/^\/home\/maus\/\.local\/state\/mausclaw-sentinel\/data-[0-9a-f]{12}$/);
    expect(defaultSentinelOut("/srv/mausclaw-data", "linux", "/home/maus", {})).toBe(other);
    expect(defaultSentinelOut("/srv/mausclaw-data-2", "linux", "/home/maus", {})).not.toBe(other);
  });

  it("knows when a folder is inside another", () => {
    expect(isInside("/d/mausclaw/sentinel", "/d/mausclaw", "linux")).toBe(true);
    expect(isInside("/d/mausclaw", "/d/mausclaw", "linux")).toBe(true);
    expect(isInside("/d/mausclaw-sentinel", "/d/mausclaw", "linux")).toBe(false);
    expect(isInside("/d", "/d/mausclaw", "linux")).toBe(false);
    expect(isInside("C:\\d\\mausclaw\\x", "C:\\d\\mausclaw", "win32")).toBe(true);
  });
});
