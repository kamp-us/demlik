import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type CliRun,
  checkoutBranch,
  FIXTURE,
  MAP_FILE,
  POLICY_FILE,
  type RatchetRepo,
  ratchetRepository,
  runCli,
  runGate,
} from "../test-helpers/ratchet-repo.js";
import { API_CRASH_EXIT, type ApiRun, runApiView } from "./cli.js";

let repo: RatchetRepo;

beforeAll(() => {
  repo = ratchetRepository();
});

afterAll(() => {
  fs.rmSync(repo.top, { recursive: true, force: true });
});

// A file under a folder that does not exist, so the write of `--out` throws ENOENT.
const unwritable = () => path.join(repo.top, "no-such-folder", "out.txt");

function expectCrash(run: CliRun): void {
  expect(run.code).toBe(API_CRASH_EXIT);
  expect(run.stdout).toBe("");
  expect(run.stderr).toMatch(/^code-graph: unexpected error: ENOENT: [^\n]*\n$/);
  expect(run.stderr).not.toMatch(/\n\s+at /);
}

// Every overlay under `branches/`, with the gate's exit when the branch carries no changeset.
const BRANCH_EXITS: Readonly<Record<string, 0 | 1>> = {
  "battery-added": 1,
  "battery-changed": 1,
  "battery-removed": 1,
  "every-row": 1,
  "labs-added": 0,
  "labs-changed": 1,
  "labs-removed": 1,
  "no-api-change": 0,
  "stable-added": 1,
  "stable-changed": 1,
  "stable-removed": 1,
};

describe("code-graph --api — a crash has its own exit code (SPEC §13.6)", () => {
  it("covers every branch overlay of the fixture", () => {
    expect(Object.keys(BRANCH_EXITS)).toEqual(
      fs.readdirSync(path.join(FIXTURE, "branches")).sort(),
    );
  });

  it.each(
    Object.entries(BRANCH_EXITS),
  )("on %s the gate exits %i, and 3 with one line when --out cannot be written", (name, code) => {
    checkoutBranch(repo, name);
    expect(runGate(repo).code).toBe(code);
    const crashed = runGate(repo, ["--out", unwritable()]);
    expectCrash(crashed);
    expect(runGate(repo, ["--out", unwritable()])).toEqual(crashed);
  });

  it("exits 3 the same way on the view and on the diff", () => {
    checkoutBranch(repo, "stable-changed");
    const view = [repo.root, "--api", MAP_FILE];
    expectCrash(runCli([...view, "--out", unwritable()]));
    expectCrash(runCli([...view, "--api-base", "main", "--out", unwritable()]));
  });

  it("is not 0, 1 or 2", () => {
    expect([0, 1, 2]).not.toContain(API_CRASH_EXIT);
  });
});

describe("runApiView — an error that is not a refused input", () => {
  const modes: Readonly<Record<string, Pick<ApiRun, "base" | "policyFile">>> = {
    view: { base: undefined, policyFile: undefined },
    diff: { base: "main", policyFile: undefined },
    ratchet: { base: "main", policyFile: POLICY_FILE },
  };

  it.each(Object.entries(modes))("resolves to 3 with one report on the %s", async (_, mode) => {
    checkoutBranch(repo, "stable-changed");
    const reports: string[] = [];
    const code = await runApiView({
      ...mode,
      rootAbsolute: repo.root,
      mapFile: MAP_FILE,
      given: ["api"],
      json: false,
      pretty: false,
      emit: () => {
        throw new TypeError("reader broke\n    at somewhere (file.ts:1:1)");
      },
      report: (message) => reports.push(message),
    });
    expect(code).toBe(API_CRASH_EXIT);
    expect(reports).toEqual(["unexpected error: reader broke at somewhere (file.ts:1:1)"]);
  });

  it("still resolves to 2 on a refused input", async () => {
    const reports: string[] = [];
    const code = await runApiView({
      rootAbsolute: repo.root,
      mapFile: path.join(repo.top, "no-map.json"),
      base: undefined,
      policyFile: undefined,
      given: ["api"],
      json: false,
      pretty: false,
      emit: () => {},
      report: (message) => reports.push(message),
    });
    expect(code).toBe(2);
    expect(reports).toHaveLength(1);
  });
});
