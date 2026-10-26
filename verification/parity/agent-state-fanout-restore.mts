import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url)),
  hash = (value: Buffer | string) =>
    createHash("sha256").update(value).digest("hex");
export function fanoutRestoreCases() {
  const empty = {
    pending: [],
    running: [],
    done: [],
    failed: [],
    items: [],
    waveDoneFrom: 0,
    waveFailedFrom: 0,
    joined: false,
  };
  const cases = [
    { id: "empty", value: empty },
    {
      id: "duplicates-order",
      value: {
        ...empty,
        pending: [{ id: "b" }, { id: "a" }, { id: "b" }],
        running: [{ id: "z" }, { id: "z" }],
      },
    },
    {
      id: "done-undefined",
      value: {
        ...empty,
        done: [
          { item: { id: "a" } },
          { item: { id: "a" }, result: null },
          { item: { id: "b" }, result: { "\ud800": 7 } },
        ],
        waveDoneFrom: 2,
      },
    },
    {
      id: "failed-undefined",
      value: {
        ...empty,
        failed: [
          { item: 1 },
          { item: 1, error: null },
          { item: 2, error: { _tag: "denied", "\udfff": "keep" } },
        ],
        waveFailedFrom: 1,
      },
    },
    {
      id: "all-ledgers",
      value: {
        ...empty,
        pending: [2, 2, 1],
        running: [3],
        done: [{ item: 4, result: 5 }],
        failed: [{ item: 6, error: { reason: "bad" } }],
        waveDoneFrom: 1,
        waveFailedFrom: 1,
        joined: true,
      },
    },
    {
      id: "queue-duplicates",
      value: {
        ...empty,
        items: [
          { id: "same", input: { v: 1 }, status: "running", enqueuedAt: 0 },
          { id: "same", input: { v: 2 }, status: "pending", enqueuedAt: 1 },
        ],
      },
    },
    {
      id: "queue-undefined-input",
      value: {
        ...empty,
        items: [{ id: "missing", status: "running", enqueuedAt: 0 }],
      },
    },
    { id: "joined-empty", value: { ...empty, joined: true } },
  ];
  return cases.map((x) => ({
    id: `agent-state-fanout.${x.id}`,
    encoded: JSON.stringify(x.value),
  }));
}
export function fanoutRestoreParity(
  options: {
    binary?: string;
    reportFile?: string;
    allowFailures?: boolean;
    caseIds?: string[];
  } = {},
) {
  assert.equal(process.version, "v22.21.1");
  const binary =
      options.binary ??
      path.join(root, "target/debug/examples/agent_fanout_restore_driver"),
    all = fanoutRestoreCases(),
    cases = options.caseIds
      ? all.filter((x) => options.caseIds?.includes(x.id))
      : all;
  const r = spawnSync(binary, [], {
    cwd: root,
    input: `${cases.map((x) => JSON.stringify(x)).join("\n")}\n`,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, "");
  const native = r.stdout
    .trim()
    .split("\n")
    .map((x) => JSON.parse(x));
  assert.equal(native.length, cases.length);
  const failures: unknown[] = [],
    nativeEvidence: Record<string, string[]> = {};
  for (let i = 0; i < cases.length; i++) {
    const t = cases[i],
      v = JSON.parse(t.encoded),
      expected = {
        value: JSON.parse(JSON.stringify(v)),
        doneUndefined: v.done.map(
          (x: { result?: unknown }) => x.result === undefined,
        ),
        failedUndefined: v.failed.map(
          (x: { error?: unknown }) => x.error === undefined,
        ),
      };
    try {
      assert.equal(native[i].id, t.id);
      assert.deepEqual(native[i].output, expected);
      assert.deepEqual(native[i].observedCalls, [
        "serde::Deserialize::deserialize<demlik_tea::flow::fan_out::FanOutState>",
      ]);
      nativeEvidence[t.id] = native[i].observedCalls;
    } catch (error) {
      failures.push({
        id: t.id,
        message: error instanceof Error ? error.message : String(error),
        source: expected,
        native: native[i],
      });
    }
  }
  const report = {
    cases: cases.length,
    passed: cases.length - failures.length,
    failures,
    nativeEvidence,
    binarySha256: hash(fs.readFileSync(binary)),
    sourceSha256: hash(
      fs.readFileSync(path.join(root, "crates/tea/src/flow/fan_out.rs")),
    ),
    profile:
      "Direct conditional restore of canonical JSON-produced known FanOut fields; order, duplicates, omissions and failures retained without transitions or normalization.",
  };
  const out =
    options.reportFile ??
    path.join(root, "target/parity/agent-state-fanout-restore.json");
  fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  if (!options.allowFailures) assert.deepEqual(failures, []);
  return report;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const r = fanoutRestoreParity();
  console.log(JSON.stringify({ cases: r.cases, passed: r.passed }));
}
