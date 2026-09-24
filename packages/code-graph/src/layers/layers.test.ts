import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveLayerRules } from "../config.js";
import { loadCheapProject } from "../extract/project.js";
import { analyzeLayers } from "./analyze.js";
import { compileMatchers, directionOf, layerOf } from "./classify.js";
import { runLayerGate } from "./gate.js";
import { reconcile } from "./reconcile.js";
import { renderLayers } from "./render.js";
import { type Layer, LayerRulesSchema } from "./rules.js";

const LAYERS: readonly Layer[] = [
  { name: "surface", paths: ["apps/web", "packages/cli"] },
  { name: "service", paths: ["services"] },
  { name: "domain", paths: ["services/*/src/domain", "packages/core"] },
  { name: "contract", paths: ["packages/core-contract"] },
];
const matchers = compileMatchers(LAYERS);
const nameAt = (p: string): string | null => layerOf(p, matchers)?.name ?? null;

describe("layer classification is declared, and the most specific declaration wins", () => {
  it("puts a service file in `service` and its domain subtree in `domain`", () => {
    expect(nameAt("services/billing/src/handlers/http.ts")).toBe("service");
    expect(nameAt("services/billing/src/domain/invoice/total.ts")).toBe("domain");
  });

  it("ends a prefix at a path separator, so core-contract is not core", () => {
    expect(nameAt("packages/core/src/scan.ts")).toBe("domain");
    expect(nameAt("packages/core-contract/src/wire.ts")).toBe("contract");
  });

  it("returns null OUTSIDE the lattice rather than defaulting to a layer", () => {
    expect(nameAt("tools/code-graph/src/index.ts")).toBeNull();
    expect(nameAt("packages/design/src/button.tsx")).toBeNull();
  });

  it("reads a rank comparison as down / sideways / up, and null as unlayered", () => {
    const surface = layerOf("apps/web/x.ts", matchers);
    const domain = layerOf("packages/core/x.ts", matchers);
    expect(directionOf(surface, domain).direction).toBe("down");
    expect(directionOf(domain, surface).direction).toBe("up");
    expect(directionOf(domain, domain).direction).toBe("sideways");
    expect(directionOf(domain, null).direction).toBe("unlayered");
  });
});

function reportOf(violations: ReadonlyArray<{ from: string; to: string; line: number }>) {
  return {
    layers: LAYERS.map((l) => l.name),
    filesScanned: 1,
    census: {
      down: 0,
      sideways: 0,
      up: violations.length,
      unlayered: 0,
      external: 0,
      unresolved: 0,
    },
    unresolved: [],
    violations: violations.map((v) => ({
      from: v.from,
      fromLine: v.line,
      fromLayer: "domain",
      to: v.to,
      toLine: 1,
      toLayer: "service",
      specifier: "../x",
      typeOnly: false,
    })),
  };
}

const A = { from: "services/s/src/domain/a.ts", to: "services/s/src/x.ts" };
const REASON = "Fix: inject it.";

describe("the allowlist is a ratchet — it fails in BOTH directions", () => {
  it("passes when the declared list matches the repo exactly", () => {
    const result = reconcile(reportOf([{ ...A, line: 3 }]), [{ ...A, sites: 1, reason: REASON }]);
    expect(result.passed).toBe(true);
    expect(result.allowedSites).toBe(1);
  });

  it("FAILS on an undeclared violation — new drift cannot land", () => {
    const result = reconcile(reportOf([{ ...A, line: 3 }]), []);
    expect(result.passed).toBe(false);
    expect(result.undeclared.map((e) => e.from)).toEqual([A.from]);
  });

  it("FAILS on a declared violation that no longer exists — no keeping an excuse", () => {
    const result = reconcile(reportOf([]), [{ ...A, sites: 1, reason: REASON }]);
    expect(result.passed).toBe(false);
    expect(result.stale.map((e) => e.to)).toEqual([A.to]);
  });

  it("FAILS when the site count moves in either direction", () => {
    const grew = reconcile(
      reportOf([
        { ...A, line: 3 },
        { ...A, line: 9 },
      ]),
      [{ ...A, sites: 1, reason: REASON }],
    );
    expect(grew.passed).toBe(false);
    expect(grew.miscounted.map((m) => m.actual)).toEqual([2]);

    const shrank = reconcile(reportOf([{ ...A, line: 3 }]), [{ ...A, sites: 2, reason: REASON }]);
    expect(shrank.passed).toBe(false);
    expect(shrank.miscounted.map((m) => m.actual)).toEqual([1]);
  });

  it("counts an allowed site only when its declaration matched exactly", () => {
    const result = reconcile(reportOf([{ ...A, line: 3 }]), [{ ...A, sites: 2, reason: REASON }]);
    expect(result.allowedSites).toBe(0);
  });
});

describe("a failing gate sends the consumer to their own rules file", () => {
  const B = { from: "services/s/src/domain/b.ts", to: "services/s/src/y.ts" };
  const C = { from: "services/s/src/domain/c.ts", to: "services/s/src/z.ts" };

  // The allowlist lives only in the consumer's --layer-rules file; a Fix line naming a file
  // inside this package sends them somewhere they cannot, and should not, edit.
  it("points every Fix line at the `allowed` array in the --layer-rules file", () => {
    const { stdout, exitCode } = renderLayers(
      reportOf([
        { ...A, line: 3 },
        { ...A, line: 9 },
        { ...B, line: 4 },
      ]),
      [
        { ...A, sites: 1, reason: REASON },
        { ...C, sites: 1, reason: REASON },
      ],
      false,
      false,
    );
    expect(exitCode).toBe(1);
    // A Fix runs from its `Fix:` line to the next block's count line, or the end of output.
    const lines = stdout.split("\n");
    const fixes = lines
      .map((line, i) => (line.startsWith("  Fix:") ? i : -1))
      .filter((i) => i >= 0)
      .map((start) => {
        const next = lines.findIndex((l, j) => j > start && /^ {2}\d+ declared/.test(l));
        return lines.slice(start, next === -1 ? undefined : next).join("\n");
      });
    expect(fixes).toMatchInlineSnapshot(`
      [
        "  Fix: point the dependency down (move the shared thing into a lower layer, or
        invert it behind a contract). If it cannot move in this PR, add the pair to the
        \`allowed\` array in your --layer-rules file with its exact site count and a reason.",
        "  Fix: delete those entries from the \`allowed\` array in your --layer-rules file.",
        "  Fix: update \`sites\` in the \`allowed\` array in your --layer-rules file, or remove the import.",
      ]
    `);
    expect(stdout).not.toContain("src/layers");
    expect(stdout).not.toContain("allowed.ts");
  });
});

describe("the declaration is parsed at the config boundary", () => {
  const errors: string[] = [];
  const report = (m: string): void => {
    errors.push(m);
  };

  // Every user of the package gets these. A layer stack is repo-specific, so a default that
  // names a path is one consumer's stack shipped to everyone; it lands as a snapshot diff.
  it("ships no layer stack and no allowlist", () => {
    expect(LayerRulesSchema.parse({})).toMatchInlineSnapshot(`
      {
        "allowed": [],
        "layers": [],
      }
    `);
  });

  it("refuses to run with no declared stack, naming --layer-rules", () => {
    const refusals: string[] = [];
    const emitted: string[] = [];
    const code = runLayerGate({
      rootAbsolute: os.tmpdir(),
      repoRoot: os.tmpdir(),
      layerRulesFile: undefined,
      emit: (payload) => emitted.push(payload),
      report: (m) => refusals.push(m),
      json: false,
      pretty: false,
    });
    expect(code).toBe(2);
    expect(emitted).toEqual([]);
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toContain("--layer-rules");
    expect(refusals[0]).not.toContain("\n");
  });

  it("refuses a rules file that declares an allowlist but no stack", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-layer-cfg-"));
    const file = path.join(dir, "allowed-only.json");
    fs.writeFileSync(file, JSON.stringify({ allowed: [] }));
    const refusals: string[] = [];
    expect(resolveLayerRules(file, (m) => refusals.push(m))).toBeNull();
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toContain("--layer-rules");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("refuses an explicit empty stack at the schema boundary", () => {
    expect(LayerRulesSchema.safeParse({ layers: [] }).success).toBe(false);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-layer-cfg-"));
    const file = path.join(dir, "empty.json");
    fs.writeFileSync(file, JSON.stringify({ layers: [] }));
    const refusals: string[] = [];
    expect(resolveLayerRules(file, (m) => refusals.push(m))).toBeNull();
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatch(/^invalid config in ".*": layers: /);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("accepts a declared stack, and leaves the allowlist empty when the file omits it", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-layer-cfg-"));
    const file = path.join(dir, "stack.json");
    fs.writeFileSync(file, JSON.stringify({ layers: LAYERS }));
    expect(resolveLayerRules(file, report)).toEqual({ layers: [...LAYERS], allowed: [] });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("refuses a declaration that names one layer twice, or one path in two layers", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-layer-cfg-"));
    const dupName = path.join(dir, "dup-name.json");
    fs.writeFileSync(
      dupName,
      JSON.stringify({
        layers: [
          { name: "a", paths: ["x"] },
          { name: "a", paths: ["y"] },
        ],
      }),
    );
    expect(resolveLayerRules(dupName, report)).toBeNull();

    const dupPath = path.join(dir, "dup-path.json");
    fs.writeFileSync(
      dupPath,
      JSON.stringify({
        layers: [
          { name: "a", paths: ["x"] },
          { name: "b", paths: ["x"] },
        ],
      }),
    );
    expect(resolveLayerRules(dupPath, report)).toBeNull();
    expect(errors).toHaveLength(2);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "cg-layer-fixture-"));
afterAll(() => fs.rmSync(fixture, { recursive: true, force: true }));

describe("analyzeLayers finds a real upward import at its real line", () => {
  it("reports the upward edge and leaves the downward one alone", () => {
    const svc = path.join(fixture, "services/s/src");
    fs.mkdirSync(path.join(svc, "domain"), { recursive: true });
    fs.writeFileSync(path.join(svc, "state.ts"), "export const state = 1;\n");
    fs.writeFileSync(
      path.join(svc, "handler.ts"),
      "// a service file reaching DOWN into its own domain — legal\nimport { rule } from './domain/rule.js';\nexport const h = rule;\n",
    );
    fs.writeFileSync(
      path.join(svc, "domain/rule.ts"),
      "// line 1\n// line 2\nimport { state } from '../state.js';\nexport const rule = state;\n",
    );

    const rules = LayerRulesSchema.parse({ layers: [...LAYERS], allowed: [] });
    const report = analyzeLayers(loadCheapProject(fixture), fixture, rules);

    expect(report.violations).toHaveLength(1);
    const [edge] = report.violations;
    expect(edge?.from).toBe("services/s/src/domain/rule.ts");
    expect(edge?.fromLine).toBe(3);
    expect(edge?.fromLayer).toBe("domain");
    expect(edge?.to).toBe("services/s/src/state.ts");
    expect(edge?.toLayer).toBe("service");
    expect(report.census.down).toBe(1);
    expect(report.census.unresolved).toBe(0);
  });
});
