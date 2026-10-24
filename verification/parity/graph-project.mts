import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

import {
  createModuleResolver,
  createNearestTsconfigResolver,
} from "../../packages/code-graph/src/engine/oxc.js";
import {
  findNearestTsConfig,
  listRepo,
} from "../../packages/code-graph/src/extract/project.js";
import {
  discoverPackageRoots,
  findRepoRoot,
  listSourceFiles,
  listVisibleFiles,
  resolveEdgeTsConfig,
  toRelative,
} from "../../packages/code-graph/src/project.js";

type Case = { id: string; operation: string; input: Record<string, unknown> };
type Answer = {
  id: string | null;
  ok: boolean;
  output?: unknown;
  error?: { kind: string; message: string };
  observedCalls: string[];
};

const listingInput = z.object({
  root: z.string(),
  scope: z.string().optional(),
  sharedListing: z.boolean().optional(),
});
const configInput = z.object({
  root: z.string(),
  repoRoot: z.string(),
  scope: z.enum(["package", "deep"]),
});
const relativeInput = z.object({ root: z.string(), path: z.string() });
const resolverInput = z.object({
  fromFile: z.string(),
  tsConfigPath: z.string().optional(),
  specifiers: z.array(z.string()),
  locate: z.array(z.string()).default([]),
});

const binary = process.argv[2];
assert.ok(
  binary,
  "usage: node --import tsx verification/parity/graph-project.mts <native-driver> [evidence.json]",
);
assert.equal(
  process.version,
  "v22.21.1",
  "use the agreed Node 22.21.1 reference",
);
assert.ok(process.versions.v8.startsWith("12.4."));
const root = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "demlik-project-parity-")),
);
const cases: Case[] = [];

function write(relative: string, body = "export {};\n"): void {
  const absolute = path.join(root, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, body);
}

function reference(item: Case): Answer {
  try {
    let output: unknown;
    switch (item.operation) {
      case "code_graph.project.list": {
        const input = listingInput.parse(item.input);
        const selected = input.scope ?? input.root;
        const listing = input.sharedListing ? listRepo(input.root) : undefined;
        output = {
          visible: listVisibleFiles(selected, () => true, listing),
          sources: listSourceFiles(selected).map((file) =>
            toRelative(selected, file),
          ),
          packageRoots: discoverPackageRoots(selected, listing),
          repoRoot: findRepoRoot(selected),
          nearestTsConfig: findNearestTsConfig(selected),
        };
        break;
      }
      case "code_graph.project.config": {
        const input = configInput.parse(item.input);
        output = resolveEdgeTsConfig(input.root, input.scope, input.repoRoot);
        break;
      }
      case "code_graph.project.relative": {
        const input = relativeInput.parse(item.input);
        output = toRelative(input.root, input.path);
        break;
      }
      case "code_graph.resolve.module": {
        const input = resolverInput
          .extend({ tsConfigPath: z.string() })
          .parse(item.input);
        const resolver = createModuleResolver(input.tsConfigPath);
        output = {
          resolutions: input.specifiers.map((specifier: string) =>
            resolver(input.fromFile, specifier),
          ),
        };
        break;
      }
      case "code_graph.resolve.nearest": {
        const input = resolverInput.parse(item.input);
        const resolver = createNearestTsconfigResolver();
        output = {
          resolutions: input.specifiers.map((specifier: string) =>
            resolver.resolve(input.fromFile, specifier),
          ),
          located: (input.locate ?? []).map((specifier: string) =>
            resolver.locate(path.dirname(input.fromFile), specifier),
          ),
        };
        break;
      }
      default:
        throw new Error(`unsupported operation: ${item.operation}`);
    }
    return { id: item.id, ok: true, output, observedCalls: [] };
  } catch (error) {
    return {
      id: item.id,
      ok: false,
      error: { kind: "driver_error", message: (error as Error).message },
      observedCalls: [],
    };
  }
}

try {
  const walk = path.join(root, "walk");
  for (const file of [
    "src/a.ts",
    "src/B.ts",
    "src/é.ts",
    "src/e.ts",
    "src/-a.ts",
    "src/_a.ts",
    "src/view.tsx",
    "src/api.d.ts",
    "src/skip.gen.ts",
    "src/module.mts",
    "src/readme.md",
    ".hidden.ts",
    ".secret/config.ts",
    "dist/out.ts",
    "node_modules/dep/package.json",
    "vendor/pkg/package.json",
    "coverage/test.ts",
    "packages/app/package.json",
    "packages/app/src/app.ts",
    "packages/lib/package.json",
  ])
    write(`walk/${file}`);
  write("walk/pnpm-workspace.yaml", "packages: ['packages/*']\n");
  write("walk/tsconfig.json", "{}");
  write("walk/packages/app/tsconfig.json", "{}");
  cases.push(
    {
      id: "walk-sources",
      operation: "code_graph.project.list",
      input: { root: walk },
    },
    {
      id: "shared-package-list",
      operation: "code_graph.project.list",
      input: {
        root: walk,
        scope: path.join(walk, "packages/app"),
        sharedListing: true,
      },
    },
    {
      id: "package-config",
      operation: "code_graph.project.config",
      input: {
        root: path.join(walk, "packages/app/src"),
        repoRoot: walk,
        scope: "package",
      },
    },
    {
      id: "deep-config",
      operation: "code_graph.project.config",
      input: {
        root: path.join(walk, "packages/app/src"),
        repoRoot: walk,
        scope: "deep",
      },
    },
    {
      id: "lexical-relative",
      operation: "code_graph.project.relative",
      input: {
        root: path.join(walk, "packages/app/src/.."),
        path: path.join(walk, "packages/lib/missing/../entry.ts"),
      },
    },
  );

  const git = path.join(root, "git");
  for (const file of [
    "src/kept.ts",
    "coverage/visible.ts",
    "ignored/leak.ts",
    "gone.ts",
  ])
    write(`git/${file}`);
  write("git/.gitignore", "ignored/\n");
  execFileSync("git", ["init", "-q"], { cwd: git });
  execFileSync("git", ["add", "gone.ts", "src/kept.ts"], { cwd: git });
  fs.unlinkSync(path.join(git, "gone.ts"));
  cases.push({
    id: "git-visible",
    operation: "code_graph.project.list",
    input: { root: git, sharedListing: true },
  });

  const resolver = path.join(root, "resolution");
  write(
    "resolution/tsconfig.json",
    '{ "extends": "./base.json", "include": ["src"] }',
  );
  write(
    "resolution/base.json",
    '{ // inherited JSONC\n "compilerOptions": { "baseUrl": ".", "paths": { "@app/*": ["src/*"] } },\n }',
  );
  for (const file of [
    "src/main.ts",
    "src/helper.ts",
    "src/view.tsx",
    "src/module.mts",
    "src/common.cts",
    "src/config.json",
    "node_modules/widget/types/index.d.ts",
    "node_modules/widget/esm/index.js",
    "node_modules/widget/src/feature.ts",
  ])
    write(`resolution/${file}`);
  write(
    "resolution/node_modules/widget/package.json",
    JSON.stringify({
      name: "widget",
      exports: {
        ".": {
          types: "./types/index.d.ts",
          import: "./esm/index.js",
          default: "./esm/index.js",
        },
        "./feature": "./src/feature.ts",
      },
    }),
  );
  const fromFile = path.join(resolver, "src/main.ts");
  const specifiers = [
    "@app/helper",
    "./helper.js",
    "./view.jsx",
    "./module.mjs",
    "./common.cjs",
    "./config.json",
    "widget",
    "widget/feature",
    "widget/private",
    "./absent.js",
    "node:fs",
    "",
  ];
  cases.push(
    {
      id: "explicit-resolution",
      operation: "code_graph.resolve.module",
      input: {
        fromFile,
        tsConfigPath: path.join(resolver, "tsconfig.json"),
        specifiers,
      },
    },
    {
      id: "nearest-resolution",
      operation: "code_graph.resolve.nearest",
      input: {
        fromFile,
        specifiers: [...specifiers, "path"],
        locate: ["widget", "@app/helper", "node:fs"],
      },
    },
    {
      id: "missing-tsconfig",
      operation: "code_graph.resolve.module",
      input: {
        fromFile,
        tsConfigPath: path.join(resolver, "absent.json"),
        specifiers: ["./helper"],
      },
    },
  );

  write(
    "references/tsconfig.json",
    '{ "files": [], "references": [{ "path": "./packages/app/tsconfig.project.json" }] }',
  );
  write(
    "references/packages/app/tsconfig.project.json",
    '{ "compilerOptions": { "baseUrl": ".", "paths": { "@local/*": ["src/*"] } }, "include": ["src"] }',
  );
  write("references/packages/app/src/main.ts");
  write("references/packages/app/src/local.ts");
  write(
    "references/packages/lib/package.json",
    '{ "name": "@work/lib", "exports": { ".": "./src/index.ts" } }',
  );
  write("references/packages/lib/src/index.ts");
  fs.mkdirSync(path.join(root, "references/node_modules/@work"), {
    recursive: true,
  });
  fs.symlinkSync(
    path.join(root, "references/packages/lib"),
    path.join(root, "references/node_modules/@work/lib"),
    "dir",
  );
  cases.push({
    id: "references-workspace",
    operation: "code_graph.resolve.nearest",
    input: {
      fromFile: path.join(root, "references/packages/app/src/main.ts"),
      specifiers: ["@local/local", "@work/lib"],
      locate: ["@work/lib", "@local/local"],
    },
  });

  write("malformed/tsconfig.json", '{ "compilerOptions": ');
  write("malformed/src/main.ts");
  write("malformed/src/target.ts");
  cases.push(
    {
      id: "malformed-tsconfig",
      operation: "code_graph.resolve.module",
      input: {
        fromFile: path.join(root, "malformed/src/main.ts"),
        tsConfigPath: path.join(root, "malformed/tsconfig.json"),
        specifiers: ["./target"],
      },
    },
    {
      id: "malformed-nearest",
      operation: "code_graph.resolve.nearest",
      input: {
        fromFile: path.join(root, "malformed/src/main.ts"),
        specifiers: ["./target"],
      },
    },
    {
      id: "missing-directory",
      operation: "code_graph.project.list",
      input: { root: path.join(root, "does-not-exist") },
    },
    {
      id: "missing-edge-config",
      operation: "code_graph.project.config",
      input: { root: git, repoRoot: git, scope: "package" },
    },
  );
  write("bad-package/tsconfig.json", "{}");
  write("bad-package/src/main.ts");
  write("bad-package/node_modules/broken/package.json", '{ "exports": ');
  cases.push({
    id: "malformed-package",
    operation: "code_graph.resolve.module",
    input: {
      fromFile: path.join(root, "bad-package/src/main.ts"),
      tsConfigPath: path.join(root, "bad-package/tsconfig.json"),
      specifiers: ["broken"],
    },
  });

  const expectedSources = [
    "packages/app/src/app.ts",
    "src/_a.ts",
    "src/-a.ts",
    "src/a.ts",
    "src/B.ts",
    "src/e.ts",
    "src/é.ts",
    "src/view.tsx",
  ];
  const references = cases.map(reference);
  const listingAnswer = z.object({
    sources: z.array(z.string()),
    packageRoots: z.array(z.string()),
  });
  const walkAnswer = listingAnswer.parse(
    references.find((answer) => answer.id === "walk-sources")?.output,
  );
  const gitAnswer = listingAnswer.parse(
    references.find((answer) => answer.id === "git-visible")?.output,
  );
  const resolvedAnswer = z
    .object({ resolutions: z.array(z.string().nullable()) })
    .parse(
      references.find((answer) => answer.id === "explicit-resolution")?.output,
    );
  assert.deepEqual(walkAnswer.sources, expectedSources);
  assert.deepEqual(gitAnswer.sources, ["coverage/visible.ts", "src/kept.ts"]);
  assert.deepEqual(walkAnswer.packageRoots, [
    "",
    "packages/app",
    "packages/lib",
  ]);
  assert.deepEqual(
    resolvedAnswer.resolutions.slice(0, 4),
    ["src/helper.ts", "src/helper.ts", "src/view.tsx", "src/module.mts"].map(
      (file) => path.join(resolver, file),
    ),
  );

  const invalid = [
    '{"id":"invalid-input","operation":"code_graph.project.list","input":{}}',
    '{"id":"invalid-scope","operation":"code_graph.project.config","input":{"root":"/","repoRoot":"/","scope":"surprise"}}',
    '{"id":"unknown-operation","operation":"not-implemented","input":{}}',
    "not json",
  ];
  const native = spawnSync(binary, {
    input: `${[...cases.map((item) => JSON.stringify(item)), ...invalid].join("\n")}\n`,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(native.status, 0, native.stderr);
  const answers: Answer[] = native.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(answers.length, cases.length + invalid.length);
  for (const [index, expected] of references.entries()) {
    const actual = answers[index];
    const { observedCalls: _actualCalls, ...actualResult } = actual;
    const { observedCalls: _expectedCalls, ...expectedResult } = expected;
    assert.deepEqual(actualResult, expectedResult, cases[index].id);
    assert.ok(
      actual.observedCalls.length > 0,
      `${actual.id}: no native calls observed`,
    );
    assert.ok(
      actual.observedCalls.every((name) =>
        name.startsWith("demlik_code_graph::"),
      ),
    );
  }
  for (const answer of answers.slice(cases.length)) {
    assert.equal(answer.ok, false);
    assert.ok(answer.error?.message);
    assert.deepEqual(answer.observedCalls, []);
  }
  const evidence = {
    reference: {
      node: process.version,
      v8: process.versions.v8,
      locale: new Intl.Collator().resolvedOptions().locale,
    },
    passed: cases.length,
    rejectedInvalidInputs: invalid.length,
    nativeApis: [
      ...new Set(answers.flatMap((answer) => answer.observedCalls)),
    ].sort(),
    cases: answers,
  };
  if (process.argv[3])
    fs.writeFileSync(process.argv[3], `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify({ ...evidence, cases: undefined }, null, 2));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
