import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { detectImpureUses } from "../../packages/code-graph/src/boundaries/impure-uses.js";
import {
  allowanceIssue,
  importedNamesFor,
  isLicensed,
} from "../../packages/code-graph/src/boundaries/libraries/allowance.js";
import {
  censusLines,
  libraryCensus,
} from "../../packages/code-graph/src/boundaries/libraries/census.js";
import { readLibraries } from "../../packages/code-graph/src/boundaries/libraries/libraries.js";
import {
  judgeLibraries,
  undeclaredLibraries,
} from "../../packages/code-graph/src/boundaries/libraries/violations.js";
import { BoundaryRulesSchema } from "../../packages/code-graph/src/boundaries/rules.js";
import {
  importLiterals,
  runtimeSpecifiers,
} from "../../packages/code-graph/src/syntax/imports.js";
import { sourceUnit } from "../../packages/code-graph/src/test-helpers/source-unit.js";

const binary = process.argv[2];
assert.ok(binary, "provide the compiled library driver");
assert.equal(process.version, "v22.21.1");
assert.equal(process.versions.v8, "12.4.254.21-node.33");
const directory = fs.mkdtempSync(
  path.join(tmpdir(), "demlik-library-judgments-"),
);
try {
  const repo = path.join(directory, "repo");
  const packages = [
    ["packages/core", "@shop/core"],
    ["packages/core/nested", "@shop/nested"],
    ["packages/adapter", "@shop/adapter"],
    ["packages/ui", "@shop/ui"],
    ["packages/free", "@shop/free"],
    ["packages/other", "@shop/other"],
    ["toString", "special"],
    ["prototype", "prototype"],
  ] as const;
  for (const [dir, name] of packages) {
    fs.mkdirSync(path.join(repo, dir), { recursive: true });
    fs.writeFileSync(
      path.join(repo, dir, "package.json"),
      JSON.stringify({ name }),
    );
  }
  const text = z.string(),
    strings = z.array(text);
  const sourceFile = z.object({ file: text, source: text }).strict();
  const inputSchema = z
    .object({
      repoRoot: text,
      rules: z.unknown(),
      scope: text,
      file: text,
      source: text,
      namedFiles: z.array(sourceFile),
      licenseDir: text,
      licenseSpecifiers: strings,
      measuredScopes: strings,
      measuredUndeclared: strings,
      unjudged: z.number().int().nonnegative(),
      roots: strings,
      zone: z.enum(["driven", "configurator", "any"]).nullable(),
    })
    .strict();
  type Input = z.infer<typeof inputSchema>;
  const cases: {
    id: string;
    operation: "code_graph.library-judgment";
    input: Input;
  }[] = [];
  const rules = {
    libraryTypes: {
      core: { imports: [], pure: true },
      adapter: { imports: ["core"], pure: false, importedFrom: ["driven"] },
      ui: { imports: ["core"], pure: false, importedFrom: ["configurator"] },
      unused: { imports: [], pure: true },
    },
    libraries: {
      "packages/core": "core",
      "packages/core/nested": "adapter",
      "packages/adapter": "adapter",
      "packages/ui": "ui",
    },
    libraryRoots: ["packages", "packages/core"],
    worldLibraries: ["node:*", "@world/*"],
  };
  const input: Input = {
    repoRoot: repo,
    rules,
    scope: "packages/core",
    file: "packages/core/src/a.ts",
    source:
      "import {A} from '@shop/adapter'; import type {B} from '@shop/adapter/sub'; import {F} from '@shop/free'; import {G} from '@shop/free/sub'; import fs from 'node:fs'; console.log('x'); Date.now();",
    namedFiles: [
      {
        file: "src/a.ts",
        source:
          "import {A} from '@shop/adapter'; import type {B} from '@shop/adapter/sub';",
      },
    ],
    licenseDir: "packages/adapter",
    licenseSpecifiers: ["@shop/adapter", "@shop/adapter/sub"],
    measuredScopes: ["packages/core", "packages/adapter", "packages/ui"],
    measuredUndeclared: [
      "packages/zeta",
      "packages/Alpha",
      "packages/á",
      "packages/😀",
      "packages/Alpha",
    ],
    unjudged: 2,
    roots: ["packages", "packages/core", "."],
    zone: null,
  };
  const add = (id: string, patch: Partial<Input> = {}) =>
    cases.push({
      id,
      operation: "code_graph.library-judgment",
      input: inputSchema.parse({ ...input, ...patch }),
    });
  add("library-judgment.precedence-and-impurity");
  add("library-judgment.feature-counts-no-unjudged", {
    scope: "apps/api",
    file: "apps/api/src/a.ts",
  });
  add("library-judgment.nested-library-skips-parent", {
    file: "packages/core/nested/src/a.ts",
  });
  add("library-judgment.nested-own-scope", {
    scope: "packages/core/nested",
    file: "packages/core/nested/src/a.ts",
  });
  add("library-judgment.same-library-import", {
    source: "import {A} from '@shop/core'; import {B} from '@shop/core/sub';",
  });
  for (const zone of [null, "driven", "configurator", "any"] as const) {
    for (const imports of [[], ["adapter"]]) {
      const types = { ...rules.libraryTypes, core: { imports, pure: false } };
      add(`library-judgment.barred-${zone}-${imports.length}`, {
        zone,
        rules: { ...rules, libraryTypes: types },
      });
    }
  }
  const allowance = { "packages/core": { "packages/adapter": ["A", "B"] } };
  add("library-judgment.allowed-all-names", {
    rules: { ...rules, allowImportNames: allowance },
    zone: "driven",
  });
  add("library-judgment.allowance-still-checks-zone", {
    rules: { ...rules, allowImportNames: allowance },
    zone: null,
  });
  add("library-judgment.allowance-misses-subpath", {
    rules: { ...rules, allowImportNames: allowance },
    source:
      "import {A} from '@shop/adapter'; import {C} from '@shop/adapter/sub';",
  });
  add("library-judgment.allowance-unreadable", {
    rules: { ...rules, allowImportNames: allowance },
    source: "import * as ns from '@shop/adapter';",
  });
  add("library-judgment.allowance-default", {
    rules: { ...rules, allowImportNames: allowance },
    source: "import value from '@shop/adapter';",
  });
  add("library-judgment.allowance-dynamic", {
    rules: { ...rules, allowImportNames: allowance },
    source: "import('@shop/adapter');",
  });
  add("library-judgment.allowance-export-all", {
    rules: { ...rules, allowImportNames: allowance },
    source: "export * from '@shop/adapter';",
  });
  add("library-judgment.allowance-empty-names", {
    rules: { ...rules, allowImportNames: allowance },
    source: "import {} from '@shop/adapter';",
    licenseSpecifiers: ["@shop/adapter"],
  });
  add("library-judgment.allowance-no-specifiers", {
    rules: { ...rules, allowImportNames: allowance },
    licenseSpecifiers: [],
  });
  add("library-judgment.allowance-no-declaration", { licenseSpecifiers: [] });
  add("library-judgment.allowance-stale-name", {
    rules: {
      ...rules,
      allowImportNames: {
        "packages/core": { "packages/adapter": ["A", "Never", "B"] },
      },
    },
  });
  add("library-judgment.allowance-stale-first-directory", {
    rules: {
      ...rules,
      allowImportNames: {
        "packages/core": {
          "packages/ui": ["UI"],
          "packages/adapter": ["Never"],
        },
      },
    },
  });
  add("library-judgment.allowance-nested-file-not-owned", {
    rules: { ...rules, allowImportNames: allowance },
    namedFiles: [
      { file: "nested/a.ts", source: "import {A,B} from '@shop/adapter';" },
    ],
  });
  add("library-judgment.allowance-split-files", {
    rules: { ...rules, allowImportNames: allowance },
    namedFiles: [
      { file: "a.ts", source: "import {A} from '@shop/adapter';" },
      { file: "b.ts", source: "import {B} from '@shop/adapter/sub';" },
    ],
  });
  add("library-judgment.allowance-self-import-does-not-license", {
    rules: {
      ...rules,
      allowImportNames: { "packages/core": { "packages/core": ["A"] } },
    },
    namedFiles: [{ file: "a.ts", source: "import {A} from '@shop/core';" }],
  });
  for (const source of [
    "import type {A} from '@shop/adapter'; import type {B} from '@shop/adapter/sub';",
    "import type {A} from '@shop/adapter'; import {B} from '@shop/adapter';",
    "import '@world/a'; import type {B} from '@world/a';",
    "import type {B} from '@world/a'; import '@world/a';",
    "import type {Stats} from 'node:fs';",
    "import {type Stats} from 'node:fs';",
    "console.log('a'); console.log('b'); fetch('x'); fetch('y');",
    "const console={log(){}}; console.log();",
    "const fetch=()=>1; fetch();",
    "export {A} from '@shop/adapter/sub'; export type {B} from '@shop/adapter';",
  ].entries())
    add(`library-judgment.syntax-${source[0]}`, { source: source[1] });
  for (const type of ["missing", "toString", "__proto__", "constructor"])
    add(`library-judgment.type-${type}`, {
      rules: {
        ...rules,
        libraries: { ...rules.libraries, "packages/core": type },
      },
    });
  add("library-judgment.inherited-scope-names", {
    scope: "toString",
    file: "toString/a.ts",
    rules: {
      libraryTypes: { x: { imports: [], pure: true } },
      libraries: { toString: "x" },
    },
  });
  add("library-judgment.inherited-license", {
    rules: {
      ...rules,
      libraries: { ...rules.libraries, toString: "adapter" },
      allowImportNames: { "packages/core": { "packages/ui": ["UI"] } },
    },
    source: "import {A} from 'special';",
    licenseDir: "toString",
    licenseSpecifiers: ["special"],
  });
  add("library-judgment.inherited-license-empty-names", {
    rules: {
      ...rules,
      libraries: { ...rules.libraries, toString: "adapter" },
      allowImportNames: { "packages/core": { "packages/ui": ["UI"] } },
    },
    source: "import {} from 'special';",
    licenseDir: "toString",
    licenseSpecifiers: ["special"],
  });
  add("library-judgment.no-library-declarations", {
    rules: {},
    measuredScopes: [],
    measuredUndeclared: [],
  });
  add("library-judgment.no-type-census", {
    rules: { libraryRoots: ["packages"] },
    unjudged: 1,
  });
  add("library-judgment.numeric-and-raw-type-names", {
    rules: {
      ...rules,
      libraryTypes: {
        "10": { imports: [], pure: true },
        "2": { imports: [], pure: false },
        __proto__: { imports: [], pure: true },
        "\ud800": { imports: [], pure: true },
        Á: { imports: [], pure: true },
        a: { imports: [], pure: true },
      },
      libraries: {
        "packages/core": "10",
        "packages/ui": "2",
        "packages/adapter": "\ud800",
      },
    },
    unjudged: 0,
  });
  add("library-judgment.empty-measured-scopes", {
    measuredScopes: [],
    measuredUndeclared: [],
    unjudged: 0,
  });
  for (let seed = 0; seed < 12; seed++) {
    const sub = seed % 3;
    add(`library-judgment.generated-${seed}`, {
      source: `import ${seed % 2 ? "type " : ""}{A} from '@shop/adapter${sub ? `/sub${sub}` : ""}'; ${seed % 4 === 0 ? "Date.now();" : ""}`,
      zone: seed % 2 ? "driven" : null,
      unjudged: seed,
      measuredScopes: seed % 3 ? ["packages/core", "packages/adapter"] : [],
      rules: seed % 2 ? { ...rules, allowImportNames: allowance } : rules,
    });
  }
  const inheritedScopes = Object.getOwnPropertyNames(Object.prototype);
  const fields = [
    "name",
    "length",
    "caller",
    "arguments",
    "prototype",
    "callee",
    "apply",
    "bind",
    "call",
    "__proto__",
    "constructor",
    "missing",
  ];
  for (const dir of new Set([...inheritedScopes, ...fields])) {
    const manifest = path.join(repo, dir, "package.json");
    if (!fs.existsSync(manifest)) {
      fs.mkdirSync(path.dirname(manifest), { recursive: true });
      fs.writeFileSync(manifest, JSON.stringify({ name: `@meta/${dir}` }));
    }
  }
  const packageName = (dir: string) =>
    z
      .object({ name: z.string() })
      .parse(
        JSON.parse(
          fs.readFileSync(path.join(repo, dir, "package.json"), "utf8"),
        ),
      ).name;
  const inheritedCase = (
    scope: string,
    dir: string,
    taken: string,
    empty = false,
  ) => {
    const libraries = Object.fromEntries(
      [
        [scope, "low"],
        [dir, "high"],
      ].filter(([key]) => key !== "constructor"),
    );
    const specifier = packageName(dir);
    add(
      `library-judgment.inherited-${scope}-${dir}-${JSON.stringify(taken)}-${empty}`,
      {
        rules: {
          libraryTypes: {
            low: { imports: [], pure: false },
            high: { imports: [], pure: false },
          },
          libraries,
        },
        scope,
        file: `${scope}/a.ts`,
        source: `import { ${JSON.stringify(taken)} as value } from ${JSON.stringify(specifier)};`,
        namedFiles: [],
        licenseDir: dir,
        licenseSpecifiers: empty ? [] : [specifier],
        measuredScopes: [scope, dir],
        measuredUndeclared: [],
        unjudged: 0,
        roots: [],
      },
    );
  };
  for (const scope of [
    "toString",
    "hasOwnProperty",
    "constructor",
    "__proto__",
  ]) {
    for (const dir of fields) inheritedCase(scope, dir, scope);
    inheritedCase(scope, "caller", scope, true);
  }
  for (const scope of inheritedScopes)
    inheritedCase(scope, "name", scope === "constructor" ? "Object" : scope);
  for (const name of ["String", "to", "", "absent"])
    inheritedCase("toString", "name", name);
  add("library-judgment.own-allowance-shadows-inherited-name", {
    rules: {
      libraryTypes: {
        low: { imports: [], pure: false },
        high: { imports: [], pure: false },
      },
      libraries: { toString: "low", name: "high" },
      allowImportNames: { toString: { name: ["toString"] } },
    },
    scope: "toString",
    file: "toString/a.ts",
    source: 'import { "String" as value } from "@meta/name";',
    namedFiles: [],
    licenseDir: "name",
    licenseSpecifiers: ["@meta/name"],
    measuredScopes: [],
    measuredUndeclared: [],
    roots: [],
  });
  const checked = (run: () => unknown) => {
    try {
      return run();
    } catch (error) {
      assert.ok(error instanceof Error);
      return { thrown: { name: error.name, message: error.message } };
    }
  };
  const expected = cases.map(({ id, input }) => {
    const result = readLibraries(
      BoundaryRulesSchema.parse(input.rules),
      input.repoRoot,
      undefined,
    );
    assert.equal(result.kind, "read");
    if (result.kind !== "read") throw new Error("fixture refused");
    const libraries = result.libraries,
      syntax = sourceUnit(input.source, input.file).syntax;
    const importedNames = importedNamesFor(libraries, input.scope, syntax);
    const file = {
      file: input.file,
      importedNames,
      importEdges: importLiterals(syntax).map(
        ({ specifier, kind, typeOnly }) => ({
          specifier,
          kind,
          typeOnly,
          target: null,
        }),
      ),
      impureUses: detectImpureUses(syntax),
      runtimeSpecifiers: runtimeSpecifiers(syntax),
    };
    const named = input.namedFiles.map((file) => ({
      file: file.file,
      importedNames: importedNamesFor(
        libraries,
        input.scope,
        sourceUnit(file.source, file.file).syntax,
      ),
    }));
    const census = libraryCensus(libraries, {
      scopes: input.measuredScopes,
      undeclared: input.measuredUndeclared,
      unjudged: input.unjudged,
    });
    return JSON.parse(
      JSON.stringify({
        id,
        ok: true,
        output: {
          names: [...importedNames].map(([specifier, imported]) => [
            specifier,
            { names: [...imported.names], unreadable: imported.unreadable },
          ]),
          licensed: checked(() =>
            isLicensed(
              libraries,
              input.scope,
              input.licenseDir,
              new Set(input.licenseSpecifiers),
              file,
            ),
          ),
          allowanceIssue: allowanceIssue(libraries, input.scope, named),
          judgment: checked(() =>
            judgeLibraries(libraries, input.scope, file, input.zone),
          ),
          undeclared: input.roots.map((root) =>
            undeclaredLibraries(libraries, root),
          ),
          census,
          lines: census === null ? null : censusLines(census),
        },
      }),
    );
  });
  const invalid = [
    JSON.stringify({
      id: "missing-judgment",
      operation: "code_graph.library-judgment",
      input: {},
    }),
    JSON.stringify({
      id: "negative-count",
      operation: "code_graph.library-judgment",
      input: { ...input, unjudged: -1 },
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
    id: text.nullable(),
    ok: z.boolean(),
    output: z.unknown().optional(),
    error: text.optional(),
    diagnostic: text.optional(),
    observedCalls: strings,
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
    (item) => item.id === "library-judgment.precedence-and-impurity",
  );
  assert.ok(baseline);
  assert.equal(
    baseline.output.judgment.violations[0].kind,
    "library-imports-up",
  );
  assert.equal(baseline.output.judgment.unjudged, 1);
  const inherited = expected.find(
    (item) =>
      item.id === 'library-judgment.inherited-toString-name-"toString"-false',
  );
  assert.ok(inherited);
  assert.equal(inherited.output.licensed, true);
  assert.deepEqual(inherited.output.judgment.violations, []);
  const report = {
    reference: { node: process.version, v8: process.versions.v8 },
    passed: cases.length - failures.length,
    attempted: cases.length,
    failures,
    rejectedInvalidInputs: invalid.length,
    cases: answers,
    qualifications: [
      "Library verdicts consume real OXC imports and impurity facts; scope-wide graph loading and full boundary gate remain separate. Census counts are native nonnegative counts.",
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
