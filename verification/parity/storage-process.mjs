import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const require = createRequire(import.meta.url);
const binary =
  process.env.PARITY_RUST_BIN ?? path.join(root, "target/debug/demlik-parity");
const directory = await mkdtemp(path.join(tmpdir(), "demlik-storage-process-"));
const children = new Set();
const reportFile =
  process.env.PARITY_STORAGE_REPORT ??
  path.join(root, "target/parity/storage-process.json");
process.once("SIGTERM", () => {
  for (const child of children) child.kill("SIGKILL");
});
const scope = JSON.parse(await readFile(path.join(here, "scope.json"), "utf8"));
assert.equal(process.version, scope.referenceEngine.node);
assert.equal(process.versions.v8, scope.referenceEngine.v8);
function run(command, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.add(child);
    const deadline = setTimeout(() => {
      stderr += "storage child exceeded its 15s watchdog";
      child.kill("SIGKILL");
    }, 15_000);
    deadline.unref();
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (text) => {
      stdout += text;
    });
    child.stderr.setEncoding("utf8").on("data", (text) => {
      stderr += text;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(deadline);
      children.delete(child);
      try {
        assert.equal(code, 0, `child failed: ${stderr}`);
        const response = JSON.parse(stdout);
        assert.equal(response.ok, true, JSON.stringify(response.error));
        resolve(response.output);
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(
      `${JSON.stringify({ id: "process", operation: "tea.storage.file", input })}\n`,
    );
  });
}
const results = [];
try {
  for (const [language, command, args] of [
    [
      "TypeScript",
      process.execPath,
      ["--import", require.resolve("tsx"), path.join(here, "typescript.mts")],
    ],
    ["Rust", binary, []],
  ]) {
    const state = path.join(directory, language, "state.json");
    const call = (actions) =>
      run(command, args, { path: state, fenced: true, actions });
    const initial = await call([{ op: "loadFenced" }]);
    assert.deepEqual(initial.observations, [
      { op: "loadFenced", raw: null, version: 0 },
    ]);
    const writers = await Promise.all(
      Array.from({ length: 6 }, (_, owner) =>
        call([
          { op: "saveFenced", json: JSON.stringify({ owner }), expected: 0 },
        ]),
      ),
    );
    const winners = writers.flatMap((output, owner) =>
      output.observations[0].op === "saveFenced" ? [owner] : [],
    );
    assert.equal(
      winners.length,
      1,
      "exactly one independent process may win expected version zero",
    );
    for (const output of writers) {
      const item = output.observations[0];
      if (item.error) {
        assert.equal(item.error._tag, "store_conflict");
        assert.equal(item.error.expectedVersion, 0);
        assert.equal(item.error.actualVersion, 1);
      } else assert.equal(item.version, 1);
    }
    const restored = await call([{ op: "loadFenced" }, { op: "restore" }]);
    assert.deepEqual(restored.observations, [
      { op: "loadFenced", raw: { owner: winners[0] }, version: 1 },
      { op: "restore", raw: { owner: winners[0] } },
    ]);
    assert.equal(await readFile(`${state}.fence`, "utf8"), "1");
    assert.equal(
      await readFile(state, "utf8"),
      JSON.stringify({ owner: winners[0] }),
    );
    const reclaimed = await call([
      { op: "deadLock" },
      { op: "saveFenced", json: '{"restarted":true}', expected: 1 },
    ]);
    assert.deepEqual(reclaimed.observations, [
      { op: "deadLock" },
      { op: "saveFenced", version: 2 },
    ]);
    const afterRestart = await call([
      { op: "loadFenced" },
      { op: "delete" },
      { op: "loadFenced" },
    ]);
    assert.deepEqual(afterRestart.observations, [
      { op: "loadFenced", raw: { restarted: true }, version: 2 },
      { op: "delete" },
      { op: "loadFenced", raw: null, version: 0 },
    ]);
    results.push({
      language,
      independentWriters: 6,
      winners: 1,
      restartedReads: 3,
      terminatedPidReclaimed: true,
      deletionReset: true,
    });
  }
  await mkdir(path.join(root, "target/parity"), { recursive: true });
  await writeFile(
    reportFile,
    `${JSON.stringify({ node: process.version, v8: process.versions.v8, platform: process.platform, results }, null, 2)}\n`,
  );
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
} finally {
  for (const child of children) child.kill("SIGKILL");
  await rm(directory, { recursive: true, force: true });
}
