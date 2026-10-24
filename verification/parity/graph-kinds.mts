import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { TypeContext } from "../../packages/code-graph/src/checker/context.js";
import * as ts from "../../packages/code-graph/src/engine/tsgo.js";
import { assembleGraphWithEdges } from "../../packages/code-graph/src/extract/assemble.js";
import { conventionEntries } from "../../packages/code-graph/src/extract/conventions/entries.js";
import { exportNamesById } from "../../packages/code-graph/src/extract/conventions/export-names.js";
import { discoverFunctions } from "../../packages/code-graph/src/extract/functions.js";
import { loadEdgeProject } from "../../packages/code-graph/src/extract/project.js";
import {
  calleeSimpleName,
  classifyFunction,
  compileKindRules,
  kindCensus,
} from "../../packages/code-graph/src/kinds/classify.js";
import {
  mergeRuleMaps,
  publicMethodRulesByBaseClass,
  siblingPropertyRules,
  typeScopeRules,
} from "../../packages/code-graph/src/kinds/declarations.js";
import {
  GlobSyntaxError,
  globToRegExp,
} from "../../packages/code-graph/src/kinds/glob.js";
import {
  NodeKindRulesSchema,
  regexSources,
} from "../../packages/code-graph/src/kinds/rules.js";
import { ThresholdsSchema } from "../../packages/code-graph/src/schema.js";

const casesSchema = z.discriminatedUnion("operation", [
  z.strictObject({
    id: z.string(),
    operation: z.literal("code_graph.kind_rules"),
    input: z.strictObject({ rules: z.unknown() }),
  }),
  z.strictObject({
    id: z.string(),
    operation: z.literal("code_graph.glob"),
    input: z.strictObject({ glob: z.string(), values: z.array(z.string()) }),
  }),
  z.strictObject({
    id: z.string(),
    operation: z.literal("code_graph.kinds"),
    input: z.strictObject({
      root: z.string(),
      repoRoot: z.string().optional(),
      rules: z.unknown().default({}),
    }),
  }),
]);
type Case = z.infer<typeof casesSchema>;
const resultSchema = z.object({
  id: z.string().nullable(),
  ok: z.boolean(),
  output: z.unknown().optional(),
  error: z
    .object({
      kind: z.string(),
      message: z.string(),
      issue: z
        .object({
          path: z.array(z.union([z.string(), z.number()])),
          message: z.string(),
        })
        .optional(),
    })
    .optional(),
  observedCalls: z.array(z.string()),
});
type Result = z.infer<typeof resultSchema>;
const binary = process.argv[2];
assert.ok(
  binary,
  "usage: node --import tsx graph-kinds.mts <native-driver> [evidence.json]",
);
assert.equal(process.version, "v22.21.1");
assert.ok(process.versions.v8.startsWith("12.4."));
const repo = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const manifest = createRequire(
  path.join(repo, "packages/code-graph/package.json"),
).resolve("@typescript/native-preview/package.json");
const compiler = await ts.tsgoBinary();
assert.equal(compiler.version, "7.0.0-dev.20260707.2");
const root = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "demlik-kinds-parity-")),
);
const cases: Case[] = [];
function write(relative: string, source: string): void {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, source);
}
function config(directory: string): void {
  write(
    `${directory}/tsconfig.json`,
    JSON.stringify({
      compilerOptions: {
        types: [],
        strict: true,
        module: "esnext",
        moduleResolution: "bundler",
        target: "es2022",
        jsx: "react-jsx",
      },
    }),
  );
}
function add(id: string, directory: string, rules: unknown = {}): void {
  cases.push({
    id,
    operation: "code_graph.kinds",
    input: { root: path.join(root, directory), rules },
  });
}
function reference(item: Case): Omit<Result, "id" | "observedCalls"> {
  let stage = "backend-error";
  try {
    if (item.operation === "code_graph.glob")
      return {
        ok: true,
        output: item.input.values.map((file) =>
          globToRegExp(item.input.glob).test(file),
        ),
      };
    const parsed = NodeKindRulesSchema.safeParse(item.input.rules);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      return {
        ok: false,
        error: {
          kind: "schema-issue",
          message: first.message,
          issue: {
            path: first.path.map((part) => {
              assert.ok(typeof part === "string" || typeof part === "number");
              return part;
            }),
            message: first.message,
          },
        },
      };
    }
    const rules = parsed.data;
    if (item.operation === "code_graph.kind_rules")
      return {
        ok: true,
        output: {
          rules,
          regexSources: regexSources(rules),
          stringified: JSON.stringify(rules),
        },
      };
    stage = "regex-error";
    const compiled = compileKindRules(rules);
    stage = "backend-error";
    const loaded = loadEdgeProject(
      item.input.root,
      "package",
      item.input.repoRoot ?? item.input.root,
    );
    const { functions } = discoverFunctions(loaded.sourceFiles);
    const exported = exportNamesById(functions);
    const conventions = conventionEntries(
      functions,
      rules,
      loaded.rootAbsolute,
      item.input.repoRoot ?? item.input.root,
    );
    const context = TypeContext.open({
      rootAbsolute: loaded.rootAbsolute,
      tsConfigPath: loaded.tsConfigPath,
      sourceFiles: loaded.sourceFiles,
      functions,
    });
    let base: Map<string, string[]>;
    let siblings: Map<string, string[]>;
    let types: Map<string, string[]>;
    try {
      base = publicMethodRulesByBaseClass(context, compiled.entryBaseClasses);
      siblings = siblingPropertyRules(context, compiled.entryGuardProperties);
      types = typeScopeRules(context, compiled.entryGuardProperties);
    } finally {
      context.close();
    }
    const guards = mergeRuleMaps(siblings, types);
    const classifyContext = {
      crossRuntimeTargets: new Set<string>(),
      durableObjectMethods: new Set<string>(),
      baseClassEntries: base,
      declaredGuards: guards,
      conventionEntries: conventions,
    };
    const graph = assembleGraphWithEdges(
      loaded,
      ThresholdsSchema.parse({}),
      "package",
      loaded.tsConfigPath,
      null,
    );
    for (const fn of graph.functions)
      fn.nodeKind = classifyFunction(fn, compiled, classifyContext);
    return {
      ok: true,
      output: {
        rules,
        functionCount: graph.functions.length,
        classifications: graph.functions.map((fn) => ({
          id: fn.id,
          nodeKind: fn.nodeKind,
        })),
        census: kindCensus(graph.functions),
        exportNames: Object.fromEntries(exported),
        conventionEntries: Object.fromEntries(conventions),
        baseClassEntries: Object.fromEntries(base),
        siblingGuards: Object.fromEntries(siblings),
        typeGuards: Object.fromEntries(types),
        mergedGuards: Object.fromEntries(guards),
        simpleCallees: graph.functions.flatMap((fn) =>
          (fn.edges?.calls ?? []).map((call) => ({
            id: fn.id,
            callee: call.calleeId,
            simple: calleeSimpleName(call.calleeId),
          })),
        ),
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: {
        kind:
          error instanceof GlobSyntaxError
            ? "glob-error"
            : error instanceof TypeError
              ? "type-error"
              : stage,
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
try {
  for (const [index, rules] of [
    {},
    null,
    [],
    1,
    "rules",
    { entryNames: {} },
    {
      entryNames: { z: ["z"], a: ["a"], "1": ["one"], "2": ["two"] },
      entryExportPresets: ["nextjs", "nextjs"],
    },
    JSON.parse('{"entryNames":{"\\ud800":["^custom$"],"__proto__":null}}'),
    { entryReach: { "service-binding": [], platform: [] } },
    {
      entryExportConventions: {
        custom: { files: "{,src/}app/**/page.tsx", exports: ["default"] },
      },
    },
    { entryNames: [] },
    { entryNames: { bad: null } },
    { entryNames: { bad: [1] } },
    { entryNames: { constructor: [] } },
    { entryNames: { constructor: null } },
    { entryNames: [], authNames: { constructor: null } },
    { entryNames: { constructor: { prototype: { isPrototypeOf: true } } } },
    { entryReach: {} },
    { entryReach: { platform: [] } },
    { entryReach: { platform: [], "service-binding": [], extra: 1 } },
    { entryExportConventions: { bad: { files: "", exports: [] } } },
    { entryExportConventions: { bad: { files: "a", exports: [""] } } },
    { entryExportConventions: { bad: { files: "a", exports: [1] } } },
    {
      entryExportConventions: {
        bad: { files: "a", exports: ["run"], extra: 1 },
      },
    },
    { entryExportPresets: ["remix"] },
    JSON.parse('{"__proto__":1,"constructor":2,"\\ud800":3}'),
  ].entries())
    cases.push({
      id: `kind-rules-schema-${index}`,
      operation: "code_graph.kind_rules",
      input: { rules },
    });
  for (const group of [
    "entryNames",
    "entryBaseClasses",
    "entryGuardProperties",
    "entryFilePatterns",
    "testSupportFilePatterns",
    "authNames",
    "authCallees",
    "effectDeclarations",
  ])
    for (const [index, value] of [
      null,
      [],
      true,
      "x",
      { "": [] },
      { first: ["a", "b"], second: [] },
      { "2": [null], "1": [0] },
    ].entries())
      cases.push({
        id: `${group}-input-${index}`,
        operation: "code_graph.kind_rules",
        input: { rules: { [group]: value } },
      });
  const globValues = [
    "app/page.tsx",
    "src/app/(marketing)/[slug]/page.tsx",
    "app/@modal/(.)photo/[id]/page.tsx",
    "app/page.tsx.bak",
    "pages/_app.tsx",
    "pages/api/[id].ts",
    "jobs/a.ts",
    "jobs/😀.ts",
    "docs/a/b.ts",
    "docs/a\nb.ts",
    "",
    "\ud800",
  ];
  for (const [index, glob] of [
    "{,src/}app/**/page.tsx",
    "pages/**/*.{ts,tsx}",
    "jobs/?.ts",
    "jobs/??.ts",
    "docs/**",
    "docs/*",
    "**",
    "?",
    "**/{a,{b,c}}",
    "app/{page",
    "app/page}",
    "a,b",
    "😀a,b",
    "{,}",
    "[x].(ts)",
    "\ud800",
  ].entries())
    cases.push({
      id: `framework-glob-${index}`,
      operation: "code_graph.glob",
      input: { glob, values: globValues },
    });
  config("guards");
  write(
    "guards/entry.ts",
    "declare class WorkerEntrypoint<E> {}\nclass Worker extends WorkerEntrypoint<unknown> { public call() {} private hidden() {} protected family() {} static build() {} #secret() {} get value() { return 1; } }\ndeclare const builder: any;\nconst Project = builder.objectRef('Project');\nProject.implement({ authScopes: { user: true }, fields: (t: any) => ({ one: t.field({ resolve: () => 101 }) }) });\nbuilder.objectField(Project, 'more', (t: any) => t.field({ resolve: () => 102 }));\nbuilder.objectField(Project, 'skip', (t: any) => t.field({ skipTypeScopes: true, resolve: () => 103 }));\nconst direct = { authScopes: { user: true }, resolve() { return 104; } };\nconst quoted = { 'authScopes': true, resolve() { return 105; } };\nexport function fetch() { requireAuth(); } export function requireAuth() {} export function plain() {} export function custom() {}\n",
  );
  add("native-base-class-modifiers-sibling-and-pothos-type-scopes", "guards");
  add(
    "custom-rules-and-raw-surrogate-evidence",
    "guards",
    JSON.parse(
      '{"entryNames":{"\\ud800":["^custom$"]},"entryGuardProperties":{"custom":["^skipTypeScopes$"]}}',
    ),
  );
  add("invalid-regex-is-observable", "guards", { authNames: { bad: ["["] } });
  add("invalid-convention-glob-is-observable", "guards", {
    entryExportConventions: {
      bad: { files: "app/{page", exports: ["default"] },
    },
  });
  config("workspace");
  for (const [file, source] of [
    ["package.json", '{"name":"workspace"}'],
    ["apps/web/package.json", '{"devDependencies":{"next":"*"}}'],
    [
      "apps/web/app/[slug]/page.tsx",
      "function Home() { return <div/>; } export default Home; export function helper() {} export function generateMetadata() { return {}; }",
    ],
    ["apps/plain/package.json", "{}"],
    [
      "apps/plain/app/page.tsx",
      "export default function Plain() { return <div/>; }",
    ],
    ["apps/jobs/package.json", "{}"],
    [
      "apps/jobs/jobs/run.ts",
      "const run = () => 1; export { run as execute };",
    ],
  ])
    write(`workspace/${file}`, source);
  add("nearest-package-conventions-and-local-export-aliases", "workspace", {
    entryExportConventions: {
      "job-runner": { files: "jobs/*.ts", exports: ["execute"] },
    },
  });
  add("explicit-preset-enables-plain-package", "workspace", {
    entryExportPresets: ["nextjs"],
  });
  config("exports");
  write(
    "exports/entry.ts",
    "export function direct() {} export { direct as GET }; function local() {} export { local as named, local as 'emoji😀' }; export default local; export const directArrow = () => 1; const aliased = () => 2; export { aliased as loader }; export const wrapped = (() => 3); export { remote } from './remote'; class Owner { method() {} } ",
  );
  write("exports/remote.ts", "export function remote() {}");
  write("exports/default.ts", "export default function Other() {}");
  add(
    "direct-local-default-renamed-string-and-wrapped-export-names",
    "exports",
  );
  config("empty");
  add("empty-project-measured-kind-census", "empty");
  config("bad-source");
  write("bad-source/bad.ts", "export function broken( {");
  add("malformed-source-remains-an-empty-measured-kind-report", "bad-source");
  add("missing-config-is-observable", "missing");
  for (const fixture of ["nextjs", "nextjs-src", "plain"])
    cases.push({
      id: `existing-entry-conventions-${fixture}`,
      operation: "code_graph.kinds",
      input: {
        root: path.join(
          repo,
          "packages/code-graph/test/entry-conventions",
          fixture,
        ),
        rules: {},
      },
    });
  cases.push({
    id: "existing-core-pothos-and-native-lib-classification",
    operation: "code_graph.kinds",
    input: {
      root: path.join(
        repo,
        "packages/code-graph/test/parity/fixture/apps/core",
      ),
      rules: {},
    },
  });
  cases.push({
    id: "existing-source-kind-classification",
    operation: "code_graph.kinds",
    input: { root: path.join(repo, "packages/code-graph/src"), rules: {} },
  });
  const expected = cases.map((item) => {
    if (process.env.DEMLIK_KINDS_TRACE) console.error(`reference: ${item.id}`);
    return reference(item);
  });
  const guardAnswer =
    expected[
      cases.findIndex(
        (item) =>
          item.id ===
          "native-base-class-modifiers-sibling-and-pothos-type-scopes",
      )
    ];
  const checked = z
    .object({
      baseClassEntries: z.record(z.string(), z.array(z.string())),
      classifications: z.array(
        z.object({ id: z.string(), nodeKind: z.object({ kind: z.string() }) }),
      ),
    })
    .parse(guardAnswer.output);
  assert.deepEqual(checked.baseClassEntries, {
    "entry.ts:call": ["worker-entrypoint-method"],
  });
  assert.equal(
    checked.classifications.find((item) => item.id === "entry.ts:fetch")
      ?.nodeKind.kind,
    "entry",
  );
  assert.equal(
    checked.classifications.find((item) => item.id === "entry.ts:requireAuth")
      ?.nodeKind.kind,
    "auth",
  );
  const exported = z
    .object({
      functionCount: z.number(),
      exportNames: z.record(z.string(), z.array(z.string())),
    })
    .parse(
      expected[
        cases.findIndex(
          (item) =>
            item.id ===
            "direct-local-default-renamed-string-and-wrapped-export-names",
        )
      ].output,
    );
  assert.ok(exported.functionCount >= 7);
  assert.deepEqual(exported.exportNames["entry.ts:local"], [
    "default",
    "emoji😀",
    "named",
  ]);
  assert.deepEqual(exported.exportNames["entry.ts:direct"], ["direct"]);
  assert.deepEqual(exported.exportNames["entry.ts:aliased"], ["loader"]);
  assert.equal(Object.hasOwn(exported.exportNames, "entry.ts:wrapped"), false);
  const invalid = [
    "not json",
    JSON.stringify({
      id: "missing",
      operation: "code_graph.kind_rules",
      input: {},
    }),
    JSON.stringify({ id: "unsupported", operation: "invented", input: {} }),
    JSON.stringify({
      id: "invalid-glob-values",
      operation: "code_graph.glob",
      input: { glob: "*", values: [1] },
    }),
    JSON.stringify({
      id: "missing-root",
      operation: "code_graph.kinds",
      input: { rules: {} },
    }),
    JSON.stringify({
      id: "unknown-option",
      operation: "code_graph.kinds",
      input: { root, ignored: true },
    }),
  ];
  const native = spawnSync(binary, [manifest], {
    input: `${[...cases.map((item) => JSON.stringify(item)), ...invalid].join("\n")}\n`,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 120000,
  });
  assert.equal(native.status, 0, native.stderr);
  assert.equal(native.stderr, "");
  const actual = native.stdout
    .trim()
    .split("\n")
    .map((line) => resultSchema.parse(JSON.parse(line)));
  assert.equal(actual.length, cases.length + invalid.length);
  for (const [index, answer] of expected.entries()) {
    const returned = actual[index];
    assert.equal(
      returned.ok,
      answer.ok,
      `${cases[index].id}: ${JSON.stringify(returned.error)} / ${JSON.stringify(answer.error)}`,
    );
    if (answer.ok)
      assert.deepEqual(returned.output, answer.output, cases[index].id);
    else {
      assert.equal(returned.error?.kind, answer.error?.kind, cases[index].id);
      assert.ok(returned.error?.message);
      if (
        ["schema-issue", "glob-error", "type-error"].includes(
          answer.error?.kind ?? "",
        )
      ) {
        assert.equal(
          returned.error?.message,
          answer.error?.message,
          cases[index].id,
        );
        assert.deepEqual(
          returned.error?.issue,
          answer.error?.issue,
          cases[index].id,
        );
      }
    }
    assert.ok(returned.observedCalls.length > 0, cases[index].id);
  }
  for (const answer of actual.slice(cases.length)) {
    assert.equal(answer.ok, false);
    assert.ok(answer.error?.message);
    assert.deepEqual(answer.observedCalls, []);
  }
  const countSchema = z.object({ functionCount: z.number() });
  const evidence = {
    reference: {
      node: process.version,
      v8: process.versions.v8,
      parser: "0.151.0",
      resolver: "11.24.2",
      compiler: compiler.version,
      protocol: 5,
      regex: "regress 0.12.0 unflagged UCS2",
    },
    passed: cases.length,
    rejectedInvalidInputs: invalid.length,
    functions: expected.reduce(
      (count, answer, index) =>
        count +
        (answer.ok && cases[index].operation === "code_graph.kinds"
          ? countSchema.parse(answer.output).functionCount
          : 0),
      0,
    ),
    nativeApis: [
      ...new Set(actual.flatMap((answer) => answer.observedCalls)),
    ].sort(),
    cases: actual,
  };
  if (process.argv[3])
    fs.writeFileSync(process.argv[3], `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify({ ...evidence, cases: undefined }, null, 2));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
