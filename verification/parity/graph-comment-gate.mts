import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { CommentCeilingsSchema } from "../../packages/code-graph/src/comments/ceilings.js";
import { loadCommentCensus } from "../../packages/code-graph/src/comments/census.js";
import { runCommentGate } from "../../packages/code-graph/src/comments/gate.js";
import {
  evaluateRatchet,
  renderRatchet,
} from "../../packages/code-graph/src/comments/ratchet.js";
import { renderComments } from "../../packages/code-graph/src/comments/render.js";
import { resolveCommentCeilings } from "../../packages/code-graph/src/config.js";
import { stableStringify } from "../../packages/code-graph/src/render/json.js";

const binary = process.argv[2];
assert.ok(
  binary,
  "usage: node --import tsx graph-comment-gate.mts <native-driver> [evidence.json]",
);
assert.equal(process.version, "v22.21.1");
assert.ok(process.versions.v8.startsWith("12.4."));
const repo = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const scalar = z.union([
  z.number(),
  z.enum(["NaN", "Infinity", "-Infinity", "-0"]),
]);
type Scalar = z.infer<typeof scalar>;
const verdictSchema = z.strictObject({
  passed: z.boolean(),
  scopesChecked: z.number().int().nonnegative(),
  inheritedScopes: z.number().int().nonnegative(),
  defaultCeiling: scalar,
  slackPoints: scalar,
  violations: z.array(
    z.strictObject({
      scope: z.string(),
      measured: scalar,
      ceiling: scalar,
      direction: z.enum(["EXCEEDED", "SLACK"]),
      delta: scalar,
      inherited: z.boolean(),
    }),
  ),
});
const gateInput = z.strictObject({
  rootAbsolute: z.string(),
  repoRoot: z.string(),
  ci: z.boolean().default(false),
  writeCeilings: z.boolean().default(false),
  json: z.boolean().default(false),
  pretty: z.boolean().default(false),
});
const renderInput = z.strictObject({
  root: z.string(),
  ceilings: z.unknown(),
  json: z.boolean().default(false),
  pretty: z.boolean().default(false),
});
const configInput = z.strictObject({ file: z.string().optional() });
const jsonInput = z.strictObject({
  value: z.unknown(),
  pretty: z.boolean().default(false),
});
const verdictInput = z.strictObject({
  verdict: verdictSchema,
  json: z.boolean().default(false),
  pretty: z.boolean().default(false),
});
const responseSchema = z.object({
  id: z.string().nullable(),
  ok: z.boolean(),
  output: z.unknown().optional(),
  error: z
    .object({
      kind: z.string(),
      message: z.string(),
      file: z.string().optional(),
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
type Operation =
  | "code_graph.comment_gate"
  | "code_graph.comment_config"
  | "code_graph.comment_render"
  | "code_graph.comment_verdict_render"
  | "code_graph.stable_json";
type Case = {
  id: string;
  operation: Operation;
  input: unknown;
  wireInput?: string;
  setup?: () => void;
  afterFile?: string;
};
const cases: Case[] = [];
const root = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "demlik-comment-gate-parity-")),
);
function write(file: string, source: string | Buffer): void {
  const absolute = path.join(root, file);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, source);
}
function number(value: Scalar): number {
  if (typeof value === "number") return value;
  return value === "NaN"
    ? NaN
    : value === "Infinity"
      ? Infinity
      : value === "-Infinity"
        ? -Infinity
        : -0;
}
function configState(
  file: string,
  state: string | Buffer | "directory" | "missing" | { readonly: string },
): () => void {
  return () => {
    try {
      fs.chmodSync(file, 0o700);
    } catch {}
    fs.rmSync(file, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (state === "missing") return;
    if (state === "directory") {
      fs.mkdirSync(file);
      return;
    }
    if (typeof state === "object" && !Buffer.isBuffer(state)) {
      fs.writeFileSync(file, state.readonly);
      fs.chmodSync(file, 0o400);
      return;
    }
    fs.writeFileSync(file, state);
  };
}
function snapshot(file: string): unknown {
  try {
    const stat = fs.lstatSync(file);
    if (stat.isDirectory()) return { kind: "directory" };
    const link = stat.isSymbolicLink() ? { link: fs.readlinkSync(file) } : {};
    try {
      return {
        kind: "file",
        ...link,
        bytes: fs.readFileSync(file).toString("base64"),
        mode: stat.mode & 0o777,
      };
    } catch {
      return { kind: "unreadable", ...link };
    }
  } catch {
    return { kind: "missing" };
  }
}
function reference(item: Case): Response {
  try {
    let output: unknown;
    if (item.operation === "code_graph.comment_config") {
      const input = configInput.parse(item.input),
        reports: string[] = [];
      output = {
        ceilings: resolveCommentCeilings(input.file, (message) =>
          reports.push(message),
        ),
        reports,
      };
    } else if (item.operation === "code_graph.comment_gate") {
      const input = gateInput.parse(item.input),
        emitted: string[] = [],
        reports: string[] = [];
      const exitCode = runCommentGate({
        ...input,
        emit: (payload) => emitted.push(payload),
        report: (message) => reports.push(message),
      });
      output = { exitCode, emitted, reports };
    } else if (item.operation === "code_graph.comment_render") {
      const input = renderInput.parse(item.input),
        census = loadCommentCensus(input.root),
        parsed = CommentCeilingsSchema.safeParse(input.ceilings);
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
      output = {
        census: renderComments(census, input.json, input.pretty),
        ratchet: renderRatchet(
          evaluateRatchet(census, parsed.data),
          input.json,
          input.pretty,
        ),
      };
    } else if (item.operation === "code_graph.comment_verdict_render") {
      const input = verdictInput.parse(item.input),
        verdict = input.verdict;
      output = renderRatchet(
        {
          ...verdict,
          defaultCeiling: number(verdict.defaultCeiling),
          slackPoints: number(verdict.slackPoints),
          violations: verdict.violations.map((row) => ({
            ...row,
            measured: number(row.measured),
            ceiling: number(row.ceiling),
            delta: number(row.delta),
          })),
        },
        input.json,
        input.pretty,
      );
    } else {
      const input = jsonInput.parse(item.input);
      output = stableStringify(input.value, input.pretty);
    }
    return {
      id: item.id,
      ok: true,
      output: JSON.parse(JSON.stringify(output)),
      observedCalls: [],
    };
  } catch (error) {
    assert.ok(error instanceof Error);
    if (item.operation === "code_graph.comment_gate" && "code" in error) {
      const input = gateInput.parse(item.input);
      return {
        id: item.id,
        ok: false,
        error: {
          kind: "write-error",
          file: path.join(input.repoRoot, "comment-ceilings.json"),
          message: error.message,
        },
        observedCalls: [],
      };
    }
    return {
      id: item.id,
      ok: false,
      error: {
        kind: error instanceof TypeError ? "type-error" : "backend-error",
        message: error.message,
      },
      observedCalls: [],
    };
  }
}
function wire(item: Case): string {
  return `{"id":${JSON.stringify(item.id)},"operation":${JSON.stringify(item.operation)},"input":${item.wireInput ?? JSON.stringify(item.input)}}`;
}
function addGate(
  id: string,
  project: string,
  repoDirectory: string,
  state: Parameters<typeof configState>[1],
  patch: Partial<z.infer<typeof gateInput>> = {},
): void {
  const repoRoot = path.join(root, repoDirectory),
    file = path.join(repoRoot, "comment-ceilings.json");
  cases.push({
    id,
    operation: "code_graph.comment_gate",
    input: gateInput.parse({
      rootAbsolute: path.join(root, project),
      repoRoot,
      ...patch,
    }),
    setup: configState(file, state),
    afterFile: file,
  });
}
try {
  for (const [scope, source] of [
    ["packages/a", "// prose\nexport const x=1;\nexport const y=2;\n"],
    ["packages/b", "// prose\nexport {};\n"],
    ["fixtures/example", "// ignored by ratchet\nexport {};\n"],
  ]) {
    write(`real/${scope}/package.json`, "{}");
    write(`real/${scope}/entry.ts`, source);
  }
  for (let index = 0; index < 25; index++) {
    const scope = `scopes/${String(index).padStart(2, "0")}${index === 0 ? "😀" : ""}`;
    write(`large/${scope}/package.json`, "{}");
    write(
      `large/${scope}/entry.ts`,
      `${"// prose\n".repeat(index === 0 ? 1001 : 1)}export const value=1;\n`,
    );
  }
  for (const name of ["__proto__", "constructor", "toString"]) {
    write(`special/${name}/package.json`, "{}");
    write(`special/${name}/entry.ts`, "// prose\nexport {};\n");
  }
  write("parse/valid.ts", "// prose\nexport {};\n");
  write("parse/broken.ts", "export function broken( {");
  fs.mkdirSync(path.join(root, "empty"));
  for (const project of [
    "real",
    "large",
    "special",
    "empty",
    "missing",
    "parse",
  ])
    for (const json of [false, true])
      for (const pretty of [false, true])
        cases.push({
          id: `render-${project}-${json}-${pretty}`,
          operation: "code_graph.comment_render",
          input: renderInput.parse({
            root: path.join(root, project),
            ceilings: { scopes: { "packages/a": 60, "packages/b": 40 } },
            json,
            pretty,
          }),
        });
  cases.push({
    id: "render-actual-extraction-tree",
    operation: "code_graph.comment_render",
    input: renderInput.parse({
      root: path.join(repo, "packages/code-graph/src/extract"),
      ceilings: {},
      json: false,
    }),
  });
  const configs: [string, Parameters<typeof configState>[1]][] = [
    ["missing", "missing"],
    ["defaults", "{}"],
    ["policy", '{"default":33.5,"slackPoints":5,"scopes":{"gone":90}}'],
    ["malformed", "{"],
    ["bom", "\ufeff{}"],
    ["unknown", '{"defualt":40}'],
    ["negative", '{"slackPoints":-1}'],
    ["raw-key", '{"\\ud800":1}'],
    ["raw-scopes", '{"scopes":{"\\ud800":2,"a.b":-1}}'],
    ["constructor-null", '{"default":"bad","scopes":{"constructor":null}}'],
    ["constructor-number", '{"scopes":{"constructor":0}}'],
    ["infinite", '{"default":1e400}'],
    ["directory", "directory"],
    ["readonly", { readonly: "{}" }],
    [
      "invalid-utf8",
      Buffer.from([
        123, 34, 100, 101, 102, 97, 117, 108, 116, 34, 58, 255, 125,
      ]),
    ],
  ];
  for (const [name, state] of configs) {
    const file = path.join(root, `config-${name}.json`);
    cases.push({
      id: `config-${name}`,
      operation: "code_graph.comment_config",
      input: { file },
      setup: configState(file, state),
      afterFile: file,
    });
  }
  cases.push({
    id: "config-undefined-defaults",
    operation: "code_graph.comment_config",
    input: {},
  });
  for (const [name, state] of configs)
    for (const [ci, writeCeilings] of [
      [false, false],
      [true, false],
      [false, true],
      [true, true],
    ])
      addGate(
        `gate-${name}-ci-${ci}-write-${writeCeilings}`,
        "real",
        `gate-${name}`,
        state,
        { ci, writeCeilings, json: true, pretty: true },
      );
  for (const json of [false, true])
    for (const pretty of [false, true]) {
      addGate(
        `gate-pass-${json}-${pretty}`,
        "real",
        `pass-${json}-${pretty}`,
        '{"scopes":{"packages/a":50,"packages/b":100}}',
        { ci: true, json, pretty },
      );
      addGate(
        `gate-fail-${json}-${pretty}`,
        "real",
        `fail-${json}-${pretty}`,
        '{"scopes":{"packages/a":60,"packages/b":40}}',
        { ci: true, json, pretty },
      );
    }
  for (const project of ["empty", "missing", "special", "parse"]) {
    addGate(`gate-write-${project}`, project, `write-${project}`, "missing", {
      writeCeilings: true,
    });
    addGate(`gate-ci-${project}`, project, `ci-${project}`, "{}", { ci: true });
  }
  const repeatRepo = path.join(root, "repeat"),
    repeatFile = path.join(repeatRepo, "comment-ceilings.json");
  const repeatSetup = () => {
    configState(repeatFile, "missing")();
    runCommentGate({
      rootAbsolute: path.join(root, "real"),
      repoRoot: repeatRepo,
      ci: false,
      writeCeilings: true,
      json: false,
      pretty: false,
      emit: () => {},
      report: () => {},
    });
  };
  cases.push({
    id: "gate-repeat-write-preserves-exact-bytes",
    operation: "code_graph.comment_gate",
    input: gateInput.parse({
      rootAbsolute: path.join(root, "real"),
      repoRoot: repeatRepo,
      ci: true,
      writeCeilings: true,
    }),
    setup: repeatSetup,
    afterFile: repeatFile,
  });
  const ctorRepo = path.join(root, "constructor-record"),
    ctorFile = path.join(ctorRepo, "comment-ceilings.json");
  cases.push({
    id: "gate-source-constructor-recorded-file-is-refused-on-ci",
    operation: "code_graph.comment_gate",
    input: gateInput.parse({
      rootAbsolute: path.join(root, "special"),
      repoRoot: ctorRepo,
      ci: true,
    }),
    setup: () => {
      configState(ctorFile, "missing")();
      runCommentGate({
        rootAbsolute: path.join(root, "special"),
        repoRoot: ctorRepo,
        ci: false,
        writeCeilings: true,
        json: false,
        pretty: false,
        emit: () => {},
        report: () => {},
      });
    },
    afterFile: ctorFile,
  });
  const absent = path.join(root, "absent-parent");
  cases.push({
    id: "gate-write-missing-parent-is-observable",
    operation: "code_graph.comment_gate",
    input: gateInput.parse({
      rootAbsolute: path.join(root, "real"),
      repoRoot: absent,
      writeCeilings: true,
    }),
    setup: () => fs.rmSync(absent, { recursive: true, force: true }),
    afterFile: path.join(absent, "comment-ceilings.json"),
  });
  const blocker = path.join(root, "not-directory");
  write("not-directory", "x");
  cases.push({
    id: "gate-write-file-parent-is-observable",
    operation: "code_graph.comment_gate",
    input: gateInput.parse({
      rootAbsolute: path.join(root, "real"),
      repoRoot: blocker,
      writeCeilings: true,
    }),
    afterFile: path.join(blocker, "comment-ceilings.json"),
  });
  const nul = path.join(root, "nul\0repo");
  for (const ci of [false, true])
    cases.push({
      id: `gate-nul-path-ci-${ci}`,
      operation: "code_graph.comment_gate",
      input: gateInput.parse({
        rootAbsolute: path.join(root, "real"),
        repoRoot: nul,
        ci,
        writeCeilings: !ci,
      }),
      afterFile: path.join(nul, "comment-ceilings.json"),
    });
  const aliasRepo = `${path.join(root, "alias")}/sub/../`,
    aliasFile = path.join(aliasRepo, "comment-ceilings.json");
  write("alias/sub/.keep", "");
  cases.push({
    id: "gate-normalizes-only-its-owned-output-path",
    operation: "code_graph.comment_gate",
    input: gateInput.parse({
      rootAbsolute: path.join(root, "real"),
      repoRoot: aliasRepo,
      writeCeilings: true,
    }),
    setup: configState(aliasFile, "missing"),
    afterFile: aliasFile,
  });
  const jsonValues = [
    "null",
    "true",
    "0",
    "-0",
    "1e400",
    '"\\ud800"',
    "[]",
    "{}",
    '{"z":[{"\\ud800":{"2":-0,"10":1e400,"__proto__":{"unsafe":true},"a":"\\udfff"}}],"a":[],"__proto__":{"x":1}}',
    '{"10":"ten","2":"two","01":1,"a":{"z":1,"a":2}}',
    '{"😀":1,"\\ud800":2,"é":3,"a":4,"\\udfff":5}',
    '[[],{},[1,2],{"line":"a\\nb\\t\\u0000\\u2028\\u2029"}]',
  ];
  let deep = "0";
  for (let index = 0; index < 160; index++) deep = `{"z":[${deep}],"a":[]}`;
  jsonValues.push(deep);
  for (const [index, value] of jsonValues.entries())
    for (const pretty of [false, true]) {
      const input = { value: JSON.parse(value), pretty };
      cases.push({
        id: `stable-json-${index}-${pretty}`,
        operation: "code_graph.stable_json",
        input,
        wireInput: `{"value":${value},"pretty":${pretty}}`,
      });
    }
  const numeric: Scalar[] = [
    "NaN",
    "Infinity",
    "-Infinity",
    "-0",
    0,
    -0.00015,
    -0.005,
    0.00505,
    1.05,
    1.25,
    99.95,
    1e21,
  ];
  for (const [index, value] of numeric.entries())
    for (const passed of [false, true])
      for (const json of [false, true])
        for (const pretty of [false, true]) {
          const verdict = {
            passed,
            scopesChecked: 12,
            inheritedScopes: 3,
            defaultCeiling: value,
            slackPoints: value,
            violations: [
              {
                scope: `raw\ud800😀-${index}`,
                measured: value,
                ceiling: value,
                direction: "EXCEEDED",
                delta: value,
                inherited: true,
              },
              {
                scope: `long-${"😀".repeat(26)}`,
                measured: 50,
                ceiling: 62.4,
                direction: "SLACK",
                delta: -12.4,
                inherited: false,
              },
            ],
          };
          cases.push({
            id: `verdict-${index}-${passed}-${json}-${pretty}`,
            operation: "code_graph.comment_verdict_render",
            input: verdictInput.parse({ verdict, json, pretty }),
          });
        }
  const expected: Response[] = [],
    answers: Response[] = [],
    after: unknown[] = [];
  for (const item of cases) {
    item.setup?.();
    const referenceAnswer = reference(item),
      referenceAfter = item.afterFile ? snapshot(item.afterFile) : undefined;
    item.setup?.();
    const native = spawnSync(binary, [], {
      input: `${wire(item)}\n`,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
    assert.equal(native.status, 0, `${item.id}: ${native.stderr}`);
    assert.equal(native.stderr, "");
    const rows = native.stdout.trim().split("\n");
    assert.equal(rows.length, 1, item.id);
    const answer = responseSchema.parse(JSON.parse(rows[0]));
    assert.equal(answer.id, item.id);
    assert.equal(
      answer.ok,
      referenceAnswer.ok,
      `${item.id}: ${JSON.stringify(answer.error)}`,
    );
    if (referenceAnswer.ok)
      assert.deepEqual(answer.output, referenceAnswer.output, item.id);
    else if (referenceAnswer.error?.kind === "write-error") {
      assert.equal(answer.error?.kind, "write-error", item.id);
      assert.equal(answer.error.file, referenceAnswer.error.file, item.id);
      assert.ok(answer.error.message);
      assert.ok(referenceAnswer.error.message);
    } else assert.deepEqual(answer.error, referenceAnswer.error, item.id);
    const actualAfter = item.afterFile ? snapshot(item.afterFile) : undefined;
    assert.deepEqual(
      actualAfter,
      referenceAfter,
      `${item.id}: physical file outcome`,
    );
    assert.ok(answer.observedCalls.length, item.id);
    expected.push(referenceAnswer);
    answers.push(answer);
    after.push(actualAfter);
  }
  const byId = (id: string) =>
    answers[cases.findIndex((item) => item.id === id)];
  const output = z.object({
    exitCode: z.number(),
    emitted: z.array(z.string()),
    reports: z.array(z.string()),
  });
  assert.equal(output.parse(byId("gate-pass-false-false").output).exitCode, 0);
  assert.equal(output.parse(byId("gate-fail-false-false").output).exitCode, 1);
  assert.equal(
    output.parse(byId("gate-malformed-ci-true-write-false").output).exitCode,
    2,
  );
  assert.equal(
    output.parse(
      byId("gate-source-constructor-recorded-file-is-refused-on-ci").output,
    ).exitCode,
    2,
  );
  const large = z
    .object({ census: z.string() })
    .parse(byId("render-large-false-false").output).census;
  assert.ok(large.includes("… and 5 more scope(s)"));
  assert.ok(large.includes("1,001"));
  const invalid = [
    "not json",
    JSON.stringify({ id: "unsupported", operation: "invented", input: {} }),
    JSON.stringify({
      id: "gate-no-root",
      operation: "code_graph.comment_gate",
      input: {},
    }),
    JSON.stringify({
      id: "gate-bad-flag",
      operation: "code_graph.comment_gate",
      input: { rootAbsolute: root, repoRoot: root, ci: "yes" },
    }),
    JSON.stringify({
      id: "unknown-config",
      operation: "code_graph.comment_config",
      input: { file: "x", unknown: true },
    }),
    JSON.stringify({
      id: "null-config-path",
      operation: "code_graph.comment_config",
      input: { file: null },
    }),
    JSON.stringify({
      id: "json-no-value",
      operation: "code_graph.stable_json",
      input: { pretty: true },
    }),
    JSON.stringify({
      id: "verdict-unknown",
      operation: "code_graph.comment_verdict_render",
      input: { verdict: {}, ignored: true },
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
  const evidence = {
    reference: {
      node: process.version,
      v8: process.versions.v8,
      parser: "OXC 0.151.0",
      profile:
        "same physical files reset before each source/native call; byte-exact render/JSON/config/exit and file outcomes; write diagnostics compared by operation/path with nonempty native detail",
    },
    passed: cases.length,
    rejectedInvalidInputs: invalid.length,
    gateCases: cases.filter(
      (item) => item.operation === "code_graph.comment_gate",
    ).length,
    configCases: cases.filter(
      (item) => item.operation === "code_graph.comment_config",
    ).length,
    renderCases: cases.filter(
      (item) =>
        item.operation === "code_graph.comment_render" ||
        item.operation === "code_graph.comment_verdict_render",
    ).length,
    jsonCases: cases.filter(
      (item) => item.operation === "code_graph.stable_json",
    ).length,
    nativeApis: [
      ...new Set(answers.flatMap((answer) => answer.observedCalls)),
    ].sort(),
    cases: [
      ...answers.map((answer, index) => ({
        ...answer,
        filesystemAfter: after[index],
      })),
      ...rejected,
    ],
  };
  if (process.argv[3])
    fs.writeFileSync(process.argv[3], `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify({ ...evidence, cases: undefined }, null, 2));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
