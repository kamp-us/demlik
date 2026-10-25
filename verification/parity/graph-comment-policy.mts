import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  type CommentCeilings,
  CommentCeilingsSchema,
  ceilingPoints,
  ceilingsFromCensus,
  isGovernedScope,
  toPoints,
} from "../../packages/code-graph/src/comments/ceilings.js";
import { loadCommentCensus } from "../../packages/code-graph/src/comments/census.js";
import { evaluateRatchet } from "../../packages/code-graph/src/comments/ratchet.js";

const binary = process.argv[2];
assert.ok(
  binary,
  "usage: node --import tsx graph-comment-policy.mts <native-driver> [evidence.json]",
);
assert.equal(process.version, "v22.21.1");
assert.ok(process.versions.v8.startsWith("12.4."));
const repo = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const scalarSchema = z.union([
  z.number(),
  z.enum(["NaN", "Infinity", "-Infinity", "-0"]),
]);
type Scalar = z.infer<typeof scalarSchema>;
const pointsInput = z.strictObject({ ratio: scalarSchema });
const scopeInput = z.strictObject({ scope: z.string() });
const policyInput = z.strictObject({ root: z.string(), ceilings: z.unknown() });
const valuesInput = z.strictObject({
  root: z.string(),
  default: scalarSchema,
  slackPoints: scalarSchema,
  scopes: z.array(z.tuple([z.string(), scalarSchema])),
});
const responseSchema = z.object({
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
        .passthrough()
        .optional(),
    })
    .optional(),
  observedCalls: z.array(z.string()),
});
type Response = z.infer<typeof responseSchema>;
type Case = {
  id: string;
  operation:
    | "code_graph.comment_ceilings"
    | "code_graph.comment_points"
    | "code_graph.comment_scope"
    | "code_graph.comment_policy"
    | "code_graph.comment_policy_values";
  input: unknown;
  wireInput?: string;
};
const verdictSchema = z.object({
  passed: z.boolean(),
  scopesChecked: z.number(),
  inheritedScopes: z.number(),
  defaultCeiling: z.number().nullable(),
  slackPoints: z.number().nullable(),
  violations: z.array(
    z.object({
      scope: z.string(),
      measured: z.number().nullable(),
      ceiling: z.number().nullable(),
      direction: z.enum(["EXCEEDED", "SLACK"]),
      delta: z.number().nullable(),
      inherited: z.boolean(),
    }),
  ),
});
const policyOutput = z.object({
  census: z
    .object({
      totals: z.object({ files: z.number(), commentLines: z.number() }),
    })
    .passthrough(),
  ceilings: z.unknown(),
  recorded: z.unknown(),
  verdict: verdictSchema,
  recordedVerdict: verdictSchema,
});
const numberOutput = z.object({
  value: z.number().nullable(),
  kind: z.enum(["finite", "NaN", "Infinity", "-Infinity"]),
  negativeZero: z.boolean(),
});
const pointsOutput = z.object({
  points: numberOutput,
  ceilingPoints: numberOutput,
});
const root = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "demlik-comment-policy-parity-")),
);
const cases: Case[] = [];
function scalar(value: Scalar): number {
  if (typeof value === "number") return value;
  return value === "NaN"
    ? NaN
    : value === "Infinity"
      ? Infinity
      : value === "-Infinity"
        ? -Infinity
        : -0;
}
function observed(value: number) {
  return {
    value,
    kind: Number.isNaN(value)
      ? "NaN"
      : value === Infinity
        ? "Infinity"
        : value === -Infinity
          ? "-Infinity"
          : "finite",
    negativeZero: Object.is(value, -0),
  };
}
function write(file: string, text: string): void {
  const absolute = path.join(root, file);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, text);
}
function addRaw(id: string, wireInput: string): void {
  cases.push({
    id,
    operation: "code_graph.comment_ceilings",
    input: JSON.parse(wireInput),
    wireInput,
  });
}
function policy(id: string, dir: string, ceilings: unknown): void {
  cases.push({
    id,
    operation: "code_graph.comment_policy",
    input: { root: path.join(root, dir), ceilings },
  });
}
function reference(item: Case): Response {
  try {
    if (item.operation === "code_graph.comment_ceilings") {
      const parsed = CommentCeilingsSchema.safeParse(item.input);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return {
          id: item.id,
          ok: false,
          error: {
            kind: "schema-issue",
            message: issue.message,
            issue: {
              ...issue,
              path: issue.path.map((part) =>
                typeof part === "number" ? part : String(part),
              ),
            },
          },
          observedCalls: [],
        };
      }
      return { id: item.id, ok: true, output: parsed.data, observedCalls: [] };
    }
    if (item.operation === "code_graph.comment_points") {
      const input = pointsInput.parse(item.input),
        value = scalar(input.ratio);
      return {
        id: item.id,
        ok: true,
        output: {
          points: observed(toPoints(value)),
          ceilingPoints: observed(ceilingPoints(value)),
        },
        observedCalls: [],
      };
    }
    if (item.operation === "code_graph.comment_scope")
      return {
        id: item.id,
        ok: true,
        output: isGovernedScope(scopeInput.parse(item.input).scope),
        observedCalls: [],
      };
    let directory: string, ceilings: CommentCeilings;
    if (item.operation === "code_graph.comment_policy") {
      const input = policyInput.parse(item.input);
      directory = input.root;
      const parsed = CommentCeilingsSchema.safeParse(input.ceilings);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return {
          id: item.id,
          ok: false,
          error: {
            kind: "schema-issue",
            message: issue.message,
            issue: {
              ...issue,
              path: issue.path.map((part) =>
                typeof part === "number" ? part : String(part),
              ),
            },
          },
          observedCalls: [],
        };
      }
      ceilings = parsed.data;
    } else {
      const input = valuesInput.parse(item.input);
      directory = input.root;
      ceilings = {
        default: scalar(input.default),
        slackPoints: scalar(input.slackPoints),
        scopes: Object.fromEntries(
          input.scopes.map(([key, value]) => [key, scalar(value)]),
        ),
      };
    }
    const census = loadCommentCensus(directory),
      recorded = ceilingsFromCensus(census, ceilings);
    return {
      id: item.id,
      ok: true,
      output: {
        census,
        ceilings,
        recorded,
        verdict: evaluateRatchet(census, ceilings),
        recordedVerdict: evaluateRatchet(census, recorded),
      },
      observedCalls: [],
    };
  } catch (error) {
    return {
      id: item.id,
      ok: false,
      error: {
        kind: error instanceof TypeError ? "type-error" : "backend-error",
        message: error instanceof Error ? error.message : String(error),
      },
      observedCalls: [],
    };
  }
}
function wire(item: Case): string {
  return `{"id":${JSON.stringify(item.id)},"operation":${JSON.stringify(item.operation)},"input":${item.wireInput ?? JSON.stringify(item.input)}}`;
}
try {
  for (const raw of [
    "null",
    "false",
    "true",
    "0",
    "-0",
    '"value"',
    "[]",
    "[1]",
    "{}",
    "1e400",
    "-1e400",
  ])
    addRaw(`root-${raw}`, raw);
  const values = [
    "null",
    "false",
    "true",
    '"bad"',
    "[]",
    "{}",
    "-1",
    "-0",
    "0",
    "0.00505",
    "9007199254740992",
    "1.7976931348623157e308",
    "1e400",
    "-1e400",
  ];
  for (const field of ["default", "slackPoints", "scopes"])
    for (const [index, value] of values.entries())
      addRaw(`field-${field}-${index}`, `{"${field}":${value}}`);
  for (const [index, value] of values.entries()) {
    addRaw(`scope-number-${index}`, `{"scopes":{"a":${value}}}`);
    addRaw(`constructor-value-${index}`, `{"scopes":{"constructor":${value}}}`);
    addRaw(
      `earlier-issue-with-constructor-${index}`,
      `{"default":"bad","scopes":{"constructor":${value}}}`,
    );
    addRaw(`prototype-key-value-${index}`, `{"scopes":{"__proto__":${value}}}`);
  }
  for (const [index, raw] of [
    '{"default":33.5,"slackPoints":5,"scopes":{"a":47,"z":0}}',
    '{"defualt":40}',
    '{"__proto__":3,"x":1}',
    '{"2":0,"10":1,"a":2}',
    '{"default":"bad","scopes":{"constructor":null},"unknown":true}',
    '{"slackPoints":null,"scopes":{"constructor":null}}',
    '{"scopes":{"constructor":{"prototype":{"isPrototypeOf":false}}}}',
    '{"scopes":{"constructor":{"prototype":null}}}',
    '{"scopes":{"constructor":{"prototype":{}}}}',
    '{"scopes":{"2":-1,"10":"bad","x":-1}}',
    '{"scopes":{"10":"bad","2":-1,"x":-1}}',
    '{"scopes":{"01":-1,"2":null}}',
    '{"scopes":{"\\ud800":-1,"a.b":null}}',
    '{"\\ud800":true,"\\udfff":false}',
  ].entries())
    addRaw(`schema-boundary-${index}`, raw);
  const numbers: Scalar[] = [
    "NaN",
    "Infinity",
    "-Infinity",
    "-0",
    Number.MIN_VALUE,
    -Number.MIN_VALUE,
    Number.MAX_VALUE,
    -Number.MAX_VALUE,
    0.49999999999999994,
    -0.5000000000000001,
    4503599627370.495,
    -4503599627370.495,
  ];
  for (let index = -150; index <= 150; index++)
    numbers.push((index + 0.5) / 1000);
  for (const [index, ratio] of numbers.entries())
    cases.push({
      id: `points-${index}`,
      operation: "code_graph.comment_points",
      input: { ratio },
    });
  for (const scope of [
    ".",
    "fixtures",
    "__fixtures__",
    "opensrc",
    "fixtures/",
    "/fixtures",
    "a/fixtures/b",
    "a/__fixtures__/b",
    "a/opensrc",
    "fixtures2",
    "myfixtures",
    "fixtures.ts",
    "a\\fixtures\\b",
    "a/fixtures-b",
    "constructor",
    "__proto__",
    "\ud800/fixtures",
    "fixtures/\udfff",
    "",
  ])
    cases.push({
      id: `governed-${cases.length}`,
      operation: "code_graph.comment_scope",
      input: { scope },
    });
  for (const [scope, text] of [
    ["packages/defaultLow", "export function live() {return 1;}\n"],
    ["packages/defaultHigh", "// prose\nexport {};"],
    ["packages/exceeded", "// prose\nexport {};"],
    ["packages/slack", "// prose\nexport const x=1;\nexport const y=2;"],
    ["__proto__", "// prose\nexport {};"],
    ["toString", "// prose\nexport {};"],
    ["fixtures/example", "// prose\nexport {};"],
  ]) {
    write(`real/${scope}/package.json`, "{}");
    write(`real/${scope}/entry.ts`, text);
  }
  write(
    "real/packages/defaultLow/only.spec.ts",
    "// @vitest-environment happy-dom\n",
  );
  policy("real-exceeded-slack-inherited-protected-prototype", "real", {
    scopes: { "packages/exceeded": 40, "packages/slack": 60 },
  });
  policy("real-defaults", "real", {});
  policy("real-slack-tolerance", "real", { slackPoints: 200 });
  for (const name of Object.getOwnPropertyNames(Object.prototype)) {
    write(`builtins/${name}/package.json`, "{}");
    write(`builtins/${name}/entry.ts`, "// prose\nexport {};");
  }
  policy("all-standard-object-prototype-scope-names", "builtins", {});
  write("threshold/a/package.json", "{}");
  write(
    "threshold/a/entry.ts",
    `${"// prose\n".repeat(49)}${Array.from({ length: 100 }, (_, index) => `export const item${index}=1;\n`).join("")}`,
  );
  for (const ceiling of [
    0, 48.8, 48.9, 48.95, 49, 49.05, 49.1, 50.9, 51, 51.05, 51.1, 100,
  ])
    policy(`recorded-ceiling-${ceiling}`, "threshold", {
      scopes: { a: ceiling },
    });
  for (const defaultCeiling of [0, 49, 49.1, 100])
    policy(`inherited-ceiling-${defaultCeiling}`, "threshold", {
      default: defaultCeiling,
    });
  for (const slackPoints of [0, 0.1, 1.9, 2, 2.1, 20])
    policy(`slack-boundary-${slackPoints}`, "threshold", {
      slackPoints,
      scopes: { a: 51 },
    });
  fs.mkdirSync(path.join(root, "empty"));
  policy("empty-census-passes", "empty", {});
  policy("missing-scope-census-passes", "missing", {});
  for (const [index, value] of [
    "NaN",
    "Infinity",
    "-Infinity",
    "-0",
    -1,
    0,
    2,
  ].entries()) {
    cases.push({
      id: `unvalidated-default-${index}`,
      operation: "code_graph.comment_policy_values",
      input: {
        root: path.join(root, "threshold"),
        default: value,
        slackPoints: 2,
        scopes: [],
      },
    });
    cases.push({
      id: `unvalidated-recorded-${index}`,
      operation: "code_graph.comment_policy_values",
      input: {
        root: path.join(root, "threshold"),
        default: 40,
        slackPoints: 2,
        scopes: [["a", value]],
      },
    });
    cases.push({
      id: `unvalidated-slack-${index}`,
      operation: "code_graph.comment_policy_values",
      input: {
        root: path.join(root, "threshold"),
        default: 40,
        slackPoints: value,
        scopes: [["a", 49]],
      },
    });
  }
  policy(
    "raw-utf16-policy-keys-serialize",
    "real",
    JSON.parse('{"scopes":{"\\ud800":50,"a.b":12}}'),
  );
  cases.push({
    id: "actual-extraction-comment-ratchet",
    operation: "code_graph.comment_policy",
    input: {
      root: path.join(repo, "packages/code-graph/src/extract"),
      ceilings: {},
    },
  });
  const expected = cases.map(
    (item) => JSON.parse(JSON.stringify(reference(item))) as Response,
  );
  const real = policyOutput.parse(
    expected[
      cases.findIndex(
        (item) =>
          item.id === "real-exceeded-slack-inherited-protected-prototype",
      )
    ].output,
  );
  assert.deepEqual(real.verdict, {
    passed: false,
    scopesChecked: 6,
    inheritedScopes: 2,
    defaultCeiling: 40,
    slackPoints: 2,
    violations: [
      {
        scope: "packages/defaultHigh",
        measured: 100,
        ceiling: 40,
        direction: "EXCEEDED",
        delta: 60,
        inherited: true,
      },
      {
        scope: "packages/exceeded",
        measured: 100,
        ceiling: 40,
        direction: "EXCEEDED",
        delta: 60,
        inherited: false,
      },
      {
        scope: "packages/slack",
        measured: 50,
        ceiling: 60,
        direction: "SLACK",
        delta: -10,
        inherited: false,
      },
    ],
  });
  assert.equal(real.recordedVerdict.passed, true);
  const builtins = policyOutput.parse(
    expected[
      cases.findIndex(
        (item) => item.id === "all-standard-object-prototype-scope-names",
      )
    ].output,
  );
  assert.equal(builtins.verdict.passed, true);
  assert.equal(builtins.verdict.inheritedScopes, 0);
  assert.equal(builtins.verdict.scopesChecked, 12);
  const invalid = [
    "not json",
    JSON.stringify({ id: "unsupported", operation: "invented", input: {} }),
    JSON.stringify({
      id: "bad-number",
      operation: "code_graph.comment_points",
      input: { ratio: "maybe" },
    }),
    JSON.stringify({
      id: "no-ratio",
      operation: "code_graph.comment_points",
      input: {},
    }),
    JSON.stringify({
      id: "bad-scope",
      operation: "code_graph.comment_scope",
      input: { scope: 1 },
    }),
    JSON.stringify({
      id: "no-root",
      operation: "code_graph.comment_policy",
      input: { ceilings: {} },
    }),
    JSON.stringify({
      id: "unknown-policy",
      operation: "code_graph.comment_policy",
      input: { root, ceilings: {}, unknown: true },
    }),
  ];
  const native = spawnSync(binary, [], {
    input: `${[...cases.map(wire), ...invalid].join("\n")}\n`,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(native.status, 0, native.stderr);
  assert.equal(native.stderr, "");
  const actual = native.stdout
    .trim()
    .split("\n")
    .map((line) => responseSchema.parse(JSON.parse(line)));
  assert.equal(actual.length, cases.length + invalid.length);
  for (const [index, answer] of expected.entries()) {
    const item = cases[index],
      returned = actual[index];
    assert.equal(
      returned.ok,
      answer.ok,
      `${item.id}: ${JSON.stringify(returned.error)}`,
    );
    if (answer.ok) {
      if (item.operation.startsWith("code_graph.comment_policy"))
        policyOutput.parse(returned.output);
      else if (item.operation === "code_graph.comment_points")
        pointsOutput.parse(returned.output);
      assert.deepEqual(returned.output, answer.output, item.id);
    } else assert.deepEqual(returned.error, answer.error, item.id);
    assert.ok(
      returned.observedCalls.some((call) =>
        call.startsWith("demlik_code_graph::comments::"),
      ),
      item.id,
    );
  }
  for (const answer of actual.slice(cases.length)) {
    assert.equal(answer.ok, false);
    assert.equal(answer.error?.kind, "driver-error");
    assert.ok(answer.error.message);
    assert.deepEqual(answer.observedCalls, []);
  }
  const reports = expected
    .filter(
      (answer, index) =>
        answer.ok &&
        cases[index].operation.startsWith("code_graph.comment_policy"),
    )
    .map((answer) => policyOutput.parse(answer.output));
  const evidence = {
    reference: {
      node: process.version,
      v8: process.versions.v8,
      parser: "OXC 0.151.0",
      profile:
        "strict Zod ceilings first issue/throw precedence; exact JS rounding incl signed zero/NaN; inherited plain-object scope accidents",
    },
    passed: cases.length,
    rejectedInvalidInputs: invalid.length,
    files: reports.reduce((sum, report) => sum + report.census.totals.files, 0),
    commentLines: reports.reduce(
      (sum, report) => sum + report.census.totals.commentLines,
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
