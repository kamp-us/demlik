import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const require = createRequire(import.meta.url);

const reportFormats = {
  trace: {
    binaryArgument: "--native-binary",
    rows: "cases",
    total: "compared",
    calls: "observedRustCalls",
    binaryHash: (report) => report.binary.sha256,
  },
  llm: {
    binaryArgument: "--binary",
    rows: "results",
    total: "total",
    calls: "publicCalls",
    binaryHash: (report) => report.binaryHash,
  },
  timestamps: {
    binaryArgument: "--binary",
    rows: "results",
    total: "total",
    calls: "observedCalls",
    binaryHash: (report) => report.binaryHash,
  },
};

export async function compiledTraceParity(cargo, name, options = {}) {
  const formatName = options.format ?? "trace";
  assert.ok(Object.hasOwn(reportFormats, formatName), "unknown report format");
  const format = reportFormats[formatName];
  const reportFile =
    options.reportFile ?? path.join(root, `target/parity/${name}.json`);
  await mkdir(path.dirname(reportFile), { recursive: true });
  await rm(reportFile, { force: true });
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      require.resolve("tsx"),
      path.join(here, `${name}.mts`),
      "--report",
      reportFile,
      ...(options.binary ? [format.binaryArgument, options.binary] : []),
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
    `${name} verifier failed: ${result.stderr}`,
  );
  let report;
  try {
    report = JSON.parse(await readFile(reportFile, "utf8"));
  } catch (error) {
    throw new Error(
      `${name} verifier did not produce a report: ${result.stderr}`,
      { cause: error },
    );
  }
  const rows = report[format.rows];
  const compared = report[format.total];
  assert.equal(rows.length, compared);
  assert.equal(new Set(rows.map((item) => item.id)).size, compared);
  assert.equal(report.passed, rows.filter((item) => item.equal).length);
  assert.equal(result.status, report.failures.length ? 1 : 0);
  return {
    cases: compared,
    passed: report.passed,
    failures: report.failures,
    nativeEvidence: Object.fromEntries(
      rows
        .filter((item) => item.equal)
        .map((item) => {
          assert.ok(
            item[format.calls].length > 0,
            `${item.id}: no compiled native calls`,
          );
          return [item.id, item[format.calls]];
        }),
    ),
    binarySha256: format.binaryHash(report),
    controls: report.controls,
    scope: report.scope,
    ...(report.profile ? { profile: report.profile } : {}),
    transitions: report.transitions,
    ...(report.qualifications
      ? { qualifications: report.qualifications }
      : report.qualification
        ? { qualifications: [report.qualification] }
        : {}),
    ...(report.openGaps ? { openGaps: report.openGaps } : {}),
    ...(report.adapterAwait ? { adapterAwait: report.adapterAwait } : {}),
    ...(report.runtimeCases === undefined
      ? {}
      : { runtimeCases: report.runtimeCases }),
    ...(report.actions === undefined ? {} : { actions: report.actions }),
    reportFile,
  };
}

export async function compiledTraceMain(moduleUrl, name, options = {}) {
  if (
    !process.argv[1] ||
    moduleUrl !== pathToFileURL(path.resolve(process.argv[1])).href
  )
    return;
  const mutation = process.argv.includes("--mutation-check");
  const report = await compiledTraceParity(process.env.CARGO ?? "cargo", name, {
    ...options,
    mutation,
    reportFile: mutation
      ? path.join(root, `target/parity/${name}-mutation.json`)
      : undefined,
  });
  process.stdout.write(
    `${JSON.stringify({ ...report, nativeEvidence: { cases: Object.keys(report.nativeEvidence).length } }, null, 2)}\n`,
  );
  if (report.failures.length) process.exitCode = 1;
}
