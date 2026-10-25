import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { recorderParity } from "./recorder-run.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));

test("failed recorder rows cannot claim foreign or duplicate case evidence", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "demlik-recorder-evidence-"));
  try {
    const baseline = await recorderParity({
      quiet: true,
      reportFile: path.join(temp, "baseline.json"),
    });
    const binary = path.join(
      process.env.CARGO_TARGET_DIR ?? path.join(root, "target"),
      "debug/recorder-parity",
    );
    const expected = Object.fromEntries(
      Object.entries(baseline.nativeEvidence).slice(0, -1),
    );
    for (const mode of ["foreign", "duplicate"]) {
      const adapter = path.join(temp, `${mode}.cjs`);
      await writeFile(
        adapter,
        `#!${process.execPath}
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const result = spawnSync(${JSON.stringify(binary)}, [], {
  input: fs.readFileSync(0), encoding: "utf8", maxBuffer: 32 * 1024 * 1024
});
if (result.error) throw result.error;
if (result.status !== 0) { process.stderr.write(result.stderr); process.exit(result.status ?? 1); }
const rows = result.stdout.trim().split("\\n").map(JSON.parse);
const row = rows[rows.length - 1];
row.id = ${JSON.stringify(mode)} === "foreign" ? "untrusted.foreign" : rows[0].id;
row.observedCalls = ["untrusted::must_never_be_evidence"];
process.stdout.write(rows.map(JSON.stringify).join("\\n") + "\\n");
`,
        { mode: 0o700 },
      );
      const report = await recorderParity({
        binary: adapter,
        quiet: true,
        allowFailures: true,
        reportFile: path.join(temp, `${mode}.json`),
      });
      assert.equal(report.failures.length, 1, mode);
      assert.equal(report.passed, baseline.passed - 1, mode);
      assert.deepEqual(report.nativeEvidence, expected, mode);
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
