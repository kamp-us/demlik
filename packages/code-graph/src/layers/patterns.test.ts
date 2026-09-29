import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { compileMatchers, layerOf } from "./classify.js";
import { runLayerGate } from "./gate.js";
import type { Layer } from "./rules.js";

const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = path.join(PACKAGE_DIR, "src", "index.ts");

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
});

function fixtureRepo(files: Record<string, string>): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cg-layer-patterns-")));
  scratch.push(root);
  for (const [rel, source] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), source);
  }
  return root;
}

function rulesFile(root: string, rules: object): string {
  const file = path.join(root, "..", `${path.basename(root)}-rules.json`);
  scratch.push(file);
  fs.writeFileSync(file, JSON.stringify(rules));
  return file;
}

const claims = (pattern: string, file: string): boolean =>
  layerOf(file, compileMatchers([{ name: "only", paths: [pattern] }])) !== null;

const winnerAt = (layers: readonly Layer[], file: string): string | null =>
  layerOf(file, compileMatchers(layers))?.name ?? null;

describe("a filename-role stack gates a repo whose roles live in file names", () => {
  const ROLE_LAYERS = [
    { name: "api-surface", paths: ["**/*-api-surface.ts"] },
    { name: "plumbing", paths: ["**/*-plumbing.ts"] },
    { name: "business-rule", paths: ["**/*-business-rule.ts"] },
  ];
  const root = fixtureRepo({
    "billing-plumbing.ts":
      'import { cart } from "./apps/cart-business-rule.js";\nexport const billing = cart;\n',
    "apps/web/src/lib/http-plumbing.ts": "export const http = 1;\n",
    "services/queue/queue-plumbing.ts": "export const queue = 1;\n",
    "apps/web/web-api-surface.ts":
      'import { http } from "./src/lib/http-plumbing.js";\nexport const web = http;\n',
    "packages/core/core-api-surface.ts":
      'import { price } from "../rules/src/pricing/price-business-rule.js";\nexport const core = price;\n',
    "services/api/src/routes-api-surface.ts":
      'import { queue } from "../../queue/queue-plumbing.js";\nexport const routes = queue;\n',
    "packages/rules/src/pricing/price-business-rule.ts":
      'import { tax } from "../../../../services/tax-business-rule.js";\n' +
      'import { billing } from "../../../../billing-plumbing.js";\n' +
      "export const price = tax + billing;\n",
    "apps/cart-business-rule.ts": "export const cart = 1;\n",
    "services/tax-business-rule.ts": "export const tax = 1;\n",
  });
  const UPWARD = {
    from: "packages/rules/src/pricing/price-business-rule.ts",
    to: "billing-plumbing.ts",
  };

  const run = (rules: object) =>
    spawnSync(
      process.execPath,
      ["--import", "tsx", CLI, root, "--layers", "--layer-rules", rulesFile(root, rules)],
      { cwd: PACKAGE_DIR, encoding: "utf8" },
    );

  it("reports the upward import at its line and classifies every role-to-role edge", () => {
    const result = run({ layers: ROLE_LAYERS });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      "4 down, 1 sideways, 1 UP, 0 unlayered, 0 external, 0 unresolved",
    );
    expect(result.stdout).toContain(
      `  ${UPWARD.from}:2  business-rule -> plumbing  ${UPWARD.to}:1  ("../../../../billing-plumbing.js")`,
    );
  });

  it("passes once the upward import is allowed with its site count", () => {
    const result = run({
      layers: ROLE_LAYERS,
      allowed: [{ ...UPWARD, sites: 1, reason: "Pricing reads billing. Fix: pass it in." }],
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("allowlist: OK — 1 violating site(s)");
  });
});

describe("`**` matches zero or more whole path segments", () => {
  it("claims a role file at the repo root and five folders down", () => {
    expect(claims("**/*-x.ts", "a-x.ts")).toBe(true);
    expect(claims("**/*-x.ts", "a/b/c/d/e-x.ts")).toBe(true);
  });

  it("claims the segment after it directly under the prefix and deep below it", () => {
    expect(claims("apps/**/y", "apps/y")).toBe(true);
    expect(claims("apps/**/y", "apps/p/q/y")).toBe(true);
    expect(claims("apps/**/y", "packages/y")).toBe(false);
  });
});

describe("`*` inside a segment stays inside it", () => {
  it("matches zero or more characters of one file name", () => {
    expect(claims("*-x.ts", "a-x.ts")).toBe(true);
    expect(claims("*-x.ts", "-x.ts")).toBe(true);
  });

  it("never crosses a path separator", () => {
    expect(claims("*-x.ts", "a/b-x.ts")).toBe(false);
    expect(claims("pkg/*-x.ts", "pkg/a/b-x.ts")).toBe(false);
  });

  it("leaves a whole-segment `*` meaning one or more characters", () => {
    expect(claims("pkg/*", "pkg/a")).toBe(true);
    expect(claims("pkg/*", "pkg")).toBe(false);
    expect(claims("pkg/*/x", "pkg//x")).toBe(false);
  });

  it("keeps `?`, `[...]`, `{}` and `!` literal", () => {
    expect(claims("a?.ts", "a?.ts")).toBe(true);
    expect(claims("a?.ts", "ab.ts")).toBe(false);
    expect(claims("[ab].ts", "a.ts")).toBe(false);
    expect(claims("{a,b}.ts", "a.ts")).toBe(false);
    expect(claims("!a.ts", "!a.ts")).toBe(true);
  });
});

describe("specificity is depth, then literal segments, then literal characters", () => {
  it("lets a deeper role pattern beat the repo-wide one", () => {
    const layers = [
      { name: "web-rule", paths: ["apps/web/**/*-business-rule.ts"] },
      { name: "rule", paths: ["**/*-business-rule.ts"] },
    ];
    expect(winnerAt(layers, "apps/web/src/cart-business-rule.ts")).toBe("web-rule");
    expect(winnerAt(layers, "services/cart-business-rule.ts")).toBe("rule");
  });

  it("lets a directory layer beat a role layer at the same depth", () => {
    const layers = [
      { name: "service", paths: ["services"] },
      { name: "plumbing", paths: ["**/*-plumbing.ts"] },
    ];
    expect(winnerAt(layers, "services/x/billing-plumbing.ts")).toBe("service");
    expect(winnerAt(layers, "apps/billing-plumbing.ts")).toBe("plumbing");
  });

  it("lets a named file beat its role pattern", () => {
    const layers = [
      { name: "plumbing", paths: ["**/*-plumbing.ts"] },
      { name: "billing", paths: ["**/billing-plumbing.ts"] },
    ];
    expect(winnerAt(layers, "services/billing-plumbing.ts")).toBe("billing");
  });

  it("breaks a depth and literal-segment tie on literal characters", () => {
    const layers = [
      { name: "plumbing", paths: ["**/*-plumbing.ts"] },
      { name: "billing", paths: ["**/*-billing-plumbing.ts"] },
    ];
    expect(winnerAt(layers, "services/eu-billing-plumbing.ts")).toBe("billing");
  });
});

describe("a file two layers claim equally is refused, not guessed", () => {
  const gate = (root: string, layers: readonly Layer[]) => {
    const emitted: string[] = [];
    const refusals: string[] = [];
    const code = runLayerGate({
      rootAbsolute: root,
      repoRoot: root,
      layerRulesFile: rulesFile(root, { layers }),
      emit: (payload) => emitted.push(payload),
      report: (m) => refusals.push(m),
      json: false,
      pretty: false,
    });
    return { code, emitted, refusals };
  };

  it("exits 2 naming the file and both patterns, with no report", () => {
    const root = fixtureRepo({
      "src/billing-plumbing.ts": "export const b = 1;\n",
      "src/app.ts": 'import { b } from "./billing-plumbing.js";\nexport const a = b;\n',
    });
    const { code, emitted, refusals } = gate(root, [
      { name: "app", paths: ["src/app.ts"] },
      { name: "plumbing", paths: ["**/*-plumbing.ts"] },
      { name: "billing", paths: ["**/billing-p*.ts"] },
    ]);
    expect(code).toBe(2);
    expect(emitted).toEqual([]);
    expect(refusals).toEqual([
      '"src/billing-plumbing.ts" is claimed equally by layer patterns "**/*-plumbing.ts" and ' +
        '"**/billing-p*.ts"; make one of them more specific.',
    ]);
  });

  it("does not refuse a tie inside one layer", () => {
    const root = fixtureRepo({
      "src/billing-plumbing.ts": "export const b = 1;\n",
      "src/app.ts": 'import { b } from "./billing-plumbing.js";\nexport const a = b;\n',
    });
    const { code, refusals } = gate(root, [
      { name: "app", paths: ["src/app.ts"] },
      { name: "plumbing", paths: ["**/*-plumbing.ts", "**/billing-p*.ts"] },
    ]);
    expect(refusals).toEqual([]);
    expect(code).toBe(0);
  });

  it("does not refuse equally specific patterns that never claim one file", () => {
    const root = fixtureRepo({
      "apps/web/page.ts": 'import { run } from "../cli/run.js";\nexport const page = run;\n',
      "apps/cli/run.ts": "export const run = 1;\n",
    });
    const { code, refusals } = gate(root, [
      { name: "web", paths: ["apps/web"] },
      { name: "cli", paths: ["apps/cli"] },
    ]);
    expect(refusals).toEqual([]);
    expect(code).toBe(0);
  });
});
