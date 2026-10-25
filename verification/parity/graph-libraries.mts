import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  importedFromOutside,
  importTargetOf,
  inPackageGlobs,
  isWorldLibrary,
  libraryScopes,
  libraryTypeOf,
  ownerOf,
  readLibraries,
  undeclaredUnder,
} from "../../packages/code-graph/src/boundaries/libraries/libraries.js";
import { BoundaryRulesSchema } from "../../packages/code-graph/src/boundaries/rules.js";
import { globToRegExp } from "../../packages/code-graph/src/kinds/glob.js";
import {
  matchPackage,
  workspacePackages,
} from "../../packages/code-graph/src/layers/resolve-target.js";

const binary = process.argv[2];
assert.ok(binary, "provide the compiled libraries driver");
assert.equal(process.version, "v22.21.1");
assert.equal(process.versions.v8, "12.4.254.21-node.33");
const stringList = z.array(z.string());
const zone = z.enum(["driven", "configurator", "any"]).nullable();
const librariesInput = z
  .object({
    repoRoot: z.string(),
    rules: z.unknown(),
    listing: stringList.optional(),
    files: stringList,
    specifiers: stringList,
    dirs: stringList,
    zones: z.array(zone),
    roots: stringList,
  })
  .strict();
const caseSchema = z.discriminatedUnion("operation", [
  z
    .object({
      id: z.string(),
      operation: z.literal("code_graph.libraries"),
      input: librariesInput,
    })
    .strict(),
  z
    .object({
      id: z.string(),
      operation: z.literal("code_graph.workspace-packages"),
      input: z
        .object({
          repoRoot: z.string(),
          dirs: stringList,
          specifiers: stringList,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      id: z.string(),
      operation: z.literal("code_graph.package-globs"),
      input: z
        .object({ patterns: stringList, specifiers: stringList })
        .strict(),
    })
    .strict(),
]);
type Case = z.infer<typeof caseSchema>;
const directory = fs.mkdtempSync(path.join(tmpdir(), "demlik-library-parity-"));
try {
  const repo = path.join(directory, "repo");
  fs.mkdirSync(repo);
  const files: Record<string, string> = {
    "package.json": '{"name":"repo-root"}',
    "packages/core/package.json":
      '{"name":"@shop/core","source":"src/index.ts"}',
    "packages/core/src/index.ts": "export const core = 1;",
    "packages/core/nested/package.json": '{"name":"@shop/nested"}',
    "packages/ui/package.json": '{"name":"@shop/ui"}',
    "packages/free/package.json": '{"name":"free"}',
    "packages/duplicate/package.json": '{"name":"@shop/core"}',
    "packages/zeta/package.json": '{"name":"zeta"}',
    "packages/Alpha/package.json": '{"name":"alpha"}',
    "packages/á/package.json": '{"name":"accent"}',
    "packages/😀/package.json": '{"name":"emoji"}',
    "packages/longer/package.json": '{"name":"longer"}',
    "elsewhere/package.json":
      '{"name":"@elsewhere/pkg","exports":{".":"./entry.ts"}}',
    "elsewhere/entry.ts": "export const other=2;",
    "invalid/package.json": "{",
    "noname/package.json": "{}",
    "emptyname/package.json": '{"name":""}',
    "numbername/package.json": '{"name":2}',
    "rawname/package.json": '{"name":"raw\\ud800"}',
    "odd/name/package.json": '{"name":"@odd"}',
    "odd/sub/package.json": '{"name":"@odd/pkg/sub"}',
    "proto/package.json":
      '{"__proto__":{"name":"inherited"},"main":"entry.ts"}',
    "proto/entry.ts": "export {};",
    "single.ts": "export {};",
    "node_modules/excluded/package.json": '{"name":"excluded"}',
  };
  for (const [file, source] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    fs.writeFileSync(path.join(repo, file), source);
  }
  const packageDirs = Object.keys(files)
    .filter((file) => file.endsWith("package.json"))
    .map((file) => path.posix.dirname(file));
  const specifiers = [
    "@shop/core",
    "@shop/core/private/path",
    "@shop/corex",
    "@shop/nested",
    "@shop/ui",
    "free",
    "free/a/b",
    "zeta",
    "@elsewhere/pkg/sub",
    "unknown",
    "@odd",
    "@odd/pkg",
    "@odd/pkg/sub",
    "@odd/pkg/sub/more",
    "raw\ud800/sub",
    "./free",
    "/free",
    "",
    "node:fs",
    "@sentry/node/integrations",
    "@sentryx/node",
  ];
  const queryFiles = [
    "packages/core",
    "packages/core/src/a.ts",
    "packages/core/nested/a.ts",
    "packages/corex/a.ts",
    "packages/ui/src/a.ts",
    "packages/😀/a.ts",
    "packages/á/a.ts",
    "packages/free/src/a.ts",
    "packages/core/\ud800.ts",
    "/packages/core/a.ts",
    "",
  ];
  const queryDirs = [
    "packages/core",
    "packages/core/nested",
    "packages/ui",
    "packages/free",
    "missing",
    "\ud800",
  ];
  const roots = [".", "packages", "packages/core", "elsewhere", "missing"];
  const baseRules = {
    libraryTypes: {
      kernel: { imports: ["kernel"], pure: true },
      ui: { imports: ["kernel"], pure: false, importedFrom: ["configurator"] },
      adapter: { imports: [], pure: false, importedFrom: ["driven"] },
      any: { imports: [], pure: true, importedFrom: ["any"] },
    },
    libraries: {
      "packages/core": "kernel",
      "packages/core/nested": "adapter",
      "packages/ui": "ui",
    },
    libraryRoots: [".", "packages", "packages/core"],
    worldLibraries: ["@sentry/*", "node:*", "free"],
  };
  const cases: Case[] = [];
  const add = (
    id: string,
    rules: unknown,
    options: Partial<z.infer<typeof librariesInput>> = {},
  ) =>
    cases.push(
      caseSchema.parse({
        id,
        operation: "code_graph.libraries",
        input: {
          repoRoot: repo,
          rules,
          files: queryFiles,
          specifiers,
          dirs: queryDirs,
          zones: [null, "driven", "configurator", "any"],
          roots,
          ...options,
        },
      }),
    );
  add("libraries.real-packages-and-nearest-owner", baseRules);
  add("libraries.explicit-listing", baseRules, {
    listing: Object.keys(files).filter(
      (file) => !file.startsWith("node_modules/"),
    ),
  });
  add(
    "libraries.no-rules-no-filesystem",
    {},
    { repoRoot: path.join(directory, "missing") },
  );
  for (const [index, rules] of [
    { libraryTypes: baseRules.libraryTypes },
    { libraries: baseRules.libraries },
    { libraryRoots: ["packages"] },
    { worldLibraries: ["free"] },
    { allowImportNames: { "packages/core": { "packages/ui": ["Thing"] } } },
    { features: { app: ["orders"] } },
    {
      libraryTypes: { adapter: baseRules.libraryTypes.adapter },
      libraries: { "packages/ui": "adapter" },
    },
    {
      libraryTypes: { any: baseRules.libraryTypes.any },
      libraries: { "packages/core": "any" },
    },
    {
      libraryTypes: {
        ui: {
          imports: [],
          pure: true,
          importedFrom: ["driven", "configurator"],
        },
      },
      libraries: { "packages/ui": "ui" },
    },
    {
      libraries: {
        "packages/😀": "missing",
        "packages/á": "missing",
        "packages/longer": "missing",
        "packages/core": "missing",
      },
    },
    {
      libraries: {
        "packages/core/nested": "missing",
        "packages/core": "missing",
      },
    },
    { libraries: { "packages/free": "toString" } },
  ].entries())
    add(`libraries.keys-${index}`, rules);
  for (const root of [
    "packages/",
    "./packages",
    "packages/../packages",
    "packages//core",
    "..",
    "../repo",
    "..pkg",
    "single.ts",
    "missing",
    "\ud800",
    "a\0b",
    "/packages",
    ".",
    "packages/core",
  ])
    add(`libraries.root-${JSON.stringify(root)}`, {
      ...baseRules,
      libraryRoots: [root],
    });
  for (const dir of [
    "",
    ".",
    "packages",
    "packages/unknown",
    "./packages/core",
    "packages/core/",
    "node_modules/excluded",
    "\ud800",
    "single.ts",
  ])
    add(`libraries.declared-${JSON.stringify(dir)}`, {
      libraryTypes: baseRules.libraryTypes,
      libraries: { [dir]: "kernel" },
    });
  add("libraries.first-refusal-root-before-library", {
    libraryRoots: ["missing", "also-missing"],
    libraries: { "not-package": "kernel" },
    worldLibraries: ["{"],
  });
  add("libraries.first-refusal-library-before-glob", {
    libraries: { "not-package": "kernel" },
    worldLibraries: ["{"],
  });
  add("libraries.invalid-world-glob", { worldLibraries: ["{a"] });
  add("libraries.invalid-raw-world-glob", { worldLibraries: ["\ud800{"] });
  add("libraries.unknown-type-null", {
    libraries: { "packages/core": "unknown" },
  });
  add("libraries.only-listed-packages", baseRules, {
    listing: [
      "packages/core/package.json",
      "packages/ui/package.json",
      "packages/core/nested/package.json",
    ],
  });
  add("libraries.empty-listing-refuses", baseRules, { listing: [] });
  for (const rules of [
    null,
    [],
    { unknown: true },
    { libraryRoots: [""] },
    { libraryTypes: { x: { imports: [], pure: 1 } } },
    { libraryTypes: { x: { imports: [], pure: true, importedFrom: [] } } },
  ])
    add(`libraries.input-${cases.length}`, rules);
  for (const [index, dirs] of [
    packageDirs,
    [...packageDirs].reverse(),
    [
      "",
      "packages/duplicate",
      "packages/core",
      "missing",
      "invalid",
      "rawname",
    ],
    ["proto", "numbername", "emptyname", "noname", "odd/name", "odd/sub"],
  ].entries())
    cases.push(
      caseSchema.parse({
        id: `packages.order-${index}`,
        operation: "code_graph.workspace-packages",
        input: { repoRoot: repo, dirs, specifiers },
      }),
    );
  for (const patterns of [
    [],
    ["*"],
    ["**"],
    ["@sentry/*"],
    ["@sentry/**"],
    ["node:*"],
    ["free"],
    ["@odd"],
    ["@odd/pkg"],
    ["@{shop,sentry}/*"],
    ["?"],
    ["raw\ud800"],
    ["{a"],
    ["}"],
    [","],
  ])
    cases.push(
      caseSchema.parse({
        id: `package-globs-${JSON.stringify(patterns)}`,
        operation: "code_graph.package-globs",
        input: { patterns, specifiers },
      }),
    );
  const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
  add(
    "libraries.actual-monorepo",
    {
      libraryTypes: { kernel: { imports: [], pure: true } },
      libraries: { "packages/tea": "kernel" },
      libraryRoots: ["packages"],
    },
    {
      repoRoot,
      files: ["packages/tea/src/index.ts", "packages/code-graph/src/index.ts"],
      specifiers: ["@demlik/tea", "@demlik/tea/flow", "@demlik/code-graph"],
      dirs: ["packages/tea"],
      roots: ["packages"],
    },
  );
  const expected = cases.map((item) => {
    try {
      let output: unknown;
      if (item.operation === "code_graph.package-globs")
        output = item.input.specifiers.map((specifier) =>
          inPackageGlobs(item.input.patterns.map(globToRegExp), specifier),
        );
      else if (item.operation === "code_graph.workspace-packages") {
        const packages = workspacePackages(
          item.input.repoRoot,
          item.input.dirs,
        );
        output = {
          packages: [...packages],
          matches: item.input.specifiers.map(
            (specifier) => matchPackage(specifier, packages) ?? null,
          ),
        };
      } else {
        const input = item.input,
          parsed = BoundaryRulesSchema.safeParse(input.rules);
        if (!parsed.success)
          output = {
            inputIssue: {
              path: parsed.error.issues[0].path,
              message: parsed.error.issues[0].message,
            },
          };
        else {
          const result = readLibraries(
            parsed.data,
            input.repoRoot,
            input.listing === undefined
              ? undefined
              : { root: input.repoRoot, files: input.listing },
          );
          if (result.kind === "refused") output = result;
          else {
            const libraries = result.libraries;
            output = {
              kind: "read",
              declared: libraries.declared,
              dirs: libraries.dirs,
              typeOfDir: [...libraries.typeOfDir],
              packages: [...libraries.packages],
              packageDirs: libraries.packageDirs,
              scopes: libraryScopes(libraries),
              owners: input.files.map((file) => ownerOf(libraries, file)),
              targets: input.specifiers.map((specifier) =>
                importTargetOf(libraries, specifier),
              ),
              world: input.specifiers.map((specifier) =>
                isWorldLibrary(libraries, specifier),
              ),
              types: input.dirs.map((dir) => libraryTypeOf(libraries, dir)),
              outside: input.dirs.map((dir) =>
                input.zones.map((zone) =>
                  importedFromOutside(libraries, dir, zone),
                ),
              ),
              undeclared: input.roots.map((root) =>
                undeclaredUnder(libraries, root),
              ),
            };
          }
        }
      }
      return JSON.parse(JSON.stringify({ id: item.id, ok: true, output }));
    } catch (error) {
      assert.ok(error instanceof Error);
      return {
        id: item.id,
        ok: true,
        output: { thrown: { name: error.name, message: error.message } },
      };
    }
  });
  const invalid = [
    "not json",
    JSON.stringify({ id: "unsupported", operation: "other", input: {} }),
    JSON.stringify({
      id: "missing",
      operation: "code_graph.libraries",
      input: {},
    }),
    JSON.stringify({
      id: "unknown",
      operation: "code_graph.package-globs",
      input: { patterns: [], specifiers: [], unknown: true },
    }),
  ];
  const run = spawnSync(binary, [], {
    input: `${[...cases.map((item) => JSON.stringify(item)), ...invalid].join("\n")}\n`,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: 30000,
  });
  assert.equal(run.status, 0, run.stderr);
  const response = z.object({
    id: z.string().nullable(),
    ok: z.boolean(),
    output: z.unknown().optional(),
    error: z.string().optional(),
    diagnostic: z.string().optional(),
    observedCalls: z.array(z.string()),
  });
  const answers = run.stdout
    .trim()
    .split("\n")
    .map((line) => response.parse(JSON.parse(line)));
  assert.equal(answers.length, cases.length + invalid.length);
  const failures: {
    id: string;
    message: string;
    reference: unknown;
    native: unknown;
  }[] = [];
  for (const [index, reference] of expected.entries()) {
    try {
      const { observedCalls: _calls, ...actual } = answers[index];
      assert.deepEqual(actual, reference, cases[index].id);
      if (
        !cases[index].id.startsWith("package-globs-") ||
        !JSON.stringify(reference).includes('"thrown"')
      )
        assert.ok(answers[index].observedCalls.length);
    } catch (error) {
      failures.push({
        id: cases[index].id,
        message: error instanceof Error ? error.message : String(error),
        reference,
        native: answers[index],
      });
    }
  }
  for (const answer of answers.slice(cases.length)) {
    assert.equal(answer.ok, false);
    assert.equal(answer.error, "driver_error");
    assert.ok(answer.diagnostic);
    assert.deepEqual(answer.observedCalls, []);
  }
  const baseline = expected.find(
    (item) => item.id === "libraries.real-packages-and-nearest-owner",
  );
  assert.ok(baseline);
  assert.equal(baseline.output.owners[2], "packages/core/nested");
  assert.deepEqual(baseline.output.targets[1], {
    kind: "library",
    dir: "packages/core",
    type: "kernel",
  });
  const report = {
    reference: { node: process.version, v8: process.versions.v8 },
    passed: cases.length - failures.length,
    attempted: cases.length,
    failures,
    rejectedInvalidInputs: invalid.length,
    cases: answers,
    qualifications: [
      "Workspace package lookup and library reads use real manifests and shared file listings. Full file/tsconfig target resolution, library verdicts and allowance census are separate scopes.",
    ],
  };
  if (process.argv[3])
    fs.writeFileSync(process.argv[3], `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    JSON.stringify(
      { ...report, cases: undefined, failures: failures.slice(0, 4) },
      null,
      2,
    ),
  );
  if (failures.length) process.exitCode = 1;
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
