import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const require = createRequire(import.meta.url);
export async function runtimeDeadlineParity(cargo, options = {}) {
  const reportFile =
    options.reportFile ??
    path.join(root, "target/parity/runtime-deadline.json");
  await mkdir(path.dirname(reportFile), { recursive: true });
  await rm(reportFile, { force: true });
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      require.resolve("tsx"),
      path.join(here, "runtime-deadline.mts"),
      "--report",
      reportFile,
      ...(options.binary ? ["--native-binary", options.binary] : []),
      ...(options.mutation ? ["--mutation-check"] : []),
    ],
    {
      cwd: root,
      env: { ...process.env, CARGO: cargo },
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  if (result.error) throw result.error;
  assert.ok(
    result.status === 0 || result.status === 1,
    `deadline verifier failed: ${result.stderr}`,
  );
  let report;
  try {
    report = JSON.parse(await readFile(reportFile, "utf8"));
  } catch (error) {
    throw new Error(
      `deadline verifier did not produce a report: ${result.stderr}`,
      {
        cause: error,
      },
    );
  }
  assert.equal(report.cases.length, report.compared);
  assert.equal(report.passed, report.cases.filter((item) => item.equal).length);
  assert.equal(result.status, report.failures.length ? 1 : 0);
  return {
    cases: report.compared,
    passed: report.passed,
    failures: report.failures,
    nativeEvidence: Object.fromEntries(
      report.cases
        .filter((item) => item.equal)
        .map((item) => {
          assert.ok(
            item.observedRustCalls.length > 0,
            `${item.id}: no native calls`,
          );
          return [item.id, item.observedRustCalls];
        }),
    ),
    binarySha256: report.binary.sha256,
    controls: report.controls,
    reportFile,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const mutation = process.argv.includes("--mutation-check");
  const report = await runtimeDeadlineParity(process.env.CARGO ?? "cargo", {
    mutation,
    reportFile: mutation
      ? path.join(root, "target/parity/runtime-deadline-mutation.json")
      : undefined,
  });
  process.stdout.write(
    `${JSON.stringify({ ...report, nativeEvidence: { cases: Object.keys(report.nativeEvidence).length } }, null, 2)}\n`,
  );
  if (report.failures.length) process.exitCode = 1;
}
