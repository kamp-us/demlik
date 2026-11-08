import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { API_LEDGER_FILENAME } from "../api/ledger/ledger.js";
import { type FiveGateRepo, fiveGateRepo, LEDGER_FILES } from "../test-helpers/five-gate-repo.js";
import { runCli } from "../test-helpers/ratchet-repo.js";

const GATE_NAMES = ["layers", "boundaries", "comments", "collapse", "unreachable"] as const;
type GateName = (typeof GATE_NAMES)[number];

const pairs = (): (readonly [GateName, GateName])[] =>
  GATE_NAMES.flatMap((first, at) =>
    GATE_NAMES.slice(at + 1).map((second) => [first, second] as const),
  );

// Several of these spawn the CLI ten or more times in one test.
vi.setConfig({ testTimeout: 180_000 });

let repo: FiveGateRepo;

beforeEach(() => {
  repo = fiveGateRepo();
});

afterEach(() => {
  repo.dispose();
});

// One command naming these gates, `--ci` once however many of them ride it.
const commandOf = (names: readonly GateName[], ...extra: string[]): string[] => {
  const flags = names.flatMap((name) => repo.gates[name].filter((flag) => flag !== "--ci"));
  const ci = names.some((name) => repo.gates[name].includes("--ci")) ? ["--ci"] : [];
  return [repo.app, ...flags, ...ci, ...extra];
};

// A refused run: exit 2, nothing on stdout, one line on stderr naming each flag, no file touched.
const expectRefused = (args: readonly string[], named: readonly string[]): void => {
  const before = repo.ledgers();
  const run = runCli(args);
  expect(run.code).toBe(2);
  expect(run.stdout).toBe("");
  const lines = run.stderr.trimEnd().split("\n");
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("a run takes one gate");
  expect(lines[0]).toContain(`got ${named.join(", ")};`);
  expect(repo.ledgers()).toEqual(before);
};

describe("a command that names several gates is refused", () => {
  it("fails on each gate alone, so a green from any pair would be a gate that did not run", () => {
    const openers: Record<GateName, string> = {
      layers: "LAYER GATE FAILED.",
      boundaries: "BOUNDARY LEDGER FAILED",
      comments: "COMMENT RATCHET FAILED",
      collapse: "PARTIAL-TWIN RATCHET FAILED",
      unreachable: "UNREACHABLE LEDGER FAILED",
    };
    for (const name of GATE_NAMES) {
      const alone = fiveGateRepo();
      const run = runCli([alone.app, ...alone.gates[name]]);
      expect(run.code, name).toBe(1);
      expect(run.stdout, name).toContain(openers[name]);
      alone.dispose();
    }
  });

  it("exits 2 on every one of the ten pairs", () => {
    expect(pairs()).toHaveLength(10);
    for (const [first, second] of pairs()) {
      expectRefused(commandOf([first, second]), [`--${first}`, `--${second}`]);
    }
  });

  it("exits 2 on one command with all five", () => {
    expectRefused(
      commandOf(GATE_NAMES),
      GATE_NAMES.map((name) => `--${name}`),
    );
  });

  it("exits 2 where the report's own reproduction exited 0", () => {
    const boundaryRules = repo.gates.boundaries.slice(-2);
    expectRefused(
      [repo.app, "--unreachable", "--ci", "--boundaries", ...boundaryRules],
      ["--boundaries", "--unreachable"],
    );
  });

  it("refuses a write beside a second gate, which would otherwise be dropped", () => {
    expectRefused(
      [repo.app, "--comments", "--collapse", "--write-ceilings"],
      ["--comments", "--collapse"],
    );
    expectRefused(
      [repo.app, "--unreachable", "--accept-dead", "--reason", "kept", "--boundaries"],
      ["--boundaries", "--unreachable"],
    );
  });

  it("reads --accept-crossings as arming a second gate, with no other arming flag", () => {
    expectRefused(
      [repo.app, "--boundaries", "--comments", "--accept-crossings", "--reason", "kept"],
      ["--boundaries", "--comments"],
    );
  });

  it("reads --migrate-ceilings as arming a second gate, with no other arming flag", () => {
    expectRefused(
      [repo.app, "--boundaries", "--comments", "--migrate-ceilings"],
      ["--boundaries", "--comments"],
    );
  });

  it("never opens a ledger: junk in every one still reaches the same refusal", () => {
    for (const name of LEDGER_FILES) fs.writeFileSync(path.join(repo.top, name), "not json");
    expectRefused(
      commandOf(GATE_NAMES),
      GATE_NAMES.map((name) => `--${name}`),
    );
  });

  it("keeps the --api refusal its own", () => {
    const run = runCli([repo.app, "--api", "map.json", "--layers", "--comments"]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("--api takes only");
  });

  it.each([
    ["--api --ci", ["--ci"]],
    ["--api --accept-api", ["--accept-api", "--reason", "kept"]],
  ])("refuses every gate beside the API ledger's %s", (_form, ledgerFlags) => {
    const map = path.join(repo.top, "api-map.json");
    fs.writeFileSync(map, JSON.stringify({ ".": { entry: "src/commented.ts" } }));
    for (const name of GATE_NAMES) {
      const before = repo.ledgers();
      const run = runCli([repo.app, "--api", map, ...ledgerFlags, ...repo.gates[name]]);
      expect(run.code, name).toBe(2);
      expect(run.stdout, name).toBe("");
      expect(run.stderr.trimEnd().split("\n"), name).toHaveLength(1);
      expect(run.stderr, name).toContain("--api --ci and --api --accept-api take only");
      expect(run.stderr, name).toContain(`--${name}`);
      expect(repo.ledgers(), name).toEqual(before);
      expect(fs.existsSync(path.join(repo.top, API_LEDGER_FILENAME)), name).toBe(false);
    }
  });
});

describe("--env-keys, --hexagon and --owners run without a gate", () => {
  it.each([
    "--env-keys",
    "--hexagon",
    "--owners",
  ])("%s exits 2 beside any gate or plain --ci", (mode) => {
    for (const name of GATE_NAMES) {
      expectRefused([...commandOf([name]), mode], [mode, `--${name}`]);
    }
    expectRefused([repo.app, mode, "--ci"], [mode, "--ci"]);
  });

  it.each([
    "--env-keys",
    "--hexagon",
    "--owners",
  ])("refuses %s beside --accept-smells, whose write would be dropped", (mode) => {
    expectRefused(
      [repo.app, mode, "--accept-smells", "--reason", "kept"],
      [mode, "--accept-smells"],
    );
  });

  it("refuses --owners beside the writes that arm --boundaries, which would be dropped", () => {
    expectRefused(
      [repo.app, "--owners", "--boundaries", "--accept-crossings", "--reason", "kept"],
      ["--owners", "--boundaries"],
    );
    expectRefused(
      [repo.app, "--owners", "--boundaries", "--migrate-ceilings"],
      ["--owners", "--boundaries"],
    );
  });

  it("refuses --owners beside --hexagon and --env-keys, whichever of them would answer first", () => {
    expectRefused([repo.app, "--owners", "--hexagon"], ["--hexagon", "--owners"]);
    expectRefused([repo.app, "--owners", "--env-keys"], ["--env-keys", "--owners"]);
    expectRefused(
      [repo.app, "--owners", "--hexagon", "--env-keys"],
      ["--hexagon", "--env-keys", "--owners"],
    );
  });

  it("leaves --hexagon and --env-keys together as they were", () => {
    expect(runCli([repo.app, "--hexagon", "--env-keys"]).stderr).not.toContain(
      "a run takes one gate",
    );
  });

  it("leaves each running on its own", () => {
    expect(runCli([repo.app, "--env-keys"]).code).toBe(0);
    expect(runCli([repo.app, "--hexagon"]).stderr).not.toContain("a run takes one gate");
    const boundaryRules = repo.gates.boundaries.slice(-2);
    const owners = runCli([repo.app, "--owners", ...boundaryRules]);
    expect(owners.code).toBe(0);
    expect(owners.stderr).toBe("");
    expect(owners.stdout).toContain("packages/app");
  });

  it("reads and writes no ledger when --owners runs, however many are there", () => {
    const before = repo.ledgers();
    for (const name of LEDGER_FILES) fs.writeFileSync(path.join(repo.top, name), "not json");
    const junk = repo.ledgers();
    expect(junk).not.toEqual(before);
    const boundaryRules = repo.gates.boundaries.slice(-2);
    expect(runCli([repo.app, "--owners", ...boundaryRules]).code).toBe(0);
    expect(repo.ledgers()).toEqual(junk);
  });
});

describe("one gate in a run behaves as it did", () => {
  it("does not read a --ci riding one named gate as a second gate", () => {
    for (const name of ["boundaries", "comments", "collapse", "unreachable"] as const) {
      const run = runCli([repo.app, ...repo.gates[name]]);
      expect(run.stderr, name).toBe("");
      expect(run.code, name).toBe(1);
    }
  });

  it("does not read --ci beside --layers as a second gate", () => {
    const run = runCli([repo.app, ...repo.gates.layers, "--ci"]);
    expect(run.code).toBe(1);
    expect(run.stdout).toContain("LAYER GATE FAILED.");
  });

  it("runs plain --ci as the smell gate", () => {
    const run = runCli([repo.app, "--ci"]);
    expect(run.code).toBe(1);
    expect(run.stdout).toContain("SMELL LEDGER FAILED");
    expect(run.stdout).toContain("big-file  packages/app/src/big.ts  700");
  });

  it("keeps a gate's own findings and exit code", () => {
    const unreachable = runCli([repo.app, ...repo.gates.unreachable]);
    expect(unreachable.stdout).toContain("dead  src/dead.ts:unused");
    const boundaries = runCli([repo.app, ...repo.gates.boundaries]);
    expect(boundaries.stdout).toContain(
      "B1 cross-feature  packages/app/src/orders/place.ts -> packages/app/src/billing/charge.ts",
    );
  });

  it("keeps a report beside a gate out of scope: the gate still runs", () => {
    const layers = runCli([repo.app, ...repo.gates.layers, "--comments"]);
    expect(layers.code).toBe(1);
    expect(layers.stdout).toContain("LAYER GATE FAILED.");
    const report = runCli([repo.app, "--cycles", "--kinds"]);
    expect(report.code).toBe(0);
  });
});
