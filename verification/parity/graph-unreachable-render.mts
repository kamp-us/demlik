import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { assembleGraph } from "../../packages/code-graph/src/extract/assemble.js";
import { loadCheapProject } from "../../packages/code-graph/src/extract/project.js";
import { renderUnreachable } from "../../packages/code-graph/src/render/analysis.js";
import {
  type ReachabilityReport,
  ThresholdsSchema,
} from "../../packages/code-graph/src/schema.js";

const binary = path.resolve(process.argv[2] ?? "");
const output = process.argv[3];
assert.ok(output);
assert.equal(process.version, "v22.21.1");
assert.equal(process.versions.v8, "12.4.254.21-node.33");
const repo = fileURLToPath(new URL("../..", import.meta.url));
const require = createRequire(
  path.join(repo, "packages/code-graph/package.json"),
);
const manifest = require.resolve("@typescript/native-preview/package.json");
const temp = fs.mkdtempSync(
  path.join(repo, "target/parity/unreachable-render-"),
);
const hash = (b: Buffer | string) =>
  createHash("sha256").update(b).digest("hex");
const sourceFile = path.join(
  repo,
  "packages/code-graph/src/render/analysis.ts",
);
const sourceSha = hash(fs.readFileSync(sourceFile));
const loaded = loadCheapProject(temp);
assert.equal(
  loaded.sourceFiles.length,
  0,
  "intentionally empty constructor fixture",
);
const graph = assembleGraph(loaded, ThresholdsSchema.parse({}));
const sample: ReachabilityReport = {
  entryCount: 2,
  exportedCount: 7,
  reachableCount: 4,
  unreachable: [
    {
      id: "z.ts:unused",
      file: "z.ts",
      startLine: 3,
      category: "only-called-from-tests",
      testReferences: ["z.test.ts", "a.test.ts"],
    },
    {
      id: "a.ts:dead",
      file: "a.ts",
      startLine: 1,
      category: "dead",
      testReferences: [],
    },
  ],
  withheld: [
    { id: "t", reason: "test-support-surface" },
    { id: "r", reason: "referenced-in-non-test-file" },
    { id: "p", reason: "public-entry-surface" },
    { id: "p2", reason: "public-entry-surface" },
  ],
  unguarded: [],
};
const inputs = [
  { id: "missing-text", report: null, json: false, pretty: false },
  { id: "missing-json-still-text", report: null, json: true, pretty: true },
  {
    id: "empty-text",
    report: {
      entryCount: 0,
      exportedCount: 0,
      reachableCount: 0,
      unreachable: [],
      withheld: [],
      unguarded: [],
    },
    json: false,
    pretty: false,
  },
  { id: "json-projection", report: sample, json: true, pretty: false },
  { id: "json-pretty", report: sample, json: true, pretty: true },
  { id: "test-witnesses", report: sample, json: false, pretty: false },
  { id: "pretty-ignored-human", report: sample, json: false, pretty: true },
  { id: "withheld-tally", report: sample, json: false, pretty: false },
  {
    id: "unicode-scalar",
    report: {
      ...sample,
      unreachable: [
        {
          id: "𐀀\ue000\0\tname",
          file: 'quote".ts',
          startLine: 2,
          category: "dead" as const,
          testReferences: ["line\nname", "a,b"],
        },
      ],
    },
    json: false,
    pretty: false,
  },
  {
    id: "unicode-json",
    report: {
      ...sample,
      unreachable: [
        {
          id: "𐀀\ue000\0\tname",
          file: 'quote".ts',
          startLine: 2,
          category: "dead" as const,
          testReferences: ["line\nname", "a,b"],
        },
      ],
    },
    json: true,
    pretty: false,
  },
];
const selected = process.env.DEMLIK_UNREACHABLE_RENDER_CASES?.split(",");
if (selected)
  assert.ok(selected.every((id) => inputs.some((c) => c.id === id)));
const response = z.strictObject({
  id: z.string(),
  result: z.string(),
  calls: z
    .array(z.literal("demlik_code_graph::render::analysis::render_unreachable"))
    .length(1),
});
const cases: Record<string, unknown>[] = [],
  failures: { id: string; kind: string; message: string }[] = [];
try {
  for (const input of inputs) {
    if (selected && !selected.includes(input.id)) continue;
    graph.reachability = input.report;
    const expected = renderUnreachable(graph, input.json, input.pretty);
    const request = {
      id: input.id,
      operation: "ordinary-render",
      input: {
        root: temp,
        report:
          input.report === null
            ? null
            : (({ unguarded: _unused, ...facts }) => facts)(input.report),
        json: input.json,
        pretty: input.pretty,
      },
    };
    const child = spawnSync(binary, [manifest], {
      input: `${JSON.stringify(request)}\n`,
      encoding: "utf8",
      maxBuffer: 8 << 20,
    });
    let actual: unknown,
      kind = "protocol",
      passed = false;
    try {
      assert.ifError(child.error);
      assert.equal(child.status, 0, child.stderr);
      actual = response.parse(JSON.parse(child.stdout));
      kind = "semantic";
      const parsed = response.parse(actual);
      assert.equal(parsed.id, input.id);
      assert.equal(parsed.result, expected);
      if (input.id === "json-projection")
        assert.deepEqual(Object.keys(JSON.parse(parsed.result)), [
          "entryCount",
          "unreachable",
          "withheld",
        ]);
      if (input.id === "test-witnesses")
        assert.ok(parsed.result.includes("  <- z.test.ts, a.test.ts"));
      if (input.id === "withheld-tally")
        assert.ok(
          parsed.result.endsWith(
            "  public-entry-surface  2\n  referenced-in-non-test-file  1\n  test-support-surface  1",
          ),
        );
      assert.ok(!parsed.result.endsWith("\n"));
      passed = true;
    } catch (error) {
      failures.push({ id: input.id, kind, message: String(error) });
    }
    cases.push({
      id: input.id,
      input,
      expected,
      actual,
      passed,
      process: { status: child.status, stderr: child.stderr },
    });
  }
  assert.equal(hash(fs.readFileSync(sourceFile)), sourceSha);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(
  output,
  `${JSON.stringify(
    {
      passed: cases.filter((c) => c.passed).length,
      cases,
      failures,
      binary: { path: binary, sha256: hash(fs.readFileSync(binary)) },
      source: { path: sourceFile, sha256: sourceSha },
      scope:
        "Pure typed Graph report constructor fixtures only; no extraction/CLI credit, no arbitrary raw Graph/string/number codec claim",
    },
    null,
    2,
  )}\n`,
);
console.log(
  JSON.stringify({ passed: cases.filter((c) => c.passed).length, failures }),
);
if (failures.length) process.exitCode = 1;
