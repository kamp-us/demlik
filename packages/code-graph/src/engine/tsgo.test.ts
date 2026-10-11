import { ChildProcess } from "node:child_process";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FIXTURE } from "../test-helpers/ratchet-repo.js";
import { openTypeProgram, openTypeSession } from "./tsgo.js";

const tsConfigPath = path.join(FIXTURE, "base", "tsconfig.json");
const entry = path.join(FIXTURE, "base", "src", "index.ts");

// The signals a close sends the tsgo server, in order.
function signalsOf(close: () => void): unknown[] {
  const kill = vi.spyOn(ChildProcess.prototype, "kill");
  close();
  return kill.mock.calls.map(([signal]) => signal);
}

describe("closing a tsgo session", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("kills the server before the API's own close can signal it", () => {
    const session = openTypeSession(tsConfigPath);
    const program = session.program({ rootFiles: [entry], includeConfigFiles: false });
    expect(program.sourceFile(entry)).toBeDefined();
    program.close();
    expect(signalsOf(session.close)[0]).toBe("SIGKILL");
  });

  it("does the same with a program still open", () => {
    const program = openTypeProgram({
      tsConfigPath,
      rootFiles: [entry],
      includeConfigFiles: false,
    });
    expect(signalsOf(program.close)[0]).toBe("SIGKILL");
  });
});
