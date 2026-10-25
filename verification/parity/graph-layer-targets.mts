import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { createTargetResolver } from "../../packages/code-graph/src/layers/resolve-target.js";

const binary = z.string().min(1).parse(process.argv[2]);
assert.equal(process.version, "v22.21.1");
assert.equal(process.versions.v8, "12.4.254.21-node.33");
const stepSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("resolve"),
      fromFile: z.string(),
      specifier: z.string(),
    })
    .strict(),
  z
    .object({
      action: z.literal("write"),
      file: z.string(),
      contents: z.string(),
    })
    .strict(),
]);
const requestSchema = z
  .object({
    id: z.string(),
    operation: z.literal("code_graph.layer_targets"),
    input: z
      .object({ repoRoot: z.string(), steps: z.array(stepSchema) })
      .strict(),
  })
  .strict();
type Request = z.infer<typeof requestSchema>;
const responseSchema = z
  .object({
    id: z.string().nullable(),
    ok: z.boolean(),
    output: z.unknown().optional(),
    error: z.object({ kind: z.string(), message: z.string() }).optional(),
    observedCalls: z.array(z.string()),
  })
  .strict();
const targetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("file"), file: z.string() }).strict(),
  z
    .object({
      kind: z.literal("package"),
      pkg: z
        .object({
          name: z.string(),
          dir: z.string(),
          entry: z.string().nullable(),
        })
        .strict(),
    })
    .strict(),
  z.object({ kind: z.literal("external") }).strict(),
  z.object({ kind: z.literal("unresolved"), specifier: z.string() }).strict(),
]);
const fixture = fs.mkdtempSync(
  path.join(os.tmpdir(), "demlik-layer-target-parity-"),
);
type Fixture = {
  root: string;
  files: Record<string, string | Buffer>;
  links: Record<string, string>;
};
const cases: { request: Request; fixture?: Fixture }[] = [];
const request = (
  id: string,
  repoRoot: string,
  steps: Request["input"]["steps"],
): Request => ({
  id,
  operation: "code_graph.layer_targets",
  input: { repoRoot, steps },
});
function project(
  name: string,
  files: Fixture["files"],
  links: Fixture["links"] = {},
): Fixture {
  return { root: path.join(fixture, name), files, links };
}
function prepare(tree: Fixture) {
  fs.rmSync(tree.root, { recursive: true, force: true });
  fs.mkdirSync(tree.root, { recursive: true });
  for (const [file, contents] of Object.entries(tree.files)) {
    const absolute = path.join(tree.root, file);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, contents);
  }
  for (const [file, target] of Object.entries(tree.links)) {
    const absolute = path.join(tree.root, file);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.symlinkSync(target, absolute);
  }
}
function queries(
  tree: Fixture,
  prefix: string,
  fromFile: string,
  specifiers: readonly string[],
) {
  for (const [index, specifier] of specifiers.entries())
    cases.push({
      request: request(`${prefix}-${index}`, tree.root, [
        { action: "resolve", fromFile, specifier },
      ]),
      fixture: tree,
    });
}
function ioKind(error: unknown) {
  const code = z.object({ code: z.string().optional() }).parse(error).code;
  return (
    (
      {
        ENOENT: "not-found",
        ENOTDIR: "not-a-directory",
        EACCES: "permission-denied",
        EPERM: "permission-denied",
        EINVAL: "invalid-input",
        ERR_INVALID_ARG_VALUE: "invalid-input",
      } as Record<string, string>
    )[code ?? ""] ?? "other-io"
  );
}
function reference(item: Request) {
  try {
    const resolve = createTargetResolver(item.input.repoRoot);
    const out = [];
    for (const step of item.input.steps) {
      if (step.action === "write")
        fs.writeFileSync(
          path.join(item.input.repoRoot, step.file),
          step.contents,
        );
      else out.push(resolve(step.fromFile, step.specifier));
    }
    return out;
  } catch (error) {
    return { thrown: { kind: ioKind(error), diagnostic: String(error) } };
  }
}
function call(item: Request) {
  const child = spawnSync(binary, [], {
    input: `${JSON.stringify(item)}\n`,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stderr, "");
  const answer = responseSchema.parse(JSON.parse(child.stdout));
  assert.equal(answer.id, item.id);
  assert.equal(answer.ok, true, JSON.stringify(answer.error));
  assert.ok(answer.observedCalls.includes("create_target_resolver"), item.id);
  return answer;
}
try {
  const ordinary = project("relative", {
    "src/ui/page.tsx": "export {};",
    "src/lib/value.ts": "export {};",
    "src/lib/value.tsx": "export {};",
    "src/lib/value.d.ts": "export {};",
    "src/lib/types.d.ts": "export {};",
    "src/lib/feature/index.ts": "export {};",
    "src/lib/feature/index.tsx": "export {};",
    "src/lib/tsx/index.tsx": "export {};",
    "src/lib/declarations/index.d.ts": "export {};",
    "src/lib/empty/keep.txt": "",
    "src/lib/plain": "plain",
    "src/lib/only.jsx": "export {};",
    "src/lib/esm.mts": "export {};",
    "src/lib/common.cts": "export {};",
    "src/lib/upper.JS": "export {};",
    "src/lib/types.d.ts.ts": "export {};",
    "src/lib/😀.ts": "export {};",
    "src/lib/�.ts": "export {};",
    "node_modules/pad/package.json": '{"name":"pad","main":"index.js"}',
    "node_modules/pad/index.js": "module.exports = 1;",
  });
  fs.writeFileSync(path.join(fixture, "outside.ts"), "export {};");
  queries(ordinary, "relative", "src/ui/page.tsx", [
    "../lib/value",
    "../lib/value.js",
    "../lib/value.jsx",
    "../lib/value.mjs",
    "../lib/value.cjs",
    "../lib/types",
    "../lib/types.d.ts",
    "../lib/feature",
    "../lib/tsx",
    "../lib/declarations",
    "../lib/empty",
    "../lib/plain",
    "../lib/only.jsx",
    "../lib/esm.mjs",
    "../lib/esm.mts",
    "../lib/common.cjs",
    "../lib/common.cts",
    "../lib/upper.JS",
    "../lib/😀",
    "../lib/\ud800",
    "../lib/missing",
    "../lib/gone.js",
    "../lib/value.ts/",
    "../../../outside",
    "..",
    ".",
    ".weird",
    ".\u0000missing",
    "node:fs",
    "fs",
    "pad",
    "not-installed",
    "cloudflare:workers",
    "",
    "/absolute-unknown",
  ]);
  const packages = project("packages", {
    "package.json": '{"name":"root-is-ignored"}',
    "src/page.ts": "export {};",
    "packages/a/package.json":
      '{"name":"@shop/core","exports":"./dist/index.js"}',
    "packages/a/src/index.ts": "export {};",
    "packages/b/package.json": '{"name":"@shop/core"}',
    "packages/plain/package.json": '{"name":"plain"}',
    "packages/exact/package.json": '{"name":"@shop/core/special"}',
    "packages/raw/package.json": '{"name":"raw\\ud800"}',
    "node_modules/pad/package.json":
      '{"name":"pad","exports":{"types":"./index.d.ts","default":"./index.js"}}',
    "node_modules/pad/index.d.ts": "export {};",
  });
  queries(packages, "packages", "src/page.ts", [
    "@shop/core",
    "@shop/core/private/missing",
    "@shop/core/special",
    "@shop/core/special/deep",
    "@shop/corex",
    "@shop",
    "plain",
    "plain/missing",
    "raw\ud800/sub",
    "root-is-ignored",
    "pad",
    "./plain",
  ]);
  const baseFiles = {
    "src/page.ts": "export {};",
    "src/lib/value.ts": "export {};",
    "src/feature/index.tsx": "export {};",
  };
  const configs: Record<string, string | Buffer> = {
    own: JSON.stringify({
      compilerOptions: {
        paths: {
          "@app/*": ["./src/*"],
          exact: ["./src/lib/value.ts"],
          "*suffix": ["./src/*"],
          "@double/*/x*": ["./src/*"],
        },
      },
    }),
    missingValues:
      '{"compilerOptions":{"paths":{"@a/*":null,"exact":false,"zero":0}}}',
    inherited: '{"extends":"./base.json"}',
    ownEmpty: '{"extends":"./base.json","compilerOptions":{"paths":{}}}',
    array: '{"extends":["./first.json","./base.json"]}',
    arrayEmpty: '{"extends":["./base.json","./empty.json"]}',
    arrayMissing: '{"extends":["./base.json","./absent.json"]}',
    cycle: '{"extends":"./cycle.json"}',
    cycleFallback: '{"extends":["./base.json","./cycle.json"]}',
    invalidExtends: '{"extends":false,"compilerOptions":{"paths":{"@a/*":[]}}}',
    invalidExtendsMember:
      '{"extends":["./base.json",2],"compilerOptions":{"paths":{"@a/*":[]}}}',
    invalidOptions: '{"extends":"./base.json","compilerOptions":[]}',
    invalidPaths: '{"extends":"./base.json","compilerOptions":{"paths":[]}}',
    nullPaths: '{"extends":"./base.json","compilerOptions":{"paths":null}}',
    constructorNull:
      '{"compilerOptions":{"paths":{"constructor":null,"@a/*":[]}}}',
    constructorBad:
      '{"compilerOptions":{"paths":{"constructor":{},"@a/*":[]}}}',
    constructorAllowed:
      '{"compilerOptions":{"paths":{"constructor":{"prototype":{"isPrototypeOf":null}},"@a/*":[]}}}',
    inheritedOptions: '{"__proto__":{"compilerOptions":{"paths":{"@a/*":[]}}}}',
    inheritedExtends: '{"__proto__":{"extends":"./base.json"}}',
    inheritedPaths: '{"compilerOptions":{"__proto__":{"paths":{"@a/*":[]}}}}',
    nullPrototype: '{"compilerOptions":{"paths":{"__proto__":null,"@a/*":[]}}}',
    ownProto:
      '{"compilerOptions":{"paths":{"__proto__":null,"__proto__":7,"@a/*":[]}}}',
    rawUtf16: '{"compilerOptions":{"paths":{"@raw\\ud800/*":[]}}}',
    malformedBrace: '{"compilerOptions":{"paths":{"@a/*":[]}}',
    malformedTail: '{"compilerOptions":{"paths":{"@a/*":[]}}} garbage',
    malformedComma: '{"compilerOptions":{"paths":{"@a/*":[]}} "x":1}',
    malformedComment: '{"compilerOptions":{"paths":{"@a/*":[]}}} /*',
    malformedMember: '{"compilerOptions":{"paths":{"@a/*":[]}}, bad:1}',
    malformedColon:
      '{"compilerOptions":{"paths":{"@a/*":[]}},"extends" "./base.json"}',
    malformedValue: '{"compilerOptions":{"paths":{"@a/*":[]}},"extends":}',
    invalidEscape: '{"compilerOptions":{"paths":{"@\\q/*":[]}}}',
    invalidUnicode: '{"compilerOptions":{"paths":{"@\\uQQQQ/*":[]}}}',
    controlString: '{"compilerOptions":{"paths":{"@a\t/*":[]}}}',
    validEscapes:
      '{"compilerOptions":{"paths":{"@\\u0061/*":[],"@tab\\t/*":[],"@slash\\\\/*":[],"@quote\\"/*":[],"@face\\ud83d\\ude00/*":[]}}}',
    otherInvalidEscapes:
      '{"compilerOptions":{"paths":{"@\\v/*":[],"@\\u12QQ/*":[],"@nul\u0000/*":[]}}}',
    numberExponent: '{"compilerOptions":{"paths":{"@a/*":1e}}}',
    numberFraction: '{"compilerOptions":{"paths":{"@a/*":1.}}}',
    numberLeadingZero: '{"compilerOptions":{"paths":{"@a/*":01}}}',
    validNumbers:
      '{"compilerOptions":{"paths":{"@a/*":-1.5e+2,"@base/*":0,"@first/*":1e400,"exact":-0}}}',
    absentNumericValues:
      '{"compilerOptions":{"paths":{"@a/*":-,"@base/*":NaN,"@first/*":undefined}}}',
    overflow: '{"compilerOptions":{"paths":{"@a/*":1e400}}}',
    scalar: "null",
    arrayRoot: "[]",
    empty: "",
    onlyComment: "// empty",
    bom: Buffer.from('\ufeff{"compilerOptions":{"paths":{"@a/*":[]}}}'),
  };
  for (const [name, config] of Object.entries(configs)) {
    const tree = project(`config-${name}`, {
      ...baseFiles,
      "tsconfig.json": config,
      "base.json":
        '{"compilerOptions":{"paths":{"@a/*":["./src/*"],"@base/*":[]}}}',
      "first.json": '{"compilerOptions":{"paths":{"@first/*":[]}}}',
      "empty.json": '{"compilerOptions":{"paths":{}}}',
      "cycle.json": '{"extends":"./tsconfig.json"}',
    });
    queries(tree, `config-${name}`, "src/page.ts", [
      "@a/missing",
      "@base/missing",
      "@first/missing",
      "@app/lib/value.js",
      "exact",
      "@app/gone",
      "@raw\ud800/missing",
      "@/missing",
      "@QQQQ/missing",
      "@a\t/missing",
      "uninstalled",
      "@tab\t/missing",
      "@slash\\/missing",
      '@quote"/missing',
      "@face😀/missing",
      "@nul\u0000/missing",
    ]);
  }
  const scoped = project("nearest", {
    ...baseFiles,
    "tsconfig.json": '{"compilerOptions":{"paths":{"@root/*":["./src/*"]}}}',
    "apps/web/src/page.ts": "export {};",
    "apps/web/src/lib.ts": "export {};",
    "apps/web/tsconfig.json":
      '{"compilerOptions":{"paths":{"@local/*":["./src/*"]}}}',
  });
  queries(scoped, "nearest", "apps/web/src/page.ts", [
    "@root/lib/value",
    "@root/missing",
    "@local/lib.js",
    "@local/missing",
  ]);
  const inheritedPackage = project("package-extends", {
    ...baseFiles,
    "tsconfig.json": '{"extends":"@config/base/tsconfig.json"}',
    "node_modules/@config/base/package.json": '{"name":"@config/base"}',
    "node_modules/@config/base/tsconfig.json":
      '{"compilerOptions":{"paths":{"@a/*":[]}}}',
  });
  queries(inheritedPackage, "package-extends", "src/page.ts", [
    "@a/missing",
    "uninstalled",
  ]);
  const patterns = project("alias-patterns", {
    ...baseFiles,
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        paths: {
          "@double/*/x*": [],
          "prefix*tail": [],
          "**": [],
          "@empty*end": [],
          exact: [],
        },
      },
    }),
  });
  queries(patterns, "alias-patterns", "src/page.ts", [
    "@double/a/x*",
    "@double/a/xz",
    "prefixtail",
    "prefixtai",
    "prefix/a/tail",
    "pkg*",
    "pkg",
    "*",
    "@emptyend",
    "@emptynd",
    "exact",
    "exact/sub",
  ]);
  cases.push({
    fixture: scoped,
    request: request(
      "relative-repo-root",
      path.relative(process.cwd(), scoped.root),
      [
        {
          action: "resolve",
          fromFile: "src/page.ts",
          specifier: "@root/lib/value",
        },
        {
          action: "resolve",
          fromFile: "src/page.ts",
          specifier: "@root/missing",
        },
      ],
    ),
  });
  const links = project(
    "symlinks",
    {
      ...baseFiles,
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          paths: {
            "@inside/*": ["./src/*"],
            "@outside": ["./outside.ts"],
            "@modules": ["./node_modules/private.ts"],
          },
        },
      }),
      "node_modules/private.ts": "export {};",
    },
    { "outside.ts": path.join(fixture, "outside.ts") },
  );
  queries(links, "links", "src/page.ts", [
    "@inside/lib/value",
    "@outside",
    "@modules",
    "../outside.ts",
  ]);
  prepare(links);
  const linkedRoot = path.join(fixture, "linked-root");
  fs.symlinkSync(links.root, linkedRoot);
  cases.push({
    request: request("real-root", linkedRoot, [
      {
        action: "resolve",
        fromFile: "src/page.ts",
        specifier: "@inside/lib/value",
      },
    ]),
    fixture: links,
  });
  const cache = project("cache", {
    ...baseFiles,
    "tsconfig.json": "{}",
    "packages/old/package.json": '{"name":"old"}',
  });
  cases.push({
    fixture: cache,
    request: request("cached-missing-and-workspace-snapshot", cache.root, [
      { action: "resolve", fromFile: "src/page.ts", specifier: "@a/missing" },
      { action: "resolve", fromFile: "src/page.ts", specifier: "old" },
      {
        action: "write",
        file: "tsconfig.json",
        contents: '{"compilerOptions":{"paths":{"@a/*":[]}}}',
      },
      {
        action: "write",
        file: "packages/old/package.json",
        contents: '{"name":"new"}',
      },
      { action: "resolve", fromFile: "src/page.ts", specifier: "@a/missing" },
      { action: "resolve", fromFile: "src/page.ts", specifier: "old" },
      { action: "resolve", fromFile: "src/page.ts", specifier: "new" },
    ]),
  });
  const repo = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../..",
  );
  cases.push({
    request: request("real-repository", repo, [
      {
        action: "resolve",
        fromFile: "packages/code-graph/src/layers/analyze.ts",
        specifier: "./resolve-target.js",
      },
      {
        action: "resolve",
        fromFile: "packages/code-graph/src/layers/analyze.ts",
        specifier: "@demlik/tea",
      },
      {
        action: "resolve",
        fromFile: "packages/code-graph/src/layers/analyze.ts",
        specifier: "node:fs",
      },
    ]),
  });
  cases.push({
    request: request("missing-root", path.join(fixture, "missing"), []),
  });
  cases.push({
    request: request("root-is-a-file", path.join(fixture, "outside.ts"), []),
  });
  cases.push({
    request: request("invalid-root-path", path.join(fixture, "\0bad"), []),
  });

  const answers = [];
  const expectations = [];
  let failures = 0;
  for (const item of cases) {
    requestSchema.parse(item.request);
    if (item.fixture) prepare(item.fixture);
    const expected = reference(item.request);
    if (item.fixture) prepare(item.fixture);
    const answer = call(item.request);
    const thrown = z.object({
      thrown: z.object({ kind: z.string(), diagnostic: z.string() }),
    });
    try {
      if (thrown.safeParse(expected).success) {
        const actual = thrown.parse(answer.output);
        const ref = thrown.parse(expected);
        assert.equal(actual.thrown.kind, ref.thrown.kind);
        assert.ok(actual.thrown.diagnostic);
      } else {
        assert.deepEqual(answer.output, expected, item.request.id);
        z.array(targetSchema).parse(answer.output);
        assert.equal(
          answer.observedCalls.filter(
            (call) => call === "TargetResolver::resolve",
          ).length,
          item.request.input.steps.filter((step) => step.action === "resolve")
            .length,
        );
      }
    } catch (error) {
      failures++;
      console.error(`${item.request.id}: ${String(error)}`);
    }
    answers.push(answer);
    expectations.push(expected);
  }
  const invalid = [
    "not json",
    JSON.stringify({ id: "unknown", operation: "ignored", input: {} }),
    JSON.stringify({
      id: "missing-root",
      operation: "code_graph.layer_targets",
      input: { steps: [] },
    }),
    JSON.stringify({
      id: "extra",
      operation: "code_graph.layer_targets",
      input: { repoRoot: fixture, steps: [], ignored: true },
    }),
    JSON.stringify({
      id: "wrong-specifier",
      operation: "code_graph.layer_targets",
      input: {
        repoRoot: fixture,
        steps: [{ action: "resolve", fromFile: "src/page.ts", specifier: 4 }],
      },
    }),
    JSON.stringify({
      id: "unknown-step",
      operation: "code_graph.layer_targets",
      input: { repoRoot: fixture, steps: [{ action: "ignored" }] },
    }),
  ];
  const bad = spawnSync(binary, [], {
    input: `${invalid.join("\n")}\n`,
    encoding: "utf8",
  });
  assert.equal(bad.status, 0, bad.stderr);
  assert.equal(bad.stderr, "");
  const rejected = bad.stdout
    .trim()
    .split("\n")
    .map((line) => responseSchema.parse(JSON.parse(line)));
  assert.equal(rejected.length, invalid.length);
  for (const answer of rejected) {
    assert.equal(answer.ok, false);
    assert.equal(answer.error?.kind, "driver-error");
    assert.ok(answer.error.message);
    assert.deepEqual(answer.observedCalls, []);
  }
  const relative = z.array(targetSchema).parse(answers[0].output);
  assert.deepEqual(relative, [{ kind: "file", file: "src/lib/value.ts" }]);
  const gap = cases.findIndex(
    (item) => item.request.id === "config-malformedBrace-0",
  );
  assert.deepEqual(expectations[gap], [
    { kind: "unresolved", specifier: "@a/missing" },
  ]);
  const evidence = {
    passed: cases.length - failures,
    rejectedInvalidInputs: invalid.length,
    failures,
    reference: {
      node: process.version,
      v8: process.versions.v8,
      resolver: "OXC 11.24.2",
      profile:
        "same physical filesystem reset before source/native constructor and trace; source ignored JSONC diagnostics retained; raw IO diagnostics require kind and nonempty detail",
    },
    resolutions: cases.reduce(
      (sum, item) =>
        sum +
        item.request.input.steps.filter((step) => step.action === "resolve")
          .length,
      0,
    ),
    nativeApis: [
      ...new Set(answers.flatMap((answer) => answer.observedCalls)),
    ].sort(),
    cases: [...answers, ...rejected],
  };
  if (process.argv[3])
    fs.writeFileSync(process.argv[3], `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify({ ...evidence, cases: undefined }, null, 2));
  assert.equal(failures, 0, "source/native layer target mismatches");
} finally {
  fs.rmSync(fixture, { recursive: true, force: true });
}
