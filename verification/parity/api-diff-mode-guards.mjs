import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { apiDiffModeParity } from "./api-diff-mode-run.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const controls = [
  {
    name: "foreign-id",
    ids: ["api-workflow.diff.dirty-default", "api-workflow.mode.inactive"],
    rejected: "api-workflow.mode.inactive",
  },
  {
    name: "duplicate-id",
    ids: ["api-workflow.diff.dirty-default", "api-workflow.mode.inactive"],
    rejected: "api-workflow.mode.inactive",
  },
  {
    name: "untrusted-marker",
    ids: ["api-workflow.mode.out-failure"],
    rejected: "api-workflow.mode.out-failure",
  },
  {
    name: "wrong-qualified-failure",
    ids: ["api-workflow.mode.out-failure"],
    rejected: "api-workflow.mode.out-failure",
  },
];
export async function apiDiffModeGuards(options = {}) {
  const binary = path.resolve(
    options.binary ??
      path.join(
        process.env.CARGO_TARGET_DIR ?? path.join(root, "target"),
        "debug/api_mode_driver",
      ),
  );
  const artifactHash = hash(fs.readFileSync(binary));
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "demlik-api-workflow-guards-")),
  );
  const detected = [],
    failures = [];
  try {
    for (const control of controls) {
      const adapter = path.join(directory, control.name);
      fs.writeFileSync(
        adapter,
        `#!${process.execPath}
import {spawnSync} from "node:child_process";
import fs from "node:fs";
const result=spawnSync(${JSON.stringify(binary)},process.argv.slice(2),{input:fs.readFileSync(0),maxBuffer:128*1024*1024});
if(result.status!==0) throw new Error(result.stderr.toString());
process.stderr.write(result.stderr);
const rows=result.stdout.toString().trim().split("\\n").map(JSON.parse);
const row=rows.find(row=>row.id===${JSON.stringify(control.rejected)});
if(row){
  const kind=${JSON.stringify(control.name)};
  if(kind==="foreign-id") {row.id="foreign-case";row.observedCalls.push("untrusted::call");}
  if(kind==="duplicate-id") {row.id=rows[0].id;row.observedCalls.push("untrusted::call");}
  if(kind==="untrusted-marker") row.observedCalls.push("untrusted::call");
  if(kind==="wrong-qualified-failure") {row.nativeDetails.processing.variant="callback";delete row.nativeDetails.processing.path;}
}
process.stdout.write(rows.map(row=>JSON.stringify(row)).join("\\n")+"\\n");
`,
      );
      fs.chmodSync(adapter, 0o755);
      try {
        const report = await apiDiffModeParity({
          binary: adapter,
          compiler: options.compiler,
          caseIds: control.ids,
          quiet: true,
          allowFailures: true,
          reportFile: path.join(
            root,
            `target/parity/api-diff-mode-guards/${control.name}.json`,
          ),
        });
        assert.deepEqual(
          report.failures.map((failure) => failure.id),
          [control.rejected],
        );
        assert.ok(!Object.hasOwn(report.nativeEvidence, control.rejected));
        assert.ok(
          !Object.hasOwn(report.qualifiedNativeEvidence, control.rejected),
        );
        assert.ok(!Object.hasOwn(report.nativeErrors, control.rejected));
        for (const evidence of [
          report.nativeEvidence,
          report.qualifiedNativeEvidence,
        ]) {
          assert.ok(!Object.hasOwn(evidence, "foreign-case"));
          assert.ok(
            !Object.values(evidence).some((calls) =>
              calls.includes("untrusted::call"),
            ),
          );
        }
        detected.push({
          name: control.name,
          rejected: control.rejected,
          realCompiledBinary: true,
          selectedIds: control.ids,
        });
      } catch (error) {
        failures.push({ name: control.name, message: error.message });
      }
    }
    assert.equal(hash(fs.readFileSync(binary)), artifactHash);
    const report = {
      node: process.version,
      v8: process.versions.v8,
      passed: detected.length,
      attempted: controls.length,
      baselineArtifactUnchanged: true,
      baselineArtifactHash: artifactHash,
      controls: detected,
      failures,
    };
    const reportFile =
      options.reportFile ??
      path.join(root, "target/parity/api-diff-mode-guards.json");
    fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
    if (!options.quiet) console.log(JSON.stringify({ ...report, reportFile }));
    if (!options.allowFailures) assert.deepEqual(failures, []);
    return report;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  await apiDiffModeGuards();
