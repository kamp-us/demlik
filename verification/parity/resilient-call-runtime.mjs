import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const reference = "1200ecf";
const runtimeCommit = execFileSync("git", ["rev-parse", reference], {
  cwd: root,
  encoding: "utf8",
}).trim();
const directory = await mkdtemp(
  path.join(tmpdir(), "demlik-resilient-runtime-"),
);
const archive = execFileSync(
  "git",
  [
    "archive",
    runtimeCommit,
    "Cargo.toml",
    "Cargo.lock",
    "rust-toolchain.toml",
    "crates",
  ],
  { cwd: root, maxBuffer: 64 * 1024 * 1024 },
);
execFileSync("tar", ["-xf", "-", "-C", directory], { input: archive });
const files = [
  "crates/tea/src/command.rs",
  "crates/tea/src/js_record.rs",
  "crates/tea/src/work_queue/mod.rs",
  "crates/tea/src/resilience/mod.rs",
  "crates/tea/src/resilience/cache.rs",
  "crates/tea/src/resilience/circuit_breaker.rs",
  "crates/tea/src/resilience/rate_limit.rs",
  "crates/tea/src/resilience/deadline.rs",
  "crates/tea/src/resilience/resilient_call/mod.rs",
  "crates/tea/src/resilience/resilient_call/model.rs",
  "crates/tea/src/resilience/resilient_call/decode.rs",
];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const ownerSources = {};
for (const file of files) {
  ownerSources[file] = hash(await readFile(path.join(root, file)));
  await mkdir(path.dirname(path.join(directory, file)), { recursive: true });
  await cp(path.join(root, file), path.join(directory, file));
}
const fixture = path.join(root, "crates/tea/tests/resilient_call_runtime.rs");
const consumer = await readFile(fixture);
await writeFile(
  path.join(directory, "crates/tea/tests/resilient_call_runtime.rs"),
  consumer,
);
const canonicalData = await readFile(
  path.join(directory, "crates/tea/src/data.rs"),
  "utf8",
);
assert.ok(canonicalData.includes("pub struct TimerDeps<M>"));
assert.ok(canonicalData.includes("fn into_timer<M: 'static>"));
const deadline = await readFile(
  path.join(directory, "crates/tea/src/resilience/deadline.rs"),
  "utf8",
);
assert.ok(deadline.includes("pub use crate::TimerDeps;"));
assert.ok(!deadline.includes("pub struct TimerDeps"));
const target = path.join(root, "target/parity/resilient-runtime-build");
const result = spawnSync(
  process.env.CARGO ?? "cargo",
  [
    "test",
    "--locked",
    "-p",
    "demlik-tea",
    "--test",
    "resilient_call_runtime",
    "--",
    "--nocapture",
  ],
  {
    cwd: directory,
    env: { ...process.env, CARGO_TARGET_DIR: target },
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout: 180_000,
  },
);
const reportDirectory = path.join(root, "target/parity");
await mkdir(reportDirectory, { recursive: true });
await writeFile(
  path.join(reportDirectory, "resilient-call-runtime.log"),
  result.stdout + result.stderr,
);
const report = {
  runtimeCommit,
  runtimeArchiveSha256: hash(archive),
  archiveDirectory: directory,
  canonicalDataSha256: hash(canonicalData),
  ownerSources,
  consumerSha256: hash(consumer),
  profiles: ["Promise", "Effect"],
  observedProfiles: [
    ...(result.stdout + result.stderr).matchAll(
      /resilient-runtime:(Promise|Effect):delivered:1/g,
    ),
  ].map((match) => match[1]),
  timerOverride: false,
  subscriptionOverride: false,
  status: result.status,
  signal: result.signal,
  error: result.error?.message,
};
await writeFile(
  path.join(reportDirectory, "resilient-call-runtime.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
assert.equal(result.status, 0, result.stdout + result.stderr);
assert.deepEqual(report.observedProfiles, report.profiles);
