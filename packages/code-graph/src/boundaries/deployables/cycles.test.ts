import { afterEach, describe, expect, it } from "vitest";
import { type BoundaryRepo, boundaryRepo } from "../../test-helpers/boundary-repo.js";
import { ledgerOf, reportOf } from "../../test-helpers/library-report.js";
import { ledgerTargetOf } from "../ledger.js";
import type { DeployableCensus } from "./census.js";

const RULES = { acrossDeployables: ["worker-call-cycle"] };

type Config = Record<string, unknown>;

// A repo of workers: each name maps to its wrangler config, written to `services/<name>`.
function workersOf(configs: Record<string, Config>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(configs).map(([name, config]) => [
      `services/${name}/wrangler.jsonc`,
      JSON.stringify({ name, ...config }),
    ]),
  );
}

const to = (binding: string, service: string) => ({ binding, service });
const services = (...bindings: { binding: string; service: string }[]): Config => ({
  services: bindings,
});

let repo: BoundaryRepo | null = null;
const open = (configs: Record<string, Config>): BoundaryRepo => {
  repo = boundaryRepo(".", workersOf(configs), RULES);
  return repo;
};
afterEach(() => repo?.dispose());

// `[from, specifier]` of every B18 the run lists.
function cyclesOf(run: ReturnType<BoundaryRepo["run"]>): string[][] {
  return reportOf(run)
    .scopes.flatMap((s) => s.violations)
    .filter((v) => v.kind === "worker-call-cycle")
    .map((v) => [v.from, ledgerTargetOf(v)]);
}

const cycles = (configs: Record<string, Config>): string[][] =>
  cyclesOf(open(configs).run({ json: true }));

describe("B18 worker-call-cycle", () => {
  it("is one entry for two workers binding each other", () => {
    expect(cycles({ a: services(to("B", "b")), b: services(to("A", "a")) })).toEqual([
      ["a, b", "a.B -> b; b.A -> a"],
    ]);
  });

  it("is one entry for a ring of three", () => {
    const ring = {
      a: services(to("B", "b")),
      b: services(to("C", "c")),
      c: services(to("A", "a")),
    };
    expect(cycles(ring)).toEqual([["a, b, c", "a.B -> b; b.C -> c; c.A -> a"]]);
  });

  it("is one entry for two cycles sharing a worker, listing every worker and edge in them", () => {
    const shared = {
      a: services(to("B", "b")),
      b: services(to("A", "a"), to("C", "c")),
      c: services(to("B", "b")),
    };
    expect(cycles(shared)).toEqual([["a, b, c", "a.B -> b; b.A -> a; b.C -> c; c.B -> b"]]);
  });

  it("keeps a ring with a chord, and a second binding to one worker, as one entry with every edge", () => {
    const chord = {
      a: services(to("B", "b"), to("B2", "b")),
      b: services(to("C", "c")),
      c: services(to("A", "a")),
    };
    expect(cycles(chord)).toEqual([["a, b, c", "a.B -> b; a.B2 -> b; b.C -> c; c.A -> a"]]);
  });

  it("leaves a one-way chain clean, and two cycles apart as two entries", () => {
    const chain = { a: services(to("B", "b")), b: services(to("C", "c")), c: {} };
    expect(cycles(chain)).toEqual([]);
    const apart = {
      a: services(to("B", "b")),
      b: services(to("A", "a")),
      c: services(to("D", "d")),
      d: services(to("C", "c")),
    };
    expect(cycles(apart).map(([from]) => from)).toEqual(["a, b", "c, d"]);
  });

  it("lists the workers sorted and the edges sorted, however the configs are named", () => {
    const run = open({ zeta: services(to("TO", "alpha")), alpha: services(to("TO", "zeta")) });
    expect(cyclesOf(run.run({ json: true }))).toEqual([
      ["alpha, zeta", "alpha.TO -> zeta; zeta.TO -> alpha"],
    ]);
  });

  it("takes a service binding to a worker with no config as no edge, and counts it", () => {
    const run = open({
      a: services(to("B", "b"), to("PARTNER", "partner-gateway")),
      b: services(to("A", "a")),
    });
    const report = reportOf(run.run({ json: true })) as unknown as {
      deployables: DeployableCensus;
    };
    expect(report.deployables.unresolvedServiceBindings).toBe(1);
    expect(cyclesOf(run.run({ json: true }))).toEqual([["a, b", "a.B -> b; b.A -> a"]]);
    expect(run.run().stdout).toContain("1 service binding to a worker with no config in the repo");
  });

  it("forms the edge of a binding that is declared and never used", () => {
    const run = open({ a: services(to("B", "b")), b: services(to("A", "a")) });
    expect(cyclesOf(run.run({ json: true }))).toHaveLength(1);
  });

  it("ignores a services entry under an env block, which only the top level declares", () => {
    const configs = {
      a: services(to("B", "b")),
      b: { env: { staging: { services: [to("A", "a")] } } },
    };
    expect(cycles(configs)).toEqual([]);
  });

  it("takes a Durable Object or Workflow binding with a script_name as no edge", () => {
    const configs = {
      a: {
        durable_objects: { bindings: [{ name: "DO", class_name: "C", script_name: "b" }] },
        workflows: [{ binding: "WF", class_name: "F", script_name: "b" }],
      },
      b: services(to("A", "a")),
    };
    expect(cycles(configs)).toEqual([]);
  });

  it("takes a worker that binds itself as no cycle", () => {
    expect(cycles({ a: services(to("ME", "a")) })).toEqual([]);
  });

  it("names a worker by its config's name, else its directory's", () => {
    const run = boundaryRepo(
      ".",
      {
        "services/first/wrangler.jsonc": JSON.stringify({
          name: "alpha",
          services: [to("B", "beta")],
        }),
        "services/second/wrangler.jsonc": JSON.stringify({
          name: "beta",
          services: [to("A", "alpha")],
        }),
      },
      RULES,
    );
    repo = run;
    expect(cyclesOf(run.run({ json: true }))).toEqual([
      ["alpha, beta", "alpha.B -> beta; beta.A -> alpha"],
    ]);
  });

  it("makes a cycle that gains a worker or an edge a new entry, and prunes the old one", () => {
    const run = open({ a: services(to("B", "b")), b: services(to("A", "a")) });
    expect(run.run({ acceptCrossings: true, reason: "pair" }).code).toBe(0);
    expect(ledgerOf(run).entries.map((e) => e.from)).toEqual(["a, b"]);

    const withC = workersOf({
      a: services(to("B", "b"), to("C", "c")),
      b: services(to("A", "a")),
      c: services(to("A", "a")),
    });
    for (const [rel, body] of Object.entries(withC)) run.put(rel, body);
    const grown = run.run({ ci: true });
    expect(grown.code).toBe(1);
    expect(grown.stdout).toContain("1 crossing(s) not in boundary-ledger.json");
    expect(grown.stdout).toContain("pruned 1 boundary-ledger.json entry");
    expect(ledgerOf(run).entries).toEqual([]);

    expect(run.run({ acceptCrossings: true, reason: "triple" }).code).toBe(0);
    expect(ledgerOf(run).entries.map((e) => e.from)).toEqual(["a, b, c"]);

    const withEdge = workersOf({ a: services(to("B", "b"), to("C", "c"), to("B2", "b")) });
    for (const [rel, body] of Object.entries(withEdge)) run.put(rel, body);
    const edged = run.run({ ci: true });
    expect(edged.code).toBe(1);
    expect(edged.stdout).toContain("a.B2 -> b");
  });
});
