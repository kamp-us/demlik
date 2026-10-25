import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { CollapseSettingsSchema } from "../../packages/code-graph/src/collapse/settings.js";
import {
  resolveCollapseSettings,
  resolveNodeKindRules,
  resolveThresholds,
  withEntryPresets,
} from "../../packages/code-graph/src/config.js";
import { NodeKindRulesSchema } from "../../packages/code-graph/src/kinds/rules.js";
import { ThresholdsSchema } from "../../packages/code-graph/src/schema/core.js";

const binary = process.argv[2];
assert.ok(binary);
assert.ok(process.argv.length <= 4);
assert.equal(process.version, "v22.21.1");
assert.equal(process.versions.v8, "12.4.254.21-node.33");
const repository = fileURLToPath(new URL("../..", import.meta.url));
const reportFile = process.argv[3] ? path.resolve(process.argv[3]) : undefined;
const directory = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "demlik-cli-config-")),
);
const previous = process.cwd();
const jsonText = z.string().refine((value) => {
  try {
    JSON.parse(value);
    for (const character of value) {
      const point = character.codePointAt(0) ?? 0;
      if (point >= 0xd800 && point <= 0xdfff) return false;
    }
    return true;
  } catch {
    return false;
  }
});
const inputSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("schema"),
    kind: z.enum(["thresholds", "collapse"]),
    json: jsonText,
  }),
  z.strictObject({
    action: z.literal("resolve"),
    kind: z.enum(["thresholds", "collapse", "rules"]),
    file: z.string().nullable().optional(),
  }),
  z.strictObject({
    action: z.literal("presets"),
    json: jsonText,
    names: z.array(z.string()),
  }),
]);
type Input = z.infer<typeof inputSchema>;
type Case = { id: string; operation: "code_graph.cli-config"; input: Input };
const cases: Case[] = [];
function add(id: string, input: unknown) {
  cases.push({
    id,
    operation: "code_graph.cli-config",
    input: inputSchema.parse(input),
  });
}
function schema(id: string, kind: "thresholds" | "collapse", json: string) {
  add(`schema.${kind}.${id}`, { action: "schema", kind, json });
}
function file(name: string, bytes: string | Uint8Array) {
  fs.writeFileSync(path.join(directory, name), bytes);
  return name;
}
// Counts retain their existing native integer model. Compare the actual JSON
// projection consumed by the graph; lone UTF16 strings survive this projection.
function snapshot(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}
function reference(input: Input): unknown {
  if (input.action === "schema") {
    const model =
      input.kind === "thresholds" ? ThresholdsSchema : CollapseSettingsSchema;
    const result = model.safeParse(JSON.parse(input.json));
    return result.success
      ? {
          success: true,
          data: snapshot(result.data),
          ...(input.kind === "collapse"
            ? {
                negativeZeroFields: Object.entries(result.data)
                  .filter(([, value]) => Object.is(value, -0))
                  .map(([key]) => key),
              }
            : {}),
        }
      : { success: false, issue: result.error.issues[0] };
  }
  const reports: string[] = [];
  const report = (message: string) => reports.push(message);
  try {
    if (input.action === "resolve") {
      const resolver =
        input.kind === "thresholds"
          ? resolveThresholds
          : input.kind === "rules"
            ? resolveNodeKindRules
            : resolveCollapseSettings;
      return {
        value: snapshot(resolver(input.file ?? undefined, report)),
        reports,
      };
    }
    const rules = NodeKindRulesSchema.parse(JSON.parse(input.json));
    const group = Object.values(rules.entryNames)[0];
    const value = withEntryPresets(rules, input.names, report);
    return value === null
      ? { value, reports }
      : {
          value: snapshot(value),
          reports,
          unchangedGroupStorage: Object.values(value.entryNames)[0] === group,
        };
  } catch (error) {
    assert.ok(error instanceof Error);
    return { thrown: { name: error.name, message: error.message } };
  }
}
try {
  process.chdir(directory);
  schema("definition-order", "collapse", '{"minLoc":-1,"minSignals":0}');
  schema(
    "definition-order",
    "thresholds",
    '{"highComplexity":-1,"longFunctionLoc":-2}',
  );
  for (const [kind, model] of [
    ["thresholds", ThresholdsSchema],
    ["collapse", CollapseSettingsSchema],
  ] as const) {
    for (const [index, raw] of [
      "{}",
      "null",
      "true",
      "[]",
      "3",
      '"text"',
      '{"__proto__":1}',
      '{"constructor":null}',
      '{"2":1,"1":2,"extra":true}',
      '{"raw\\ud800\\n":1}',
      `{"extra":${"[".repeat(160)}0${"]".repeat(160)}}`,
      '{"minLoc":-1,"longFunctionLoc":-1,"extra":true}',
    ].entries())
      schema(`root-${index}`, kind, raw);
    const defaults: Readonly<Record<string, number>> = model.parse({});
    for (const field of Object.keys(model.shape)) {
      for (const [index, token] of [
        "null",
        "false",
        '"text"',
        "[]",
        "{}",
        "-1",
        "-0",
        "0",
        "0.2",
        "1",
        "2",
        "3",
        "4",
        "5",
        "9007199254740991",
        "9007199254740992",
        "-9007199254740992",
        "1e100",
        "1e400",
        "-1e400",
        "1e-100",
      ].entries())
        schema(
          `${field}.value-${index}`,
          kind,
          `{${JSON.stringify(field)}:${token}}`,
        );
      schema(
        `${field}.duplicate-last-valid`,
        kind,
        `{${JSON.stringify(field)}:null,${JSON.stringify(field)}:${JSON.stringify(defaults[field])}}`,
      );
    }
  }
  const malformed = file("malformed.json", "{oops");
  const empty = file("empty.json", "");
  const bom = file("bom.json", "\ufeff{}");
  const invalidBytes = file(
    "invalid-utf8.json",
    new Uint8Array([123, 34, 114, 97, 119, 255, 34, 58, 49, 125]),
  );
  const invalidOutside = file(
    "invalid-outside.json",
    new Uint8Array([255, 123, 125]),
  );
  const roots: string[] = [];
  for (const [name, value] of Object.entries({
    "null.json": "null",
    "array.json": "[]",
    "unknown.json": '{"raw\\ud800":1}',
    "integer-range.json":
      '{"minSignals":9007199254740992,"longFunctionLoc":9007199254740992}',
    "zero.json": '{"shapeLocRatio":-0}',
    "infinite.json": '{"costEffectWeight":1e400}',
  }))
    roots.push(file(name, value));
  for (const kind of ["thresholds", "collapse", "rules"] as const) {
    add(`resolve.${kind}.default`, { action: "resolve", kind });
    for (const [index, name] of [
      "missing.json",
      "",
      ".",
      malformed,
      empty,
      bom,
      invalidBytes,
      invalidOutside,
      ...roots,
      "nul\u0000.json",
      "missing\ud800.json",
    ].entries())
      add(`resolve.${kind}.refusal-${index}`, {
        action: "resolve",
        kind,
        file: name,
      });
  }
  const threshold = file(
    "thresholds.json",
    '{"longFunctionLoc":32,"highComplexity":12}',
  );
  const collapse = file(
    "collapse.json",
    '{"minSignals":3,"shapeLocRatio":0.3,"costEffectWeight":1.25,"partialMinPrefix":4}',
  );
  const rules = file(
    "rules.json",
    JSON.stringify({
      entryNames: { worker: ["^start$"] },
      entryExportConventions: {
        worker: { files: "src/{worker,index}.ts", exports: ["default"] },
      },
      entryExportPresets: ["nextjs", "nextjs"],
    }),
  );
  for (const [kind, name] of [
    ["thresholds", threshold],
    ["collapse", collapse],
    ["rules", rules],
  ] as const) {
    add(`resolve.${kind}.relative-real-file`, {
      action: "resolve",
      kind,
      file: name,
    });
    add(`resolve.${kind}.absolute-real-file`, {
      action: "resolve",
      kind,
      file: path.join(directory, name),
    });
    const raw = `${kind}-raw\ud800.json`;
    file(raw, fs.readFileSync(name));
    add(`resolve.${kind}.raw-file`, { action: "resolve", kind, file: raw });
  }
  for (const [id, value] of Object.entries({
    "regexp-before-glob": {
      entryNames: { worker: ["["] },
      entryExportConventions: { worker: { files: "{", exports: ["default"] } },
    },
    glob: {
      entryExportConventions: {
        worker: { files: "src/{worker.ts", exports: ["default"] },
      },
    },
    "raw-glob-name": {
      entryExportConventions: {
        "raw\ud800": { files: "{", exports: ["default"] },
      },
    },
    "glob-numeric-key-order": {
      entryExportConventions: {
        "2": { files: "{two", exports: ["default"] },
        "1": { files: "{one", exports: ["default"] },
      },
    },
    "regexp-numeric-key-order": { entryNames: { "2": ["("], "1": ["["] } },
    "entry-reach-regexp": {
      entryReach: { "service-binding": ["["], platform: [] },
    },
    "raw-regexp": { entryNames: { worker: ["raw\ud800["] } },
    "record-constructor": { entryNames: { constructor: null } },
    "later-record-throw-wins": {
      entryNames: 1,
      authNames: { constructor: null },
    },
    "unknown-top-constructor": { constructor: null },
    "empty-groups": { entryNames: {}, entryExportConventions: {} },
    "valid-special-regexp": {
      entryNames: {
        worker: [
          "(?<=a)b",
          "(?<part>a)\\k<part>",
          "\\p{Letter}",
          "",
          "raw\ud800",
        ],
      },
    },
  }))
    add(`resolve.rules.${id}`, {
      action: "resolve",
      kind: "rules",
      file: file(`${id}.json`, JSON.stringify(value)),
    });
  for (const [index, names] of [
    [],
    ["nextjs"],
    ["nextjs", "nextjs"],
    ["unknown"],
    ["nextjs", "unknown"],
    [""],
    ["raw\ud800"],
    ["line\n\t\u0085"],
    ["constructor"],
    ["__proto__"],
  ].entries())
    add(`presets.default-${index}`, { action: "presets", json: "{}", names });
  add("presets.file-and-cli-dedupe", {
    action: "presets",
    json: '{"entryExportPresets":["nextjs","nextjs"],"entryNames":{"worker":["^start$"]}}',
    names: ["nextjs"],
  });
  add("presets.empty-array-fresh-facts", {
    action: "presets",
    json: '{"entryNames":{}}',
    names: [],
  });
  const expected = cases.map((row) => reference(row.input));
  const invalid = [
    {
      id: "invalid.operation",
      operation: "other",
      input: { action: "resolve", kind: "rules" },
    },
    {
      id: "invalid.action",
      operation: "code_graph.cli-config",
      input: { action: "unknown" },
    },
    {
      id: "invalid.kind",
      operation: "code_graph.cli-config",
      input: { action: "schema", kind: "other", json: "{}" },
    },
    {
      id: "invalid.schema-kind",
      operation: "code_graph.cli-config",
      input: { action: "schema", kind: "rules", json: "{}" },
    },
    {
      id: "invalid.json",
      operation: "code_graph.cli-config",
      input: { action: "schema", kind: "collapse", json: "{" },
    },
    {
      id: "invalid.file-type",
      operation: "code_graph.cli-config",
      input: { action: "resolve", kind: "rules", file: 3 },
    },
    {
      id: "invalid.names-type",
      operation: "code_graph.cli-config",
      input: { action: "presets", json: "{}", names: [null] },
    },
    {
      id: "invalid.unknown-field",
      operation: "code_graph.cli-config",
      input: { action: "resolve", kind: "rules", ignored: true },
    },
  ];
  const requests = [...cases, ...invalid];
  const run = spawnSync(binary, [], {
    cwd: directory,
    input: `${requests.map((row) => JSON.stringify(row)).join("\n")}\n`,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stderr, "");
  const reply = z.strictObject({
    id: z.string().nullable(),
    ok: z.boolean(),
    output: z.unknown().optional(),
    error: z.strictObject({ tag: z.string(), message: z.string() }).optional(),
    observedCalls: z.array(z.string()),
  });
  const answers = run.stdout
    .trimEnd()
    .split("\n")
    .map((line) => reply.parse(JSON.parse(line)));
  assert.equal(answers.length, requests.length);
  const failures: {
    id: string;
    message: string;
    expected: unknown;
    actual: unknown;
  }[] = [];
  for (const [index, row] of cases.entries())
    try {
      const answer = answers[index];
      assert.equal(answer.id, row.id);
      assert.equal(answer.ok, true, JSON.stringify(answer.error));
      assert.deepEqual(answer.output, expected[index]);
      assert.ok(answer.observedCalls.length);
    } catch (error) {
      failures.push({
        id: row.id,
        message: String(error),
        expected: expected[index],
        actual: answers[index],
      });
    }
  for (const [index] of invalid.entries()) {
    const answer = answers[cases.length + index];
    assert.equal(answer.ok, false);
    assert.equal(answer.error?.tag, "driver-error");
    assert.deepEqual(answer.observedCalls, []);
  }
  const sources = [
    "config.ts",
    "collapse/settings.ts",
    "schema/core.ts",
    "kinds/rules.ts",
    "kinds/presets.ts",
    "kinds/glob.ts",
  ];
  const report = {
    passed: cases.length - failures.length,
    attempted: cases.length,
    rejectedInvalidInputs: invalid.length,
    reference: {
      node: process.version,
      v8: process.versions.v8,
      sourceHashes: Object.fromEntries(
        sources.map((file) => [
          file,
          createHash("sha256")
            .update(
              fs.readFileSync(
                path.join(repository, "packages/code-graph/src", file),
              ),
            )
            .digest("hex"),
        ]),
      ),
      native:
        "actual canonical schema first-issue/config-file/preset public functions, real shared relative/raw files; canonical Thresholds integer JSON projection, raw CollapseSettings f64 checked by native consumer",
      cwd: directory,
    },
    failures,
    cases: requests.map((row, index) => ({
      ...row,
      expected: index < cases.length ? expected[index] : { rejected: true },
      ...answers[index],
    })),
  };
  if (reportFile)
    fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(
    `${JSON.stringify({ passed: report.passed, attempted: report.attempted, rejectedInvalidInputs: invalid.length, failures: failures.map((row) => row.id) })}\n`,
  );
  assert.deepEqual(
    failures.map((row) => row.id),
    [],
  );
} finally {
  process.chdir(previous);
  fs.rmSync(directory, { recursive: true, force: true });
}
