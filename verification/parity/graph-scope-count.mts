import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  type Scalar,
  type ScopeCountInput,
  scopeCountReference,
  scopeCountSchema,
  scopeOrderingCases,
} from "./scope-count-reference.mjs";

const binary = process.argv[2];
assert.ok(binary, "provide the compiled scope count driver");
assert.ok(process.argv.length <= 4);
assert.equal(process.version, "v22.21.1");
assert.equal(process.versions.v8, "12.4.254.21-node.33");
const directory = fs.mkdtempSync(path.join(tmpdir(), "demlik-scope-count-"));
type Case = {
  id: string;
  operation: "code_graph.scope-count";
  input: ScopeCountInput;
};
const cases: Case[] = [];
function add(id: string, input: unknown) {
  const item: Case = {
    id,
    operation: "code_graph.scope-count",
    input: scopeCountSchema.parse(input),
  };
  cases.push(item);
  return item;
}
const base = { default: 0, scopes: [] };
const normalize = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value));
try {
  const values: unknown[] = [
    {},
    null,
    [],
    true,
    0,
    "x",
    { default: null },
    { default: "0" },
    { default: [] },
    { default: {} },
    { scopes: null },
    { scopes: [] },
    { scopes: 1 },
    { scopes: "x" },
    { scopes: { constructor: null } },
    { scopes: { constructor: 0 } },
    { scopes: { constructor: { prototype: { isPrototypeOf: false } } } },
    { default: -0.5, scopes: { z: -1, a: 1.5 }, extra: 0 },
  ];
  for (const [i, value] of values.entries())
    add(`schema-shape-${i}`, { action: "parse", value });
  const numbers: Scalar[] = [
    0,
    "-0",
    1,
    -1,
    0.5,
    -0.5,
    Number.MAX_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER + 1,
    -Number.MAX_SAFE_INTEGER - 1,
    1e21,
    "NaN",
    "Infinity",
    "-Infinity",
  ];
  for (const [i, value] of numbers.entries()) {
    add(`schema-number-${i}`, {
      action: "parse-numbers",
      ceilings: { default: value, scopes: [["scope", value]] },
    });
    add(`evaluate-number-${i}`, {
      action: "evaluate",
      measurements: [
        { scope: "scope", count: value },
        { scope: "other", count: 1 },
      ],
      ceilings: base,
      title: "COUNT",
    });
    add(`evaluate-ceiling-${i}`, {
      action: "evaluate",
      measurements: [
        { scope: "scope", count: 1 },
        { scope: "other", count: -1 },
      ],
      ceilings: { default: value, scopes: [["scope", value]] },
      title: "COUNT",
    });
    add(`opaque-table-${i}`, {
      action: "table",
      verdict: {
        passed: i % 2 === 0,
        scopesChecked: value,
        violations: [
          {
            scope: "raw\ud800😀",
            measured: value,
            ceiling: { kind: "number", value },
            delta: value,
            direction: "SLACK",
          },
          {
            scope: "raw\udfff",
            measured: 2,
            ceiling: { kind: "number", value: 1 },
            delta: 1,
            direction: "EXCEEDED",
          },
        ],
      },
      title: "RAW\udfff",
    });
  }
  const proto = Object.getOwnPropertyNames(Object.prototype);
  for (const [i, key] of proto.entries()) {
    add(`schema-prototype-own-${i}`, {
      action: "parse",
      value: JSON.parse(`{"scopes":{${JSON.stringify(key)}:2}}`),
    });
    add(`schema-prototype-extra-${i}`, {
      action: "parse",
      value: Object.fromEntries([[key, 1]]),
    });
    add(`inherited-${i}`, {
      action: "evaluate",
      measurements: [{ scope: key, count: 1 }],
      ceilings: base,
      title: "COUNT",
    });
    add(`own-prototype-${i}`, {
      action: "evaluate",
      measurements: [{ scope: key, count: 1 }],
      ceilings: { default: 9, scopes: [[key, 1]] },
      title: "COUNT",
    });
    add(`opaque-inherited-${i}`, {
      action: "table",
      verdict: {
        passed: true,
        scopesChecked: 1,
        violations: [
          {
            scope: key,
            measured: 1,
            ceiling: { kind: "inherited", scope: key },
            delta: "NaN",
            direction: "SLACK",
          },
        ],
      },
      title: "COUNT",
    });
  }
  for (const value of [null, -1, 1.5, [], {}, "x"]) {
    add(`schema-proto-ignored-${JSON.stringify(value)}`, {
      action: "parse",
      value: JSON.parse(`{"scopes":{"__proto__":${JSON.stringify(value)}}}`),
    });
  }
  add("schema-raw-keys", {
    action: "parse",
    value: {
      default: 0,
      scopes: Object.fromEntries([
        ["raw\ud800", 2],
        ["2", 2],
        ["1", 1],
        ["01", 0],
      ]),
    },
  });
  add("schema-record-issue-order", {
    action: "parse",
    value: {
      default: -1,
      scopes: Object.fromEntries([
        ["z", null],
        ["2", -0.5],
        ["1", -1],
        ["raw\udfff", []],
      ]),
      extra: true,
    },
  });
  add("schema-unknown-key-order", {
    action: "parse",
    value: Object.fromEntries([
      ["z", 0],
      ["2", 0],
      ["1", 0],
      ["raw\ud800", 0],
      ["__proto__", 0],
    ]),
  });
  add("empty-evaluate", {
    action: "evaluate",
    measurements: [],
    ceilings: { default: 4, scopes: [["unmeasured", 7]] },
    title: "COUNT",
  });
  add("empty-table-failure-wording", {
    action: "table",
    verdict: { passed: true, scopesChecked: "NaN", violations: [] },
    title: "",
  });
  add("record-last-measurement-wins", {
    action: "evaluate",
    measurements: [
      { scope: "a", count: 3 },
      { scope: "b", count: 2 },
      { scope: "a", count: 1 },
      { scope: "__proto__", count: 4 },
    ],
    ceilings: { default: 5, scopes: [["stale", 9]] },
    title: "COUNT",
  });
  add("record-own-proto-survives-spread", {
    action: "evaluate",
    measurements: [{ scope: "__proto__", count: 3 }],
    ceilings: { default: 0, scopes: [["__proto__", 2]] },
    title: "COUNT",
  });
  add("record-numeric-raw-keys", {
    action: "evaluate",
    measurements: [
      { scope: "2", count: 3 },
      { scope: "1", count: 1 },
      { scope: "raw\ud800", count: "-0" },
    ],
    ceilings: {
      default: "-0",
      scopes: [
        ["01", 2],
        ["constructor", 1],
      ],
    },
    title: "COUNT",
  });
  for (const measurements of [
    [],
    [{ scope: "a", count: 0 }],
    [
      { scope: "é", count: 2 },
      { scope: "e", count: 2 },
      { scope: "E", count: 2 },
      { scope: "😀", count: 2 },
      { scope: "\ud800", count: 2 },
      { scope: "\udfff", count: 2 },
    ],
  ])
    add(`ordering-simple-${cases.length}`, {
      action: "evaluate",
      measurements,
      ceilings: base,
      title: "COUNT",
    });
  for (const item of scopeOrderingCases()) add(item.id, item.input);
  const names = [
    "services/z",
    "services/a",
    "services/a/sub",
    "services/ab",
    "services/a/",
    "packages/a",
    ".",
    "",
    "A",
    "a",
    "á",
    "😀",
    "\ud800",
    "\udfff",
    "2",
    "10",
    "services/a",
    "/absolute",
    "//double",
  ];
  for (const under of [
    ".",
    "services",
    "services/a",
    "services/a/",
    "",
    "/",
    "\ud800",
  ])
    add(`under-${JSON.stringify(under)}`, {
      action: "paths",
      repoRoot: "/repo",
      absolute: "/repo",
      scopes: names,
      under,
    });
  const paths = [
    ["/repo", "/repo"],
    ["/repo/", "/repo//src/../a/"],
    ["/repo/src", "/repo/file.ts"],
    ["/repo", "/else/a"],
    ["/", "/repo"],
    ["", ""],
    [".", "../a"],
    ["relative/root", "relative/root/sub"],
    ["/repo/\ud800", "/repo/\ud800/a"],
    ["/repo/\ud800", "/repo/\udfff/a"],
    ["/repo", "/repo/a\\b"],
    ["/repo", "/repo/a\0b"],
    ["//repo//", "//repo/a"],
    ["repo/../", "repo"],
  ];
  for (const [i, [repoRoot, absolute]] of paths.entries())
    add(`path-${i}`, {
      action: "paths",
      repoRoot,
      absolute,
      scopes: [],
      under: ".",
    });
  const fileContents: Buffer[] = [
    Buffer.from("{}"),
    Buffer.from('{"default":2,"scopes":{"a":1}}'),
    Buffer.from(""),
    Buffer.from("bad JSON"),
    Buffer.from("null"),
    Buffer.from('{"default":-1,"extra":0}'),
    Buffer.from('{"default":.5}'),
    Buffer.from('{"scopes":{"raw\\ud800":-1}}'),
    Buffer.from('{"scopes":{"constructor":null},"default":-1}'),
    Buffer.from('{"scopes":{"__proto__":-1}}'),
    Buffer.from('{"default":1e400}'),
    Buffer.from("\ufeff{}"),
    Buffer.from([
      123, 34, 115, 99, 111, 112, 101, 115, 34, 58, 123, 34, 255, 34, 58, 49,
      125, 125,
    ]),
  ];
  for (const [i, bytes] of fileContents.entries()) {
    const file = path.join(directory, `case-${i}.json`);
    fs.writeFileSync(file, bytes);
    add(`read-file-${i}`, { action: "read", file });
  }
  fs.writeFileSync(
    path.join(directory, "replacement-�.json"),
    '{"default":-1}',
  );
  add("read-raw-path", {
    action: "read",
    file: path.join(directory, "replacement-\ud800.json"),
  });
  add("read-missing", {
    action: "read",
    file: path.join(directory, "missing.json"),
  });
  add("read-directory", { action: "read", file: directory });
  add("read-missing-component", {
    action: "read",
    file: path.join(directory, "case-0.json", "child"),
  });
  add("read-null-byte", {
    action: "read",
    file: path.join(directory, "bad\0.json"),
  });
  fs.symlinkSync(
    path.join(directory, "missing.json"),
    path.join(directory, "dangling.json"),
  );
  add("read-dangling", {
    action: "read",
    file: path.join(directory, "dangling.json"),
  });
  fs.symlinkSync(
    path.join(directory, "case-1.json"),
    path.join(directory, "linked.json"),
  );
  add("read-symlink", {
    action: "read",
    file: path.join(directory, "linked.json"),
  });
  const expected = cases.map((item) =>
    normalize(scopeCountReference(item.input)),
  );
  const find = (id: string) => {
    const index = cases.findIndex((item) => item.id === id);
    assert.ok(index >= 0, id);
    return expected[index];
  };
  const schemaResult = z.object({
    success: z.boolean(),
    data: z.unknown().optional(),
    issues: z
      .array(
        z.object({
          path: z.array(z.union([z.string(), z.number()])),
          message: z.string(),
        }),
      )
      .optional(),
  });
  assert.equal(
    schemaResult.parse(find("schema-shape-17")).issues?.[0].message,
    "Invalid input: expected int, received number",
  );
  const inherited = z
    .object({
      table: z.object({
        verdict: z.object({
          violations: z.array(z.record(z.string(), z.unknown())),
        }),
        lines: z.array(z.string()),
      }),
    })
    .parse(find("inherited-0"));
  assert.equal(
    Object.hasOwn(inherited.table.verdict.violations[0], "ceiling"),
    false,
  );
  assert.ok(
    inherited.table.lines[2].includes(
      "function Object() { [native code] }  SLACK",
    ),
  );
  assert.deepEqual(find("read-missing"), {
    ceilings: { default: 0, scopes: {} },
    messages: [],
  });
  assert.deepEqual(find("empty-table-failure-wording"), {
    verdict: { passed: true, scopesChecked: null, violations: [] },
    lines: [
      " RATCHET FAILED — 0 of NaN scope(s) off their ceiling.",
      "  scope                                         measured  ceiling  direction  delta",
    ],
    hasExceeded: false,
    hasSlack: false,
  });
  const invalid = [
    {
      id: "invalid-operation",
      operation: "other",
      input: { action: "parse", value: {} },
    },
    {
      id: "invalid-outer",
      operation: "code_graph.scope-count",
      input: { action: "parse", value: {} },
      extra: true,
    },
    {
      id: "invalid-action",
      operation: "code_graph.scope-count",
      input: { action: "unknown" },
    },
    {
      id: "invalid-extra",
      operation: "code_graph.scope-count",
      input: { action: "parse", value: {}, extra: true },
    },
    {
      id: "invalid-missing-value",
      operation: "code_graph.scope-count",
      input: { action: "parse" },
    },
    {
      id: "invalid-number-token",
      operation: "code_graph.scope-count",
      input: {
        action: "parse-numbers",
        ceilings: { default: "nan", scopes: [] },
      },
    },
    {
      id: "invalid-number-pair",
      operation: "code_graph.scope-count",
      input: {
        action: "parse-numbers",
        ceilings: { default: 0, scopes: [["x"]] },
      },
    },
    {
      id: "invalid-read-file",
      operation: "code_graph.scope-count",
      input: { action: "read", file: null },
    },
    {
      id: "invalid-path-scopes",
      operation: "code_graph.scope-count",
      input: {
        action: "paths",
        repoRoot: "/",
        absolute: "/",
        scopes: null,
        under: ".",
      },
    },
    {
      id: "invalid-direction",
      operation: "code_graph.scope-count",
      input: {
        action: "table",
        title: "x",
        verdict: {
          passed: true,
          scopesChecked: 0,
          violations: [
            {
              scope: "x",
              measured: 1,
              ceiling: { kind: "number", value: 1 },
              delta: 0,
              direction: "UNKNOWN",
            },
          ],
        },
      },
    },
    {
      id: "invalid-inherited-key",
      operation: "code_graph.scope-count",
      input: {
        action: "table",
        title: "x",
        verdict: {
          passed: true,
          scopesChecked: 0,
          violations: [
            {
              scope: "x",
              measured: 1,
              ceiling: { kind: "inherited", scope: "absent" },
              delta: 0,
              direction: "SLACK",
            },
          ],
        },
      },
    },
  ];
  const requests = [...cases, ...invalid];
  assert.equal(new Set(requests.map((item) => item.id)).size, requests.length);
  const run = spawnSync(binary, [], {
    input: `${requests.map((item) => JSON.stringify(item)).join("\n")}\n`,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stderr, "");
  const replySchema = z
    .object({
      id: z.string().nullable(),
      ok: z.boolean(),
      output: z.unknown().optional(),
      error: z.object({ tag: z.string(), message: z.string() }).optional(),
      observedCalls: z.array(z.string()),
    })
    .strict();
  const answers = run.stdout
    .trimEnd()
    .split("\n")
    .map((line) => replySchema.parse(JSON.parse(line)));
  assert.equal(answers.length, requests.length);
  const failures = [];
  for (const [i, item] of cases.entries()) {
    const answer = answers[i];
    try {
      assert.equal(answer.id, item.id);
      assert.equal(answer.ok, true, JSON.stringify(answer.error));
      assert.deepEqual(answer.output, expected[i]);
      assert.ok(answer.observedCalls.length > 0);
    } catch (error) {
      failures.push({
        id: item.id,
        message: String(error),
        expected: expected[i],
        actual: answer,
      });
    }
  }
  for (const [i, item] of invalid.entries()) {
    const answer = answers[cases.length + i];
    assert.equal(answer.ok, false, item.id);
    assert.equal(answer.error?.tag, "driver-error", item.id);
    assert.deepEqual(answer.observedCalls, [], item.id);
  }
  const report = {
    passed: cases.length - failures.length,
    attempted: cases.length,
    rejectedInvalidInputs: invalid.length,
    reference: {
      node: process.version,
      v8: process.versions.v8,
      source: "ratchet/scope-count.ts",
      native:
        "actual canonical scope count schema/path/evaluate/record/read/table/direction methods",
    },
    caseCounts: Object.fromEntries(
      ["parse", "parse-numbers", "evaluate", "table", "paths", "read"].map(
        (action) => [
          action,
          cases.filter((item) => item.input.action === action).length,
        ],
      ),
    ),
    failures,
    cases: requests.map((item, i) => ({
      ...item,
      expected: i < cases.length ? expected[i] : { rejected: true },
      ...answers[i],
    })),
  };
  if (process.argv[3])
    fs.writeFileSync(process.argv[3], `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(
    `${JSON.stringify({ passed: report.passed, attempted: report.attempted, rejectedInvalidInputs: report.rejectedInvalidInputs, failures: failures.map((row) => row.id), caseCounts: report.caseCounts })}\n`,
  );
  assert.deepEqual(
    failures.map((row) => row.id),
    [],
  );
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
