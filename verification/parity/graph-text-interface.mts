import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { TypeContext } from "../../packages/code-graph/src/checker/context.js";
import { tsgoBinary } from "../../packages/code-graph/src/engine/tsgo.js";
import { assembleGraphWithEdges } from "../../packages/code-graph/src/extract/assemble.js";
import { discoverFunctions } from "../../packages/code-graph/src/extract/functions.js";
import { loadEdgeProject } from "../../packages/code-graph/src/extract/project.js";
import { globToRegExp } from "../../packages/code-graph/src/kinds/glob.js";
import { NodeKindRulesSchema } from "../../packages/code-graph/src/kinds/rules.js";
import {
  GraphSchema,
  ThresholdsSchema,
} from "../../packages/code-graph/src/schema.js";

const binary = process.argv[2];
assert.ok(
  binary,
  "usage: graph-text-interface.mts <driver> [report] [--ids names]",
);
assert.equal(process.version, "v22.21.1");
assert.ok(process.versions.v8.startsWith("12.4."));
const reportFile = process.argv[3];
const idAt = process.argv.indexOf("--ids");
const selected = idAt < 0 ? null : new Set(process.argv[idAt + 1]?.split(","));
const repository = fileURLToPath(new URL("../..", import.meta.url));
const manifest = createRequire(
  path.join(repository, "packages/code-graph/package.json"),
).resolve("@typescript/native-preview/package.json");
const compiler = await tsgoBinary();
assert.equal(compiler.version, "7.0.0-dev.20260707.2");
const hash = (data: Buffer | string) =>
  createHash("sha256").update(data).digest("hex");
const temporary = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "demlik-text-interface-")),
);
const projectSchema = z.strictObject({
  root: z.string(),
  repoRoot: z.string(),
  nativePreviewManifest: z.string(),
});
const inputSchema = z.discriminatedUnion("operation", [
  z.strictObject({
    operation: z.literal("context-text"),
    project: projectSchema,
  }),
  z.strictObject({
    operation: z.literal("context-path"),
    project: projectSchema,
  }),
  z.strictObject({
    operation: z.literal("assembly-text"),
    project: projectSchema,
    kindRules: z.unknown().default({}),
  }),
  z.strictObject({
    operation: z.literal("assembly-path"),
    project: projectSchema,
    kindRules: z.unknown().default({}),
  }),
  z.strictObject({
    operation: z.literal("glob-projection"),
    pattern: z.string(),
  }),
]);
type Input = z.infer<typeof inputSchema>;
type Case = {
  id: string;
  input: Input;
  rawBackend?: true;
  regexBackend?: true;
};
const thrownSchema = z.strictObject({
  stage: z.enum(["load", "context", "assembly", "projection"]),
  name: z.string(),
  message: z.string(),
  backendMethod: z.string().optional(),
});
const contextSchema = z.strictObject({
  files: z.array(z.string()),
  joinedIds: z.array(z.string()),
  unjoined: z.array(z.string()),
  symbols: z.array(z.tuple([z.string(), z.string().nullable()])),
  borrowedVisits: z.number().int(),
});
const resultSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("context"), value: contextSchema }),
  z.strictObject({ kind: z.literal("graph"), value: GraphSchema }),
]);
const outcomeSchema = z
  .strictObject({
    result: resultSchema.optional(),
    thrown: thrownSchema.optional(),
  })
  .refine((x) => (x.result === undefined) !== (x.thrown === undefined));
const responseSchema = z
  .strictObject({
    id: z.string(),
    result: resultSchema.optional(),
    thrown: thrownSchema.optional(),
    nativeCauses: z.array(
      z.strictObject({ kind: z.string(), message: z.string() }),
    ),
    observedCalls: z.array(z.string()),
  })
  .refine((x) => (x.result === undefined) !== (x.thrown === undefined));
type Response = z.infer<typeof responseSchema>;
const cases: Case[] = [];
const setups: unknown[] = [];
function snapshot(
  root: string,
): Record<string, { sha256: string; base64: string; mode: number }> {
  const out: Record<string, { sha256: string; base64: string; mode: number }> =
    {};
  function walk(directory: string) {
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name),
        stat = fs.lstatSync(file);
      if (stat.isDirectory()) walk(file);
      else if (stat.isFile()) {
        const bytes = fs.readFileSync(file);
        out[path.relative(root, file)] = {
          sha256: hash(bytes),
          base64: bytes.toString("base64"),
          mode: stat.mode & 0o777,
        };
      }
    }
  }
  walk(root);
  return out;
}
function fixture(
  name: string,
  folder = "scope",
  parentConfig = false,
  config = '{"compilerOptions":{"strict":true,"types":[]}}\n',
) {
  const base = path.join(temporary, name);
  fs.mkdirSync(base);
  const before = snapshot(base),
    root = path.join(base, folder);
  fs.mkdirSync(root);
  fs.writeFileSync(
    path.join(parentConfig ? base : root, "tsconfig.json"),
    config,
  );
  for (const [file, body] of Object.entries({
    "limits.ts": "export const LIMIT=3;\n",
    "helpers.ts":
      "export function choose(n:number,max:number){return n>=max?'stop':'retry';}\n",
    "entry.ts":
      "import {LIMIT} from './limits.js';\nimport {choose} from './helpers.js';\nexport function run(){return choose(1,LIMIT);}\n",
  }))
    fs.writeFileSync(path.join(root, file), body);
  setups.push({ name, base, before, after: snapshot(base) });
  return { base, root };
}
function add(
  id: string,
  root: string,
  repoRoot = root,
  over: Partial<Case> = {},
) {
  for (const operation of ["context-text", "assembly-text"] as const)
    cases.push({
      id: `${id}.${operation}`,
      input: inputSchema.parse({
        operation,
        project: { root, repoRoot, nativePreviewManifest: manifest },
      }),
      ...over,
    });
}
function paths(id: string, root: string, repoRoot = root) {
  for (const operation of ["context-path", "assembly-path"] as const)
    cases.push({
      id: `${id}.${operation}`,
      input: inputSchema.parse({
        operation,
        project: { root, repoRoot, nativePreviewManifest: manifest },
      }),
    });
}
const ordinary = fixture("ordinary");
add("ordinary", ordinary.root);
paths("ordinary", ordinary.root);
const high = fixture("high", "raw�");
const highRoot = high.root.slice(0, -1) + "\ud800";
add("raw-config", highRoot, high.base, { rawBackend: true });
add("replacement-config", high.root, high.base);
paths("replacement-config", high.root, high.base);
const child = fixture("child", "raw�", true);
const childRoot = child.root.slice(0, -1) + "\ud800";
add("raw-source", childRoot, child.base, { rawBackend: true });
add("replacement-source", child.root, child.base);
paths("replacement-source", child.root, child.base);
const low = fixture("low", "raw�");
add("raw-low", low.root.slice(0, -1) + "\udc00", low.base, {
  rawBackend: true,
});
add("replacement-low", low.root, low.base);
const unicode = fixture("unicode", "Ω𐀀");
add("unicode", unicode.root, unicode.base);
paths("unicode", unicode.root, unicode.base);
const normalized = fixture("normalized", "ordinary");
fs.mkdirSync(path.join(normalized.base, "unused�"));
add(
  "raw-normalized-away",
  `${normalized.base}/unused\ud800/../ordinary`,
  normalized.base,
);
const malformed = fixture(
  "malformed-config",
  "scope",
  false,
  '{"compilerOptions":',
);
add("malformed-config", malformed.root, malformed.base);
const badSource = fixture("bad-source");
fs.writeFileSync(
  path.join(badSource.root, "broken.ts"),
  "export function broken( {\n",
);
add("parse-failure", badSource.root, badSource.base);
const missing = fixture("missing-config");
fs.unlinkSync(path.join(missing.root, "tsconfig.json"));
add("missing-config", missing.root, missing.base);
const catalog = fixture("catalog");
fs.writeFileSync(
  path.join(catalog.base, "wrangler.json"),
  '{"name":"worker","vars":{"constructor":null}}\n',
);
add("catalog-type-error", catalog.root, catalog.base);
paths("catalog-type-error", catalog.root, catalog.base);
const warning = fixture("warning");
fs.writeFileSync(
  path.join(warning.root, "escaped.ts"),
  "export interface \\u0055 { value:number }\nexport const \\u0056=1;\nexport function \\u0066(){return 1;}\n",
);
add("default-warning", warning.root, warning.base);
paths("default-warning", warning.root, warning.base);
for (const operation of ["assembly-text", "assembly-path"] as const)
  cases.push({
    id: `regex-error.${operation}`,
    input: {
      operation,
      project: {
        root: ordinary.root,
        repoRoot: ordinary.base,
        nativePreviewManifest: manifest,
      },
      kindRules: { entryNames: { invalid: ["["] } },
    },
    regexBackend: true,
  });
for (const [id, pattern] of [
  ["high", "{\ud800"],
  ["low", "{\udc00"],
  ["nul", "{\0"],
  ["paired", "{𐀀"],
  ["unbalanced", "x}Ω"],
] as const)
  cases.push({
    id: `raw-glob.${id}`,
    input: { operation: "glob-projection", pattern },
  });

function backendMethod(message: string) {
  if (
    message.startsWith(
      "api: invalid request: failed to unmarshal *api.ParseConfigFileParams:",
    )
  )
    return "parseConfigFile";
  if (
    message.startsWith(
      "api: invalid request: failed to unmarshal *api.GetSourceFileParams:",
    )
  )
    return "getSourceFile";
  return undefined;
}
function source(input: Input) {
  let stage: "load" | "context" | "assembly" | "projection" = "load";
  try {
    if (input.operation === "glob-projection") {
      stage = "projection";
      globToRegExp(input.pattern);
      throw new Error("glob projection needs an actually refused input");
    }
    const loaded = loadEdgeProject(
      input.project.root,
      "package",
      input.project.repoRoot,
    );
    if (
      input.operation === "context-text" ||
      input.operation === "context-path"
    ) {
      stage = "context";
      const functions = discoverFunctions(loaded.sourceFiles).functions;
      const context = TypeContext.open({
        rootAbsolute: loaded.rootAbsolute,
        tsConfigPath: loaded.tsConfigPath,
        sourceFiles: loaded.sourceFiles,
        functions,
      });
      try {
        let visits = 0;
        visits++;
        const entries = [...context.nodeToId];
        return {
          result: {
            kind: "context",
            value: {
              files: context.files.map((file) => file.unit.file),
              joinedIds: entries.map(([, id]) => id),
              unjoined: [...context.unjoined],
              symbols: entries.map(([node, id]) => [
                id,
                context.symbolOf(node)?.name ?? null,
              ]),
              borrowedVisits: visits,
            },
          },
        };
      } finally {
        context.close();
      }
    }
    stage = "assembly";
    const options = {
      crossRuntime: true,
      kinds: true,
      reach: false,
      clusters: false,
      interfaceWidth: false,
      kindRules: NodeKindRulesSchema.parse(input.kindRules),
      repoRoot: input.project.repoRoot,
    };
    return {
      result: {
        kind: "graph",
        value: assembleGraphWithEdges(
          loaded,
          ThresholdsSchema.parse({}),
          "package",
          loaded.tsConfigPath,
          options,
        ),
      },
    };
  } catch (error) {
    assert.ok(error instanceof Error);
    const method = backendMethod(error.message);
    return {
      thrown: {
        stage,
        name: error.name,
        message: error.message,
        ...(method === undefined ? {} : { backendMethod: method }),
      },
    };
  }
}
function native(value: unknown) {
  const run = spawnSync(binary, [], {
    input: JSON.stringify(value),
    encoding: "utf8",
    cwd: process.cwd(),
  });
  return {
    status: run.status,
    stdout: run.stdout,
    stderr: run.stderr,
    signal: run.signal,
  };
}
const sourceHashes = Object.fromEntries(
  [
    "checker/context.ts",
    "engine/tsgo.ts",
    "extract/project.ts",
    "extract/assemble.ts",
    "extract/analysis.ts",
    "extract/edges.ts",
    "kinds/glob.ts",
    "kinds/rules.ts",
    "schema.ts",
  ].map((file) => [
    file,
    hash(
      fs.readFileSync(path.join(repository, "packages/code-graph/src", file)),
    ),
  ]),
);
const answers: unknown[] = [],
  failures: { id: string; kind: string; message: string }[] = [];
let exact = 0,
  qualified = 0;
for (const test of cases) {
  if (selected !== null && !selected.has(test.id)) continue;
  const beforeSource = snapshot(temporary),
    warningBytes: Buffer[] = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = new Proxy(originalWrite, {
    apply(target, receiver, args) {
      warningBytes.push(
        Buffer.isBuffer(args[0]) ? args[0] : Buffer.from(String(args[0])),
      );
      return Reflect.apply(target, receiver, args);
    },
  });
  let expected: z.infer<typeof outcomeSchema>;
  try {
    expected = outcomeSchema.parse(
      JSON.parse(JSON.stringify(source(inputSchema.parse(test.input)))),
    );
  } finally {
    process.stderr.write = originalWrite;
  }
  const sourceStderr = Buffer.concat(warningBytes).toString("utf8"),
    afterSource = snapshot(temporary);
  const beforeNative = snapshot(temporary),
    raw = native({ id: test.id, input: test.input }),
    afterNative = snapshot(temporary);
  let response: Response | undefined,
    passed = false,
    qualification: string | undefined,
    failureKind = "protocol";
  try {
    assert.equal(raw.status, 0, raw.stderr);
    response = responseSchema.parse(JSON.parse(raw.stdout));
    failureKind = "semantic";
    assert.equal(response.id, test.id);
    assert.equal(raw.stderr, sourceStderr, "existing default warnings");
    assert.deepEqual(
      beforeSource,
      afterSource,
      "Source interface is read-only",
    );
    assert.deepEqual(
      beforeNative,
      afterNative,
      "native interface is read-only",
    );
    assert.deepEqual(beforeSource, beforeNative);
    const actual =
      response.result === undefined
        ? { thrown: response.thrown }
        : { result: response.result };
    try {
      assert.deepEqual(actual, expected);
    } catch (error) {
      if (
        test.rawBackend &&
        response.thrown !== undefined &&
        expected.thrown !== undefined
      ) {
        assert.equal(
          response.thrown.backendMethod,
          expected.thrown.backendMethod,
        );
        assert.ok(
          ["parseConfigFile", "getSourceFile"].includes(
            response.thrown.backendMethod ?? "",
          ),
        );
        const suffix = (message: string) => {
          assert.match(message, / after offset \d+$/);
          return message.replace(
            / after offset \d+$/,
            " after offset <backend>",
          );
        };
        assert.deepEqual(
          {
            ...actual,
            thrown: {
              ...response.thrown,
              message: suffix(response.thrown.message),
            },
          },
          {
            ...expected,
            thrown: {
              ...expected.thrown,
              message: suffix(expected.thrown.message),
            },
          },
        );
        qualification = "actual-backend-offset";
      } else if (
        test.regexBackend &&
        response.thrown !== undefined &&
        expected.thrown !== undefined
      ) {
        assert.equal(response.thrown.name, "SyntaxError");
        assert.equal(expected.thrown.name, "SyntaxError");
        assert.equal(response.thrown.stage, expected.thrown.stage);
        assert.ok(response.thrown.message.length > 0);
        qualification = "native-regexp-diagnostic";
      } else throw error;
    }
    const prefix = test.input.operation.startsWith("context")
      ? "demlik_code_graph::checker::context::with_type_context"
      : test.input.operation.startsWith("assembly")
        ? "demlik_code_graph::extract::assemble::assemble_graph_with_analysis"
        : null;
    if (prefix !== null && response.thrown?.stage !== "load")
      assert.ok(
        response.observedCalls.includes(
          prefix + (test.input.operation.endsWith("text") ? "_text" : ""),
        ),
      );
    if (test.id.startsWith("catalog-type-error.assembly")) {
      assert.deepEqual(
        response.nativeCauses.map((c) => c.kind),
        ["AnalysisError", "CatalogError", "RecordTypeError"],
      );
      const message = response.thrown?.message;
      assert.ok(response.nativeCauses.every((c) => c.message === message));
    }
    if (test.input.operation === "glob-projection") {
      assert.ok(
        response.observedCalls.includes(
          "demlik_code_graph::extract::assemble::AssemblyError::message",
        ),
      );
      assert.equal(
        response.nativeCauses.at(-1)?.message,
        response.thrown?.message,
      );
    }
    passed = true;
    if (qualification === undefined) exact++;
    else qualified++;
  } catch (error) {
    failures.push({ id: test.id, kind: failureKind, message: String(error) });
  }
  answers.push({
    id: test.id,
    input: test.input,
    source: expected,
    native: response ?? raw,
    passed,
    qualification,
    sourceStderr,
    nativeStderr: raw.stderr,
    sourceStderrProfile: "existing public default warning sink",
    files: { beforeSource, afterSource, beforeNative, afterNative },
  });
}
const invalids = [
  {},
  { id: "bad", input: { operation: "unsupported" } },
  { id: "bad", input: { operation: "context-text", project: { root: 3 } } },
  {
    id: "bad",
    input: {
      operation: "context-text",
      project: {
        root: ordinary.root,
        repoRoot: ordinary.base,
        nativePreviewManifest: manifest,
        unknown: true,
      },
    },
  },
  { id: "bad", input: { operation: "glob-projection", pattern: 4 } },
  {
    id: "bad",
    input: {
      operation: "assembly-text",
      project: {
        root: ordinary.root,
        repoRoot: ordinary.base,
        nativePreviewManifest: manifest,
      },
      kindRules: { unknown: 1 },
    },
  },
];
for (const [index, input] of invalids.entries()) {
  const actual = native(input);
  const passed = actual.status !== 0;
  answers.push({
    id: `protocol.${index}`,
    protocol: true,
    input,
    native: actual,
    passed,
  });
  if (!passed)
    failures.push({
      id: `protocol.${index}`,
      kind: "protocol",
      message: "invalid driver request succeeded",
    });
}
for (const bad of [
  {
    id: "bad",
    result: {
      kind: "context",
      value: {
        files: [],
        joinedIds: [],
        unjoined: [],
        symbols: [],
        borrowedVisits: 1,
      },
    },
    thrown: { stage: "context", name: "Error", message: "bad" },
    nativeCauses: [],
    observedCalls: [],
  },
  { id: "bad", nativeCauses: [], observedCalls: [] },
  {
    id: "bad",
    result: { kind: "graph", value: {} },
    nativeCauses: [],
    observedCalls: [],
  },
])
  assert.equal(responseSchema.safeParse(bad).success, false);
const reference = {
  node: process.version,
  v8: process.versions.v8,
  sourceHashes,
  compiler: { ...compiler, sha256: hash(fs.readFileSync(compiler.path)) },
};
const report = {
  scope:
    "Public text context/assembly interface only; no collapse/CLI construction or capability closure",
  passed: exact + qualified,
  attempted: answers.length - invalids.length,
  unqualifiedPairs: exact,
  qualifiedPairs: qualified,
  rejectedInvalidInputs: invalids.length,
  responseGuards: 3,
  reference,
  driverSha256: hash(fs.readFileSync(binary)),
  verifierSha256: hash(fs.readFileSync(fileURLToPath(import.meta.url))),
  setups,
  failures,
  cases: answers,
};
if (reportFile !== undefined)
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
console.log(
  JSON.stringify({
    passed: report.passed,
    exact,
    qualified,
    protocol: invalids.length,
    guards: 3,
    failures: failures.length,
  }),
);
assert.equal(failures.length, 0, JSON.stringify(failures));
