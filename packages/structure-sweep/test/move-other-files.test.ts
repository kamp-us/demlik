import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyHandPlan, applyManifest } from "../src/move/apply.js";
import type { Manifest } from "../src/move/manifest.js";
import { gitIn, repo } from "./helpers.js";

const git = (root: string, ...args: string[]) => gitIn(root, ...args).trim();
const read = (root: string, path: string) =>
  readFileSync(join(root, path), "utf8");

/** TypeScript sources with a JSON fixture and a shell script beside them. */
function tool() {
  return repo({
    "app/tsconfig.json": JSON.stringify({
      compilerOptions: {
        module: "ESNext",
        moduleResolution: "Bundler",
        resolveJsonModule: true,
        strict: true,
      },
      include: ["src"],
    }),
    "app/src/index.ts":
      'import { money } from "./lib/format";\nimport { total } from "./orders/total";\nimport { name } from "./users/name";\n\nexport const receipt = () => [name(), money(total())].join(" ");\n',
    "app/src/lib/format.ts":
      'export const money = (n: number) => "$" + n.toFixed(2);\n',
    "app/src/orders/total.ts":
      'import { money } from "../lib/format";\nimport data from "./fixture.json" with { type: "json" };\n\nexport const total = () => data.amount;\nexport const label = () => money(total());\n',
    "app/src/orders/report.ts":
      'import data from "./fixture.json" with { type: "json" };\n\nexport const report = () => data.amount * 2;\n',
    "app/src/orders/fixture.json": '{ "amount": 3, "currency": "usd" }\n',
    "app/src/users/name.ts":
      'import { money } from "../lib/format";\n\nexport const name = () => ["ada", money(0)].join(" ");\n',
    "app/src/cli.ts":
      'export const script = new URL("./run.sh", import.meta.url);\n',
    "app/src/run.sh": '#!/bin/sh\necho "running the tool"\n',
  });
}

const PLAN = {
  scope: "app",
  moves: [
    { from: "app/src/lib/format.ts", to: "app/src/shared/format.ts" },
    { from: "app/src/orders/total.ts", to: "app/src/billing/total.ts" },
    { from: "app/src/users/name.ts", to: "app/src/accounts/name.ts" },
    {
      from: "app/src/orders/fixture.json",
      to: "app/src/billing/fixture.json",
    },
    { from: "app/src/run.sh", to: "app/tools/run.sh" },
  ],
};

const renameRows = (moves: typeof PLAN.moves) =>
  moves.map((m) => `R100\t${m.from}\t${m.to}`).sort();

describe("move apply with rows naming non-TypeScript files", () => {
  it("renames TS and non-TS rows in one commit, rewrites imports in the next, and is a no-op the second time", () => {
    const root = tool();
    const before = git(root, "rev-parse", "HEAD");

    const report = applyHandPlan(root, PLAN);

    expect(report).toMatchObject({ pending: 5, moved: 5 });
    expect(report.commits.rename).not.toBeNull();
    expect(report.commits.rewrite).toBe(git(root, "rev-parse", "HEAD"));
    expect(git(root, "rev-parse", "HEAD~2")).toBe(before);
    expect(
      git(root, "diff", "--name-status", "-M100%", "HEAD~2", "HEAD~1")
        .split("\n")
        .sort(),
    ).toEqual(renameRows(PLAN.moves));

    expect(read(root, "app/src/index.ts")).toContain('from "./shared/format"');
    expect(read(root, "app/src/index.ts")).toContain('from "./billing/total"');
    expect(read(root, "app/src/index.ts")).toContain('from "./accounts/name"');
    const total = read(root, "app/src/billing/total.ts");
    expect(total).toContain('from "../shared/format"');
    expect(total).toContain('from "./fixture.json" with { type: "json" }');
    expect(read(root, "app/src/orders/report.ts")).toContain(
      'from "../billing/fixture.json" with { type: "json" }',
    );
    expect(git(root, "status", "--porcelain")).toBe("");

    const head = git(root, "rev-parse", "HEAD");
    const again = applyHandPlan(root, PLAN);
    expect(again).toMatchObject({
      pending: 0,
      done: 5,
      commits: { rename: null, rewrite: null },
    });
    expect(git(root, "rev-parse", "HEAD")).toBe(head);
  });

  it("lists a plain-string reference to a moved non-TS file as stale and leaves it unchanged", () => {
    const root = tool();
    const report = applyHandPlan(root, PLAN);

    expect(read(root, "app/src/cli.ts")).toBe(
      'export const script = new URL("./run.sh", import.meta.url);\n',
    );
    expect(report.staleStringRefs).toContain(
      'app/src/cli.ts:1:export const script = new URL("./run.sh", import.meta.url);',
    );
    expect(
      report.staleStringRefs.filter((line) => line.includes("fixture.json")),
    ).toEqual([]);
  });

  it("still moves a `.js` row the allowJs project holds through ts-morph, rewriting its extensionless importers", () => {
    const root = repo({
      "app/tsconfig.json": JSON.stringify({
        compilerOptions: {
          module: "ESNext",
          moduleResolution: "Bundler",
          allowJs: true,
        },
        include: ["src"],
      }),
      "app/src/index.ts":
        'import { util } from "./util";\n\nexport const run = () => util();\n',
      "app/src/util.js": "export const util = () => 1;\n",
      "app/src/run.sh": '#!/bin/sh\necho "running the tool"\n',
    });
    const plan = {
      scope: "app",
      moves: [
        { from: "app/src/util.js", to: "app/src/shared/util.js" },
        { from: "app/src/run.sh", to: "app/tools/run.sh" },
      ],
    };

    const report = applyHandPlan(root, plan);

    expect(report.commits.rename).not.toBeNull();
    expect(report.commits.rewrite).toBe(git(root, "rev-parse", "HEAD"));
    expect(
      git(root, "diff", "--name-status", "-M100%", "HEAD~2", "HEAD~1")
        .split("\n")
        .sort(),
    ).toEqual(renameRows(plan.moves));
    expect(read(root, "app/src/index.ts")).toContain('from "./shared/util"');
    expect(git(root, "status", "--porcelain")).toBe("");
  });

  it("applies a manifest of only non-TS rows as the rename commit and no rewrite commit", () => {
    const root = repo({
      "app/tsconfig.json": JSON.stringify({ include: ["src"] }),
      "app/src/index.ts": "export const one = 1;\n",
      "app/src/run.sh": '#!/bin/sh\necho "running the tool"\n',
      "app/src/fixture.json": '{ "amount": 3 }\n',
    });
    const before = git(root, "rev-parse", "HEAD");
    const row = (from: string, to: string) => ({
      from,
      to,
      feature: "tools",
      role: "script",
      confidence: 0.9,
    });
    const manifest: Manifest = {
      scope: "app",
      features: ["tools"],
      floor: 0.8,
      moves: [
        row("app/src/run.sh", "app/tools/run.sh"),
        row("app/src/fixture.json", "app/fixtures/fixture.json"),
      ],
      review: [],
      pinned: [],
    };

    const report = applyManifest(root, manifest);

    expect(report.commits.rewrite).toBeNull();
    expect(report.commits.rename).toBe(git(root, "rev-parse", "HEAD"));
    expect(git(root, "rev-parse", "HEAD~1")).toBe(before);
    expect(
      git(root, "diff", "--name-status", "-M100%", "HEAD~1", "HEAD")
        .split("\n")
        .sort(),
    ).toEqual(renameRows(manifest.moves));
    expect(report.staleStringRefs).toEqual([]);
    expect(git(root, "status", "--porcelain")).toBe("");
  });
});
