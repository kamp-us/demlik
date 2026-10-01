import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveBoundaryRules } from "../config.js";
import { nearestName } from "./nearest.js";
import { type ProcessMembers, runningProcessMembers } from "./process-members.js";

describe("the members of process come from the running Node, read by name", () => {
  it("holds the seven names the catalog once listed row by row, and an inherited `on`", () => {
    const { names } = runningProcessMembers();
    for (const name of ["env", "argv", "stdin", "stdout", "stderr", "exit", "cwd", "on"]) {
      expect(names.has(name), name).toBe(true);
    }
  });

  it("names the Node version and platform it read, so a refusal can say which host judged it", () => {
    const { node, platform } = runningProcessMembers();
    expect(node).toBe(process.version);
    expect(platform).toBe(process.platform);
  });

  it("runs no getter: reading process.stdin would open a stream", () => {
    let ran = false;
    Object.defineProperty(process, "__probe", {
      configurable: true,
      enumerable: true,
      get() {
        ran = true;
        return undefined;
      },
    });
    try {
      expect(runningProcessMembers().names.has("__probe")).toBe(true);
    } finally {
      Reflect.deleteProperty(process, "__probe");
    }
    expect(ran).toBe(false);
  });
});

describe("a member only some supported Nodes have is judged against the host that runs", () => {
  const SCOPE = "packages/app";
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-members-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const declare = (door: string): string => {
    const file = path.join(dir, "boundaries.json");
    fs.writeFileSync(
      file,
      JSON.stringify({ features: { [SCOPE]: ["billing"] }, doors: { [SCOPE]: { [door]: ["x"] } } }),
    );
    return file;
  };
  const node = (version: string, ...names: string[]): ProcessMembers => ({
    node: version,
    platform: "linux",
    names: new Set(["env", "stdin", ...names]),
  });

  it("declares process.loadEnvFile where the Node has it", () => {
    const errors: string[] = [];
    const rules = resolveBoundaryRules(
      declare("process.loadEnvFile"),
      (m) => errors.push(m),
      node("v20.12.0", "loadEnvFile"),
    );
    expect(rules?.doors[SCOPE]).toEqual({ "process.loadEnvFile": ["x"] });
    expect(errors).toEqual([]);
  });

  it("refuses it, naming the Node version and platform, where the host lacks it", () => {
    const errors: string[] = [];
    const rules = resolveBoundaryRules(
      declare("process.loadEnvFile"),
      (m) => errors.push(m),
      node("v20.11.0"),
    );
    expect(rules).toBeNull();
    expect(errors).toEqual([
      `door "process.loadEnvFile" in "${SCOPE}" is not a member of process on Node v20.11.0 (linux).`,
    ]);
  });
});

describe("the nearest name is the same one on every run", () => {
  it("compares without case, so ENV is env", () => {
    expect(nearestName("ENV", ["end", "env", "eng"])).toBe("env");
  });

  it("breaks a tie on distance by name, whatever order the names come in", () => {
    expect(nearestName("enc", ["env", "end", "ens"])).toBe("end");
    expect(nearestName("enc", ["ens", "end", "env"])).toBe("end");
  });

  it("counts two neighbours swapped as one edit", () => {
    expect(nearestName("stdni", ["stdnn", "stdin"])).toBe("stdin");
  });

  it("names nothing when nothing is near", () => {
    expect(nearestName("zzzzzzzz", ["env", "argv", "stdin", "hrtime"])).toBeNull();
    expect(nearestName("x", ["on", "env"])).toBeNull();
  });
});
