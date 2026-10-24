import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  BOUNDARY_KINDS,
  type BoundaryLedgerEntry,
  boundaryLedgerOf,
  LEDGER_FILENAME,
  ledgerKey,
  ledgerTargetOf,
  parseBoundaryLedger,
  readBoundaryLedger,
  rekeyBoundaryLedger,
  rekeyBoundaryLedgerFile,
  serializeBoundaryLedger,
  writeBoundaryLedger,
} from "../../packages/code-graph/src/boundaries/ledger.js";

const entry = z
  .object({
    scope: z.string(),
    kind: z.enum(BOUNDARY_KINDS),
    from: z.string(),
    to: z.string().nullable(),
    specifier: z.string(),
    reason: z.string().optional(),
  })
  .strict();
const move = z.object({ from: z.string(), to: z.string() });
const pure = z.object({
  entries: z.array(entry),
  moves: z.array(move).default([]),
});
const file = z.object({
  path: z.string(),
  initial: z.string().nullable().optional(),
  moves: z.array(move).default([]),
  writeEntries: z.array(entry).optional(),
  directory: z.boolean().default(false),
});
type Case = { id: string; operation: string; input: unknown };
const answerSchema = z.object({
  id: z.string().nullable(),
  ok: z.boolean(),
  output: z.unknown().optional(),
  error: z
    .object({
      kind: z.enum(["api_error", "driver_error"]),
      code: z.string().optional(),
    })
    .optional(),
  observedCalls: z.array(z.string()),
});
type Answer = z.infer<typeof answerSchema>;
const cases: Case[] = [];
const root = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "demlik-ledger-parity-")),
);
const binary = process.argv[2];
assert.ok(binary, "provide the native ledger driver");
assert.equal(process.version, "v22.21.1");
assert.equal(process.versions.v8, "12.4.254.21-node.33");
const base: BoundaryLedgerEntry = {
  scope: "app",
  kind: "impure",
  from: "a.ts",
  to: null,
  specifier: "fs",
};
function parseCase(id: string, text: string) {
  cases.push({ id, operation: "code_graph.ledger.parse", input: { text } });
}
function pureCase(
  id: string,
  entries: BoundaryLedgerEntry[],
  moves: z.infer<typeof move>[] = [],
) {
  cases.push({
    id,
    operation: "code_graph.ledger.pure",
    input: { entries, moves },
  });
}
function fileCase(id: string, input: Omit<z.input<typeof file>, "path">) {
  cases.push({
    id,
    operation: "code_graph.ledger.file",
    input: { ...input, path: path.join(root, id, "boundary-ledger.json") },
  });
}
function reference(test: Case): Answer {
  try {
    let output: unknown;
    switch (test.operation) {
      case "code_graph.ledger.parse":
        output = parseBoundaryLedger(
          z.object({ text: z.string() }).parse(test.input).text,
        );
        break;
      case "code_graph.ledger.pure": {
        const input = pure.parse(test.input);
        const ledger = boundaryLedgerOf(input.entries);
        output = {
          kinds: BOUNDARY_KINDS,
          filename: LEDGER_FILENAME,
          keys: input.entries.map(ledgerKey),
          targets: input.entries.map(ledgerTargetOf),
          ledger,
          moved: rekeyBoundaryLedger(ledger, input.moves),
          json: serializeBoundaryLedger(ledger),
          picked: ledger.entries.map((entry) => input.entries.indexOf(entry)),
        };
        break;
      }
      case "code_graph.ledger.file": {
        const input = file.parse(test.input);
        fs.rmSync(input.path, { recursive: true, force: true });
        fs.mkdirSync(path.dirname(input.path), { recursive: true });
        if (input.directory) fs.mkdirSync(input.path);
        else if (input.initial !== undefined && input.initial !== null)
          fs.writeFileSync(input.path, input.initial);
        if (input.writeEntries)
          writeBoundaryLedger(input.path, { entries: input.writeEntries });
        const before = readBoundaryLedger(input.path);
        const rekey = rekeyBoundaryLedgerFile(input.path, input.moves);
        const after = readBoundaryLedger(input.path);
        output = {
          before,
          rekey,
          after,
          text: fs.existsSync(input.path)
            ? fs.readFileSync(input.path, "utf8")
            : null,
          exists: fs.existsSync(input.path),
        };
        break;
      }
      default:
        throw new Error("unsupported operation");
    }
    return { id: test.id, ok: true, output, observedCalls: [] };
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      typeof error.code !== "string"
    )
      throw error;
    return {
      id: test.id,
      ok: false,
      error: { kind: "api_error", code: error.code },
      observedCalls: [],
    };
  }
}

try {
  for (const [index, text] of [
    "{",
    "{} true",
    "[]",
    "null",
    "true",
    "false",
    "0",
    '"str"',
    "{}",
    '{"entries":[]}',
    '{"entries":null}',
    '{"entries":{}}',
    '{"entries":[null]}',
    '{"entries":[{}]}',
    '{"x":1,"y":2}',
    '{"10":1,"2":2}',
    '{"\\ud800":1}',
  ].entries())
    parseCase(`shape-${index}`, text);
  parseCase(
    "enum-refusal",
    JSON.stringify({ entries: [{ ...base, kind: "unknown" }] }),
  );
  parseCase(
    "missing-to",
    JSON.stringify({
      entries: [{ scope: "app", kind: "impure", from: "a", specifier: "fs" }],
    }),
  );
  for (const key of ["scope", "from", "specifier", "reason"] as const) {
    for (const value of [null, 0, false, {}, [], ""])
      parseCase(
        `${key}-invalid-${typeof value}-${JSON.stringify(value)}`,
        JSON.stringify({ entries: [{ ...base, [key]: value }] }),
      );
  }
  for (const kind of BOUNDARY_KINDS) {
    parseCase(
      `null-target-${kind}`,
      JSON.stringify({ entries: [{ ...base, kind }] }),
    );
    parseCase(
      `file-target-${kind}`,
      JSON.stringify({ entries: [{ ...base, kind, to: "target.ts" }] }),
    );
  }
  parseCase("duplicate-bare", JSON.stringify({ entries: [base, base] }));
  parseCase(
    "duplicate-file-ignores-spelling",
    JSON.stringify({
      entries: [
        { ...base, to: "target.ts" },
        { ...base, to: "target.ts", specifier: "different" },
      ],
    }),
  );
  parseCase(
    "unknown-entry-key",
    JSON.stringify({ entries: [{ ...base, extra: 1 }] }),
  );
  parseCase(
    "unknown-entry-lone-key",
    JSON.stringify({ entries: [{ ...base, "\ud800": 1 }] }),
  );
  parseCase(
    "field-error-before-unknown",
    JSON.stringify({ entries: [{ ...base, scope: "", extra: 1 }], extra: 2 }),
  );
  parseCase(
    "field-error-before-duplicate",
    JSON.stringify({ entries: [base, base, { ...base, scope: 0 }] }),
  );
  parseCase(
    "lone-values",
    JSON.stringify({
      entries: [
        { ...base, from: "\ud800", specifier: "\udfff", reason: "\ud800" },
      ],
    }),
  );
  parseCase(
    "deep-invalid-type",
    `{"entries":[{"scope":${"[".repeat(350)}0${"]".repeat(350)}}]}`,
  );
  pureCase("empty", []);
  pureCase("prefer-first-reason", [
    base,
    { ...base, reason: "first" },
    { ...base, reason: "later" },
  ]);
  pureCase("empty-reason-counts-as-present", [
    { ...base, reason: "" },
    { ...base, reason: "later" },
  ]);
  pureCase("file-identity-ignores-specifier", [
    { ...base, to: "target", specifier: "first" },
    { ...base, to: "target", specifier: "second", reason: "reason" },
  ]);
  pureCase("bare-identity-uses-specifier", [
    base,
    { ...base, specifier: "http" },
  ]);
  pureCase(
    "unicode-order",
    ["a", "A", "é", "e", "_a", "-a", "💡", "\ud800", "\udfff"].map((from) => ({
      ...base,
      from,
    })),
  );
  pureCase("tuple-escaping", [
    { ...base, scope: 'x"\\\n', from: "a,b", specifier: "💡\ud800" },
  ]);
  pureCase(
    "rekey-only-once",
    [{ ...base, from: "a", to: "b" }],
    [
      { from: "a", to: "b" },
      { from: "b", to: "c" },
    ],
  );
  pureCase(
    "last-move-wins",
    [{ ...base, from: "a", to: "a" }],
    [
      { from: "a", to: "b" },
      { from: "a", to: "c" },
    ],
  );
  pureCase("bare-target-stays-bare", [base], [{ from: "fs", to: "moved.ts" }]);
  pureCase(
    "move-collision-keeps-reason",
    [
      { ...base, from: "a" },
      { ...base, from: "b", reason: "kept" },
    ],
    [{ from: "a", to: "b" }],
  );
  fileCase("absent", {});
  fileCase("invalid-json", { initial: " { " });
  fileCase("invalid-schema", {
    initial: JSON.stringify({ entries: [{ ...base, extra: 1 }] }),
  });
  fileCase("canonical-noop", { initial: JSON.stringify({ entries: [base] }) });
  fileCase("move-importer-and-target", {
    initial: JSON.stringify({ entries: [{ ...base, to: "b.ts" }] }),
    moves: [
      { from: "a.ts", to: "moved-a.ts" },
      { from: "b.ts", to: "moved-b.ts" },
    ],
  });
  fileCase("move-to-existing-key-counts-zero", {
    initial: JSON.stringify({
      entries: [base, { ...base, from: "b.ts", reason: "why" }],
    }),
    moves: [{ from: "a.ts", to: "b.ts" }],
  });
  fileCase("writer-dedup-and-lone-values", {
    writeEntries: [
      { ...base, from: "\ud800" },
      base,
      { ...base, reason: "kept" },
    ],
  });
  fileCase("directory-read-fails", { directory: true });

  const expected = cases.map(reference);
  const reasonChoice = z
    .object({ picked: z.array(z.number()) })
    .parse(
      expected.find((answer) => answer.id === "prefer-first-reason")?.output,
    );
  assert.deepEqual(reasonChoice.picked, [1]);
  const invalid = [
    "not json",
    JSON.stringify({
      id: "missing-input",
      operation: "code_graph.ledger.pure",
      input: {},
    }),
    JSON.stringify({ id: "unsupported", operation: "invented", input: {} }),
  ];
  const result = spawnSync(binary, [], {
    input: `${[...cases.map((test) => JSON.stringify(test)), ...invalid].join("\n")}\n`,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const answers: Answer[] = result.stdout
    .trim()
    .split("\n")
    .map((line) => answerSchema.parse(JSON.parse(line)));
  assert.equal(answers.length, cases.length + invalid.length);
  const failures: {
    id: string;
    message: string;
    reference: Answer;
    native: Answer;
  }[] = [];
  for (const [index, answer] of expected.entries()) {
    try {
      const { observedCalls: _calls, ...actual } = answers[index];
      const { observedCalls: _reference, ...referenceResult } = answer;
      assert.deepEqual(actual, referenceResult, cases[index].id);
      assert.ok(
        answers[index].observedCalls.length > 0,
        `${answer.id}: no public native calls`,
      );
    } catch (error) {
      failures.push({
        id: cases[index].id,
        message: error instanceof Error ? error.message : String(error),
        reference: answer,
        native: answers[index],
      });
    }
  }
  for (const answer of answers.slice(cases.length)) {
    assert.equal(answer.ok, false);
    assert.equal(answer.error?.kind, "driver_error");
    assert.deepEqual(answer.observedCalls, []);
  }
  const report = {
    reference: {
      node: process.version,
      v8: process.versions.v8,
      locale: new Intl.Collator().resolvedOptions().locale,
    },
    passed: cases.length - failures.length,
    attempted: cases.length,
    failures,
    rejectedInvalidInputs: invalid.length,
    nativeApis: [
      ...new Set(answers.flatMap((answer) => answer.observedCalls)),
    ].sort(),
    cases: answers,
  };
  if (process.argv[3])
    fs.writeFileSync(process.argv[3], `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ ...report, cases: undefined }, null, 2));
  if (failures.length) process.exitCode = 1;
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
