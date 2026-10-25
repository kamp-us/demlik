import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  type ApiViewInput,
  apiViewReference,
  apiViewSchema,
} from "./api-view-reference.mjs";

const binary = process.argv[2];
assert.ok(binary);
assert.ok(process.argv.length <= 4);
assert.equal(process.version, "v22.21.1");
assert.equal(process.versions.v8, "12.4.254.21-node.33");
const repository = fileURLToPath(new URL("../..", import.meta.url));
const manifest = createRequire(
  path.join(repository, "packages/code-graph/package.json"),
).resolve("@typescript/native-preview/package.json");
const directory = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "demlik-api-raw-files-")),
);
const temp = path.join(directory, "compiler-temp");
fs.mkdirSync(temp);
const previous = process.env.TMPDIR;
process.env.TMPDIR = temp;
type Case = {
  id: string;
  operation: "code_graph.api-view";
  input: ApiViewInput;
};
const cases: Case[] = [];
function add(id: string, input: unknown) {
  cases.push({
    id,
    operation: "code_graph.api-view",
    input: apiViewSchema.parse(input),
  });
}
function file(name: string, text: string) {
  const target = path.join(directory, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text);
  return target;
}
// Go's actual decoder offsets depend on process/temp path lengths. Compare the
// Source-owned refusal contract and retain both complete messages in each row.
function contract(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(contract);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, part]) => {
      if (key !== "thrown") return [key, contract(part)];
      const error = z
        .object({ name: z.literal("Error"), message: z.string() })
        .parse(part);
      assert.match(
        error.message,
        /failed to unmarshal \*api\.GetSourceFileParams:/,
      );
      assert.match(error.message, /invalid surrogate pair/);
      assert.ok(error.message.includes('"/file"'));
      const unit = /\\u(d[89a-f][0-9a-f]{2})/i.exec(error.message)?.[1];
      assert.ok(unit);
      return [
        key,
        {
          name: error.name,
          operation: "getSourceFile",
          field: "file",
          invalidSurrogate: Number.parseInt(unit, 16),
        },
      ];
    }),
  );
}
function backendOffsets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(backendOffsets);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, part]) => {
      if (key !== "thrown") return [key, backendOffsets(part)];
      const error = z
        .strictObject({ name: z.string(), message: z.string() })
        .parse(part);
      return [
        key,
        {
          ...error,
          message: error.message.replace(
            / after offset [0-9]+$/,
            " after offset <backend>",
          ),
        },
      ];
    }),
  );
}
try {
  const root = path.join(directory, "ascii-package");
  file(
    "ascii-package/tsconfig.json",
    JSON.stringify({
      compilerOptions: { target: "ESNext", module: "ESNext", types: [] },
      include: ["src/**/*"],
    }),
  );
  for (const name of [
    "raw�.ts",
    "two�-�.ts",
    "pair😀.ts",
    "clean.ts",
    "raw�/index.ts",
  ])
    file(
      `ascii-package/src/${name}`,
      "interface Private {n:number} export declare function published(x:Private):Private;",
    );
  const read = (id: string, entry: string) =>
    add(id, {
      action: "read",
      root,
      map: { ".": { entry } },
      repoRoot: null,
      warn: "collect",
    });
  read("raw-high-entry", "src/raw\ud800.ts");
  read("raw-low-entry", "src/raw\udfff.ts");
  read("two-raw-units-entry", "src/two\ud800-\udfff.ts");
  read("raw-directory-entry", "src/raw\ud800/index.ts");
  read("literal-replacement-entry", "src/raw�.ts");
  read("valid-pair-entry", "src/pair😀.ts");
  read("ascii-entry", "src/clean.ts");
  const raw = path.join(root, "src/raw\ud800.ts");
  add("opaque-raw-emitted-entry", {
    action: "emitted",
    root,
    subpaths: [
      {
        subpath: ".",
        entry: "src/raw\ud800.ts",
        entryAbsolute: raw,
        tier: null,
      },
    ],
    repoRoot: null,
    warn: "collect",
    context: null,
  });
  const config = file(
    "manual/tsconfig.json",
    '{"compilerOptions":{"types":[]},"files":[]}',
  );
  const physical = file("manual/raw�.d.ts", "export declare const raw:1;");
  const high = physical.replace("�", "\ud800"),
    low = physical.replace("�", "\udfff");
  const pair = file("manual/pair😀.d.ts", "export declare const pair:1;");
  for (const [id, roots, lookups] of [
    ["raw-only-roots", [high], [physical, high]],
    ["literal-and-raw-roots", [physical, high], [physical, high]],
    [
      "literal-cache-does-not-hide-high",
      [physical],
      [physical, high, physical],
    ],
    ["literal-cache-does-not-hide-low", [physical], [physical, low, physical]],
    ["empty-roots", [], [physical, high]],
    ["valid-pair-roots", [pair], [pair]],
  ] as const)
    add(id, { action: "lookup-text", config, roots, lookups });
  const expected: unknown[] = [];
  for (const row of cases)
    expected.push(
      JSON.parse(JSON.stringify(await apiViewReference(row.input))),
    );
  const lookup = z.array(z.object({ found: z.boolean().optional() }));
  assert.equal(
    lookup.parse(
      expected[cases.findIndex((row) => row.id === "raw-only-roots")],
    )[0].found,
    false,
  );
  assert.equal(
    lookup.parse(
      expected[cases.findIndex((row) => row.id === "literal-and-raw-roots")],
    )[0].found,
    true,
  );
  const invalid = [
    {
      id: "bad-roots",
      operation: "code_graph.api-view",
      input: { action: "lookup-text", config, roots: null, lookups: [] },
    },
    {
      id: "bad-lookup",
      operation: "code_graph.api-view",
      input: { action: "lookup-text", config, roots: [], lookups: [null] },
    },
    {
      id: "bad-extra",
      operation: "code_graph.api-view",
      input: {
        action: "lookup-text",
        config,
        roots: [],
        lookups: [],
        extra: true,
      },
    },
  ];
  const requests = [...cases, ...invalid];
  const run = spawnSync(binary, [manifest], {
    input: `${requests.map((row) => JSON.stringify(row)).join("\n")}\n`,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, TMPDIR: temp },
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stderr, "");
  const reply = z.strictObject({
    id: z.string().nullable(),
    ok: z.boolean(),
    output: z.unknown().optional(),
    error: z.object({ tag: z.string(), message: z.string() }).optional(),
    observedCalls: z.array(z.string()),
  });
  const answers = run.stdout
    .trimEnd()
    .split("\n")
    .map((line) => reply.parse(JSON.parse(line)));
  assert.equal(answers.length, requests.length);
  const failures = [];
  const qualifications: ("exact" | "backend-offset" | null)[] = cases.map(
    () => null,
  );
  for (const [index, row] of cases.entries()) {
    try {
      assert.equal(answers[index].id, row.id);
      assert.equal(
        answers[index].ok,
        true,
        JSON.stringify(answers[index].error),
      );
      assert.ok(answers[index].observedCalls.length);
      assert.deepEqual(
        contract(answers[index].output),
        contract(expected[index]),
      );
      if (isDeepStrictEqual(answers[index].output, expected[index])) {
        qualifications[index] = "exact";
      } else {
        assert.deepEqual(
          backendOffsets(answers[index].output),
          backendOffsets(expected[index]),
        );
        qualifications[index] = "backend-offset";
      }
    } catch (error) {
      failures.push({
        id: row.id,
        error: String(error),
        expected: expected[index],
        native: answers[index],
      });
    }
  }
  for (const [index] of invalid.entries()) {
    const answer = answers[cases.length + index];
    assert.equal(answer.ok, false);
    assert.deepEqual(answer.observedCalls, []);
  }
  const report = {
    passed: cases.length - failures.length,
    attempted: cases.length,
    unqualifiedPairs: qualifications.filter((value) => value === "exact")
      .length,
    backendOffsetQualifiedPairs: qualifications.filter(
      (value) => value === "backend-offset",
    ).length,
    rejectedInvalidInputs: invalid.length,
    comparison:
      "Exact file/root-membership/refusal-operation/raw-surrogate/cleanup contract; backend message offsets explicitly qualified and retained",
    reference: {
      node: process.version,
      v8: process.versions.v8,
      sourceHashes: Object.fromEntries(
        ["api/view.ts", "api/read.ts", "engine/tsgo.ts"].map((name) => [
          name,
          createHash("sha256")
            .update(
              fs.readFileSync(
                path.join(repository, "packages/code-graph/src", name),
              ),
            )
            .digest("hex"),
        ]),
      ),
    },
    failures,
    cases: requests.map((row, index) => ({
      ...row,
      ...answers[index],
      backendOffsetQualified:
        index < cases.length
          ? qualifications[index] === "backend-offset"
          : false,
      expected: index < cases.length ? expected[index] : { rejected: true },
      expectedContract: index < cases.length ? contract(expected[index]) : null,
      nativeContract:
        index < cases.length && answers[index].ok
          ? contract(answers[index].output)
          : null,
    })),
  };
  if (process.argv[3])
    fs.writeFileSync(process.argv[3], `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(
    `${JSON.stringify({ passed: report.passed, attempted: report.attempted, rejectedInvalidInputs: invalid.length, failures: failures.map((row) => row.id) })}\n`,
  );
  assert.deepEqual(failures, []);
} finally {
  if (previous === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = previous;
  fs.rmSync(directory, { recursive: true, force: true });
}
