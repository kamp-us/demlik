import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { apiDiffModeCases } from "./api-diff-mode-cases.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url)),
  here = path.dirname(fileURLToPath(import.meta.url)),
  require = createRequire(import.meta.url);
const hash = (value) => createHash("sha256").update(value).digest("hex");
function writable(dir) {
  if (fs.lstatSync(dir).isDirectory()) {
    fs.chmodSync(dir, 0o700);
    for (const name of fs.readdirSync(dir)) writable(path.join(dir, name));
  }
}
function remove(dir) {
  if (fs.existsSync(dir)) {
    writable(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
function checkoutState(repos) {
  const git = (cwd, args) => {
    const output = spawnSync("git", ["--no-optional-locks", ...args], { cwd });
    assert.equal(output.status, 0, output.stderr.toString());
    return output.stdout.toString("hex");
  };
  const files = (dir) =>
    fs
      .readdirSync(dir)
      .sort()
      .filter((name) => name !== ".git")
      .map((name) => {
        const file = path.join(dir, name),
          stat = fs.lstatSync(file);
        return [
          name,
          stat.mode & 0o7777,
          stat.isSymbolicLink()
            ? { link: fs.readlinkSync(file) }
            : stat.isDirectory()
              ? files(file)
              : hash(fs.readFileSync(file)),
        ];
      });
  return repos.map(({ root }) => ({
    root,
    files: files(root),
    index: hash(fs.readFileSync(path.join(root, ".git/index"))),
    status: git(root, ["status", "--porcelain=v1", "-z"]),
    head: git(root, ["rev-parse", "HEAD"]),
    refs: git(root, ["show-ref", "--head"]),
    stash: git(root, ["stash", "list"]),
  }));
}
function warnings(stderr) {
  const result = new Map();
  let current;
  for (const line of stderr.split("\n")) {
    if (line.startsWith("API_CASE ")) {
      current = JSON.parse(line.slice(9));
      assert.ok(!result.has(current));
      result.set(current, []);
    } else if (line !== "") {
      assert.ok(current, `unattributed stderr: ${line}`);
      result.get(current).push(line);
    }
  }
  return result;
}
function projection(row, test) {
  const output = structuredClone(row.output);
  if (
    test.qualification === "backendDiffError" ||
    test.qualification === "cleanupError"
  )
    delete output.error.message;
  if (test.qualification === "backendModeReport")
    for (const event of output.events)
      if (event.kind === "report") {
        assert.ok(event.message.startsWith("unexpected error: "));
        event.message = "unexpected error: <native backend diagnostic>";
      }
  return output;
}
const marker = {
  diff: "demlik_code_graph::api::diff::diff_published_api_blocking",
  mapped:
    "demlik_code_graph::api::diff::prepare_api_diff_with_base_map_blocking",
  flags: "demlik_code_graph::api::cli::run_api_flags_blocking",
  view: "demlik_code_graph::api::cli::run_api_view_blocking",
};
function assertQualified(test, source, nativeDetails, temps) {
  switch (test.qualification) {
    case "backendDiffError":
      assert.match(source.error.message, /^ENOENT:/);
      assert.equal(nativeDetails.variant, "io");
      assert.ok(nativeDetails.path.endsWith("/packages/demo/missing.json"));
      break;
    case "cleanupError": {
      assert.match(source.error.message, /^EACCES:/);
      const cleanup = nativeDetails.cleanup ?? nativeDetails;
      assert.equal(cleanup.variant, "io");
      assert.ok(cleanup.path.startsWith(`${temps}/code-graph-api-base-`));
      break;
    }
    case "backendModeReport":
      assert.match(
        source.events.find((event) => event.kind === "report").message,
        /^unexpected error: ENOENT:/,
      );
      assert.equal(nativeDetails.processing.variant, "io");
      assert.equal(nativeDetails.processing.path, test.input.outFile);
      break;
  }
}
function assertLiteral(id, output, details) {
  switch (id) {
    case "api-workflow.diff.dirty-default": {
      const current = output.value.subpaths["."];
      assert.deepEqual(Object.keys(current.added).sort(), [
        "extra",
        "untracked",
      ]);
      assert.deepEqual(Object.keys(current.removed), ["legacy"]);
      assert.deepEqual(Object.keys(current.changed), ["parse"]);
      assert.equal(
        current.changed.parse.after.text,
        "export declare function parse(text: string, radix?: number): number;",
      );
      break;
    }
    case "api-workflow.diff.base-map-file-async":
      assert.equal(output.baseMap.calls, 1);
      assert.deepEqual(output.baseMap.existsAfter, [false]);
      assert.deepEqual(Object.keys(output.value.subpaths), [".", "./removed"]);
      assert.equal(output.value.subpaths["."].tier, "stable");
      assert.equal(output.value.subpaths["./removed"].tier, "base-only");
      assert.deepEqual(
        Object.keys(output.value.subpaths["./removed"].removed),
        ["onlyBase"],
      );
      break;
    case "api-workflow.diff.empty-current-refusal":
    case "api-workflow.diff.empty-current-before-warn":
      assert.equal(output.error.name, "ApiInputError");
      assert.equal(
        output.error.message,
        "invalid API map: (root): the API map names no subpath",
      );
      assert.equal(output.baseMap.calls, 0);
      assert.deepEqual(output.warnings, []);
      break;
    case "api-workflow.diff.before-package-skips-callback":
    case "api-workflow.diff.base-package-file-skips-callback":
    case "api-workflow.diff.current-warning-input":
      assert.equal(output.baseMap.calls, 0);
      break;
    case "api-workflow.diff.no-base-rows-skips-emit":
      assert.ok(output.value);
      break;
    case "api-workflow.diff.both-warning-contexts":
      assert.equal(output.warnings.length, 2);
      assert.match(output.warnings[1], / at the base [a-f0-9]{12};/);
      break;
    case "api-workflow.mode.ratchet-miss-false-false":
      assert.equal(output.code, 1);
      break;
    case "api-workflow.mode.ratchet-met-false-false":
      assert.equal(output.code, 0);
      break;
    case "api-workflow.mode.inactive":
      assert.equal(output.code, null);
      assert.deepEqual(output.events, []);
      break;
    case "api-workflow.mode.emit-callback-raw":
      assert.equal(output.code, 3);
      assert.equal(
        output.events[1].message,
        "unexpected error: ordinary\ud800 failure\u0085end",
      );
      break;
    case "api-workflow.mode.emit-callback-looking":
      assert.equal(output.code, 3);
      break;
    case "api-workflow.mode.emit-input-raw":
    case "api-workflow.mode.emit-cleanup-input-raw":
      assert.equal(output.code, 2);
      break;
    case "api-workflow.mode.emit-then-report-fails":
      assert.equal(details.processing.variant, "callback");
      assert.equal(details.report.variant, "callback");
      assert.equal(details.processing.visible.message, "first\ud800");
      assert.equal(details.report.visible.message, "report\udc00");
      break;
    case "api-workflow.mode.stray-report-fails":
      assert.ok(!details.processing);
      break;
    case "api-workflow.diff.callback-cleanup-failure":
      assert.equal(details.variant, "compound");
      assert.equal(details.operation.variant, "input");
      assert.equal(details.operation.visible.message, "first callback refusal");
      assert.equal(details.cleanup.variant, "io");
      break;
  }
}
export async function apiDiffModeParity(options = {}) {
  assert.equal(process.version, "v22.21.1");
  assert.equal(process.versions.v8, "12.4.254.21-node.33");
  const binary =
    options.binary ??
    path.join(
      process.env.CARGO_TARGET_DIR ?? path.join(root, "target"),
      "debug/api_mode_driver",
    );
  if (!options.binary)
    execFileSync(
      process.env.CARGO ?? "cargo",
      ["build", "--locked", "-p", "demlik-parity", "--bin", "api_mode_driver"],
      {
        cwd: root,
        stdio: "pipe",
        env: {
          ...process.env,
          CARGO_PROFILE_DEV_DEBUG: "0",
          CARGO_PROFILE_TEST_DEBUG: "0",
          CARGO_INCREMENTAL: "0",
          CARGO_BUILD_JOBS: "1",
        },
      },
    );
  const manifest = JSON.parse(
    fs.readFileSync(
      path.join(
        root,
        "packages/code-graph/node_modules/@typescript/native-preview/package.json",
      ),
      "utf8",
    ),
  );
  assert.equal(manifest.version, "7.0.0-dev.20260707.2");
  const preview = path.dirname(
    fs.realpathSync(
      path.join(
        root,
        "packages/code-graph/node_modules/@typescript/native-preview/package.json",
      ),
    ),
  );
  const executable = await import(
    pathToFileURL(path.join(preview, "lib/getExePath.js")).href
  );
  const compiler = options.compiler ?? executable.default();
  const fixture = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "demlik-api-workflow-pairs-")),
    ),
    temps = path.join(fixture, "temps");
  fs.mkdirSync(temps);
  try {
    const {
      cases: available,
      repos,
      recipes,
      outputs,
    } = apiDiffModeCases(fixture);
    assert.equal(new Set(available.map((c) => c.id)).size, available.length);
    if (options.caseIds !== undefined) {
      assert.ok(Array.isArray(options.caseIds) && options.caseIds.length > 0);
      assert.equal(new Set(options.caseIds).size, options.caseIds.length);
      for (const id of options.caseIds)
        assert.ok(
          available.some((test) => test.id === id),
          `unknown case: ${id}`,
        );
    }
    const cases = options.caseIds
      ? available.filter((test) => options.caseIds.includes(test.id))
      : available;
    const expectedCleanupResidues = cases.filter(
      (test) => test.input.baseMap?.readonly,
    ).length;
    const input = `${cases
        .map(({ qualification, ...test }) => JSON.stringify(test))
        .join("\n")}\n`,
      before = checkoutState(repos);
    const run = (program, args, text = input) => {
      const value = spawnSync(program, args, {
        cwd: root,
        input: text,
        encoding: "utf8",
        maxBuffer: 128 * 1024 * 1024,
        env: { ...process.env, TMPDIR: temps },
      });
      assert.equal(value.status, 0, value.stderr);
      return {
        rows: value.stdout
          .trim()
          .split("\n")
          .map((row) => JSON.parse(row)),
        warnings: warnings(value.stderr),
      };
    };
    const source = run(process.execPath, [
      "--import",
      require.resolve("tsx"),
      path.join(here, "api-diff-mode-reference.mts"),
    ]);
    assert.deepEqual(
      checkoutState(repos),
      before,
      "Source workflow changed checkout/index/refs",
    );
    const sourceLeaks = fs
      .readdirSync(temps)
      .filter((name) => name.startsWith("code-graph-api-"));
    assert.equal(
      sourceLeaks.length,
      expectedCleanupResidues,
      "Source retains only the selected real cleanup refusals",
    );
    for (const name of sourceLeaks) remove(path.join(temps, name));
    const sourceFiles = Object.fromEntries(
      fs
        .readdirSync(outputs)
        .map((name) => [
          name,
          fs.readFileSync(path.join(outputs, name)).toString("hex"),
        ]),
    );
    for (const name of fs.readdirSync(outputs))
      fs.unlinkSync(path.join(outputs, name));
    const native = run(binary, [compiler]);
    assert.deepEqual(
      checkoutState(repos),
      before,
      "native workflow changed checkout/index/refs",
    );
    const nativeLeaks = fs
      .readdirSync(temps)
      .filter((name) => name.startsWith("code-graph-api-"));
    const nativeFiles = Object.fromEntries(
      fs
        .readdirSync(outputs)
        .map((name) => [
          name,
          fs.readFileSync(path.join(outputs, name)).toString("hex"),
        ]),
    );
    const failures = [],
      nativeEvidence = {},
      qualifiedNativeEvidence = {},
      nativeErrors = {};
    assert.equal(source.rows.length, cases.length);
    assert.equal(native.rows.length, cases.length);
    for (let i = 0; i < cases.length; i++)
      try {
        const test = cases[i],
          left = source.rows[i],
          right = native.rows[i];
        assert.equal(left.id, test.id);
        assert.equal(right.id, test.id);
        assert.equal(left.ok, true);
        assert.equal(right.ok, true);
        assert.deepEqual(projection(right, test), projection(left, test));
        if (right.output.value?.subpaths)
          assert.deepEqual(
            Object.keys(right.output.value.subpaths),
            Object.keys(left.output.value.subpaths),
            "observable subpath key order",
          );
        assertLiteral(test.id, right.output, right.nativeDetails);
        assertQualified(test, left.output, right.nativeDetails, temps);
        assert.deepEqual(
          native.warnings.get(test.id) ?? [],
          source.warnings.get(test.id) ?? [],
        );
        const called =
          test.operation === "mode"
            ? marker[test.input.entry]
            : test.input.baseMap
              ? marker.mapped
              : marker.diff;
        const expectedCalls = [called];
        if (
          test.operation === "diff" &&
          test.input.baseMap &&
          left.output.baseMap.calls > 0
        )
          expectedCalls.push(
            "demlik_code_graph::api::diff::BaseMapRequest::finish_blocking",
          );
        assert.deepEqual(
          right.observedCalls,
          expectedCalls,
          "only actual declared public calls are evidence",
        );
        (test.qualification ? qualifiedNativeEvidence : nativeEvidence)[
          test.id
        ] = right.observedCalls;
        if (right.nativeDetails) nativeErrors[test.id] = right.nativeDetails;
      } catch (error) {
        failures.push({
          id: cases[i].id,
          qualification: cases[i].qualification ?? null,
          message: error.message,
          source: source.rows[i],
          native: native.rows[i],
        });
      }
    if (nativeLeaks.length !== expectedCleanupResidues)
      failures.push({
        id: "api-workflow.temp-lifecycle",
        message: `expected ${expectedCleanupResidues} typed cleanup residues, got ${nativeLeaks.length}`,
        nativeLeaks,
      });
    if (JSON.stringify(nativeFiles) !== JSON.stringify(sourceFiles))
      failures.push({
        id: "api-workflow.out-file-bytes",
        message: "Source/native emitted file bytes differ",
        sourceFiles,
        nativeFiles,
      });
    const invalid = [
      null,
      {},
      { id: "bad", operation: "other", input: {} },
      {
        id: "mode",
        operation: "mode",
        input: {
          root: "x",
          given: [],
          json: false,
          pretty: false,
          entry: "view",
        },
      },
      {
        id: "extra",
        operation: "diff",
        input: { root: "x", map: {}, base: "HEAD", extra: true },
      },
      {
        id: "null-string",
        operation: "mode",
        input: {
          root: "x",
          mapFile: null,
          given: [],
          json: false,
          pretty: false,
          entry: "flags",
        },
      },
      {
        id: "bad-map-callback",
        operation: "diff",
        input: { root: "x", map: {}, base: "HEAD", baseMap: { kind: "file" } },
      },
    ];
    const invalidText = `${invalid.map((row) => JSON.stringify(row)).join("\n")}\n`,
      left = run(
        process.execPath,
        [
          "--import",
          require.resolve("tsx"),
          path.join(here, "api-diff-mode-reference.mts"),
        ],
        invalidText,
      ),
      right = run(binary, [compiler], invalidText);
    assert.ok(left.rows.every((row) => !row.ok));
    assert.ok(right.rows.every((row) => !row.ok));
    assert.ok(right.rows.every((row) => row.observedCalls.length === 0));
    const qualified = cases
      .filter((test) => test.qualification)
      .map((test) => ({
        id: test.id,
        qualification: test.qualification,
        source: source.rows[cases.indexOf(test)].output,
        native: native.rows[cases.indexOf(test)].output,
      }));
    const report = {
      reference: "75de37ea01a81cd7949e6275b7ee9cfdeb4e312d",
      node: process.version,
      v8: process.versions.v8,
      compiler: {
        version: manifest.version,
        path: compiler,
        sha256: hash(fs.readFileSync(compiler)),
      },
      cases: cases.length,
      availableCases: available.length,
      selectedIds: cases.map((test) => test.id),
      strictCases: cases.length - qualified.length,
      qualifiedCases: qualified.length,
      passed:
        cases.length -
        failures.filter((f) => cases.some((c) => c.id === f.id)).length,
      protocolRefusals: invalid.length,
      failures,
      nativeEvidence,
      qualifiedNativeEvidence,
      nativeErrors,
      qualifications: qualified,
      sideEffects: {
        sourceCheckoutUnchanged: true,
        nativeCheckoutUnchanged: true,
        sourceCleanupResidues: sourceLeaks.length,
        nativeCleanupResidues: nativeLeaks.length,
        outFileBytesEqual:
          JSON.stringify(nativeFiles) === JSON.stringify(sourceFiles),
      },
      recipeSha256: hash(JSON.stringify(recipes)),
      inputSha256: hash(input),
      scope:
        "Native published API diff and API-mode caller only. Explicit blocking IO around a caller-owned future; no globalCLI or Promise scheduler. Backend OS diagnostic rows remain separate from strict evidence. Internal raw-option/NUL-emitter cleanup differences are inherited qualifications, not exercised as strict workflow rows.",
    };
    const reportFile =
      options.reportFile ?? path.join(root, "target/parity/api-diff-mode.json");
    fs.mkdirSync(path.dirname(reportFile), { recursive: true });
    fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
    if (!options.quiet)
      console.log(
        JSON.stringify(
          {
            ...report,
            nativeEvidence: { cases: Object.keys(nativeEvidence).length },
            qualifiedNativeEvidence: {
              cases: Object.keys(qualifiedNativeEvidence).length,
            },
            nativeErrors: { cases: Object.keys(nativeErrors).length },
            qualifications: qualified.map(({ id, qualification }) => ({
              id,
              qualification,
            })),
            failures: failures.slice(0, 6),
            reportFile,
          },
          null,
          2,
        ),
      );
    if (!options.allowFailures)
      assert.equal(failures.length, 0, `workflow failures: ${reportFile}`);
    return { ...report, reportFile };
  } finally {
    remove(fixture);
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  await apiDiffModeParity();
