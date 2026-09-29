import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadCheapProject } from "../extract/project.js";
import { analyzeLayers, type LayerReport } from "./analyze.js";
import { LayerRulesSchema } from "./rules.js";

const RULES = LayerRulesSchema.parse({
  layers: [
    { name: "ui", paths: ["apps/web/src/ui"] },
    { name: "features", paths: ["apps/web/src/features"] },
    { name: "lib", paths: ["apps/web/src/lib"] },
  ],
});

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

function writeTree(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cg-layer-alias-"));
  roots.push(root);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}

const APP_SOURCES: Record<string, string> = {
  "apps/web/src/ui/page.tsx": [
    'import { invoice } from "@app/features/billing/invoice";',
    'import { total } from "@app/features/billing/total.js";',
    "export const page = invoice + total;",
  ].join("\n"),
  "apps/web/src/features/billing/invoice.ts": [
    'import { money } from "@app/lib/money";',
    'import type { Page } from "@app/ui/page";',
    'import { gone } from "@app/features/billing/gone";',
    "export const invoice = money + gone;",
  ].join("\n"),
  "apps/web/src/features/billing/total.ts": [
    "// line 1",
    'import { page } from "@app/ui/page";',
    'import { money } from "../../lib/money";',
    "export const total = page + money;",
  ].join("\n"),
  "apps/web/src/lib/money.ts": [
    'import fs from "node:fs";',
    'import pad from "left-pad";',
    'import missing from "not-installed";',
    'import { env } from "cloudflare:workers";',
    "export const money = fs + pad + missing + env;",
  ].join("\n"),
  "node_modules/left-pad/package.json": JSON.stringify({ name: "left-pad", main: "index.js" }),
  "node_modules/left-pad/index.js": "module.exports = 1;\n",
};

function analyze(root: string): LayerReport {
  return analyzeLayers(loadCheapProject(root), root, RULES);
}

const EXPECTED_VIOLATIONS = [
  {
    from: "apps/web/src/features/billing/invoice.ts",
    fromLine: 2,
    fromLayer: "features",
    to: "apps/web/src/ui/page.tsx",
    toLine: 1,
    toLayer: "ui",
    specifier: "@app/ui/page",
    typeOnly: true,
  },
  {
    from: "apps/web/src/features/billing/total.ts",
    fromLine: 2,
    fromLayer: "features",
    to: "apps/web/src/ui/page.tsx",
    toLine: 1,
    toLayer: "ui",
    specifier: "@app/ui/page",
    typeOnly: false,
  },
];

describe("a tsconfig `paths` alias is resolved into the repo and judged like a relative import", () => {
  const own = writeTree({
    ...APP_SOURCES,
    "apps/web/tsconfig.json": JSON.stringify({
      compilerOptions: { paths: { "@app/*": ["./src/*"] } },
    }),
  });

  it("reports the upward aliased imports at their real lines and counts the downward ones", () => {
    const report = analyze(own);
    expect(report.violations).toEqual(EXPECTED_VIOLATIONS);
    expect(report.census).toEqual({
      down: 4,
      sideways: 0,
      up: 2,
      unlayered: 0,
      external: 4,
      unresolved: 1,
    });
  });

  it("counts an alias naming no file as UNRESOLVED, listed by site", () => {
    expect(analyze(own).unresolved).toEqual([
      "apps/web/src/features/billing/invoice.ts:3 @app/features/billing/gone",
    ]);
  });

  it("keeps an installed npm package, an uninstalled one, a builtin and a scheme import external", () => {
    const onlyLib = writeTree({
      ...APP_SOURCES,
      "apps/web/tsconfig.json": JSON.stringify({
        compilerOptions: { paths: { "@app/*": ["./src/*"] } },
      }),
      "apps/web/src/ui/page.tsx": "export const page = 1;\n",
      "apps/web/src/features/billing/invoice.ts": "export const invoice = 1;\n",
      "apps/web/src/features/billing/total.ts": "export const total = 1;\n",
    });
    const report = analyze(onlyLib);
    expect(report.census.external).toBe(4);
    expect(report.census.unresolved).toBe(0);
    expect(report.unresolved).toEqual([]);
  });
});

describe("`paths` inherited through `extends` resolves as if declared in place", () => {
  it("gives the same report when the alias lives in a commented base config two levels up", () => {
    const inherited = writeTree({
      ...APP_SOURCES,
      "tsconfig.base.json": [
        "{",
        "  // the alias every app shares",
        '  "compilerOptions": { "paths": { "@app/*": ["./apps/web/src/*"] } },',
        "}",
      ].join("\n"),
      "apps/web/tsconfig.json": JSON.stringify({ extends: "../../tsconfig.base.json" }),
    });
    const own = writeTree({
      ...APP_SOURCES,
      "apps/web/tsconfig.json": JSON.stringify({
        compilerOptions: { paths: { "@app/*": ["./src/*"] } },
      }),
    });
    expect(analyze(inherited)).toEqual(analyze(own));
    expect(analyze(inherited).violations).toEqual(EXPECTED_VIOLATIONS);
  });

  it("lets the importing file's own `paths` replace the inherited set, keys included", () => {
    const overridden = writeTree({
      ...APP_SOURCES,
      "tsconfig.base.json": JSON.stringify({
        compilerOptions: { paths: { "@app/*": ["./apps/web/src/*"] } },
      }),
      "apps/web/tsconfig.json": JSON.stringify({
        extends: "../../tsconfig.base.json",
        compilerOptions: { paths: { "~/*": ["./src/*"] } },
      }),
    });
    const report = analyze(overridden);
    expect(report.violations).toEqual([]);
    expect(report.census).toMatchObject({ down: 1, up: 0, external: 10, unresolved: 0 });
  });
});

describe("with no tsconfig anywhere the census matches the relative-only resolver", () => {
  it("files every bare specifier as external and judges only relative imports", () => {
    const bare = writeTree(APP_SOURCES);
    const report = analyze(bare);
    expect(report.census).toEqual({
      down: 1,
      sideways: 0,
      up: 0,
      unlayered: 0,
      external: 10,
      unresolved: 0,
    });
    expect(report.violations).toEqual([]);
    expect(report.unresolved).toEqual([]);
  });
});
