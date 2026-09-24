import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveLayerRules } from "../config.js";
import { loadCheapProject } from "../extract/project.js";
import { analyzeLayers } from "./analyze.js";
import { compileMatchers, directionOf, layerOf } from "./classify.js";
import { reconcile } from "./reconcile.js";
import { type Layer, LayerRulesSchema } from "./rules.js";

const LAYERS: readonly Layer[] = [
  { name: "surface", paths: ["apps/web", "packages/cli"] },
  { name: "service", paths: ["services"] },
  { name: "domain", paths: ["services/*/src/domain", "packages/a11y"] },
  { name: "contract", paths: ["packages/a11y-contract"] },
];
const matchers = compileMatchers(LAYERS);
const nameAt = (p: string): string | null => layerOf(p, matchers)?.name ?? null;

describe("layer classification is declared, and the most specific declaration wins", () => {
  it("puts a service file in `service` and its domain subtree in `domain`", () => {
    expect(nameAt("services/auditer/src/handlers/http.ts")).toBe("service");
    expect(nameAt("services/auditer/src/domain/glyph/scan.ts")).toBe("domain");
  });

  it("ends a prefix at a path separator, so a11y-contract is not a11y", () => {
    expect(nameAt("packages/a11y/src/scan.ts")).toBe("domain");
    expect(nameAt("packages/a11y-contract/src/wire.ts")).toBe("contract");
  });

  it("returns null OUTSIDE the lattice rather than defaulting to a layer", () => {
    expect(nameAt("tools/code-graph/src/index.ts")).toBeNull();
    expect(nameAt("packages/design/src/button.tsx")).toBeNull();
  });

  it("reads a rank comparison as down / sideways / up, and null as unlayered", () => {
    const surface = layerOf("apps/web/x.ts", matchers);
    const domain = layerOf("packages/a11y/x.ts", matchers);
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

describe("the declaration is parsed at the config boundary", () => {
  const errors: string[] = [];
  const report = (m: string): void => {
    errors.push(m);
  };

  it("ships defaults that parse, and a repo declaration with unique names", () => {
    const rules = LayerRulesSchema.parse({});
    expect(rules.layers.length).toBeGreaterThan(1);
    expect(new Set(rules.layers.map((l) => l.name)).size).toBe(rules.layers.length);
    expect(resolveLayerRules(undefined, report)).not.toBeNull();
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
