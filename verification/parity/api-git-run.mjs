import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gitCases } from "./api-git-cases.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url)),
  here = path.dirname(fileURLToPath(import.meta.url)),
  require = createRequire(import.meta.url);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
function writable(dir) {
  if (fs.lstatSync(dir).isDirectory()) {
    fs.chmodSync(dir, 0o700);
    for (const name of fs.readdirSync(dir)) writable(path.join(dir, name));
  }
}
function remove(dir) {
  if (!fs.existsSync(dir)) return;
  writable(dir);
  fs.rmSync(dir, { recursive: true, force: true });
}
function snapshots(repos) {
  const git = (root, ...args) => {
    const value = spawnSync("git", ["--no-optional-locks", ...args], {
      cwd: root,
    });
    assert.ok(
      value.status === 0 || (args[0] === "show-ref" && value.status === 1),
    );
    return value.stdout.toString("hex");
  };
  const content = (file) => {
    try {
      return sha(fs.readFileSync(file));
    } catch (error) {
      return { readError: error.code };
    }
  };
  const walk = (dir) =>
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
            ? { target: fs.readlinkSync(file) }
            : stat.isDirectory()
              ? walk(file)
              : content(file),
        ];
      });
  return repos.map(({ root }) => ({
    root,
    status: git(root, "status", "--porcelain=v1", "-z"),
    refs: git(root, "show-ref", "--head"),
    index: fs.existsSync(path.join(root, ".git/index"))
      ? sha(fs.readFileSync(path.join(root, ".git/index")))
      : null,
    files: walk(root),
  }));
}
function projection(row, test, tempParent) {
  const output = structuredClone(row.output);
  if (!test.qualification || !output?.error) return output;
  const error = output.error;
  delete error.message;
  if (test.qualification === "archiveArgumentDiagnostic") delete error.location;
  if (test.qualification === "archiveDiagnostic") {
    assert.match(
      row.output.error.message,
      new RegExp(`^git archive of ${test.input.revision} failed: `),
    );
  }
  if (test.qualification === "filesystemDiagnostic")
    for (const key of ["path", "destination"])
      if (error[key]?.startsWith(`${tempParent}/`))
        error[key] = `<base-temp>/${error[key]
          .slice(tempParent.length + 1)
          .split("/")
          .slice(1)
          .join("/")}`;
  if (test.qualification === "cleanupDiagnostic") delete error.path;
  return output;
}
const markers = {
  checkout: "demlik_code_graph::api::base::checkout_of",
  resolve: "demlik_code_graph::api::base::resolve_base",
  names: "demlik_code_graph::api::base::names_at_base",
  read: "demlik_code_graph::api::ratchet::changesets::read_changesets_since",
  export: "demlik_code_graph::api::base::export_base_tree_blocking",
  remove: "demlik_code_graph::api::base::remove_base_tree",
};
export async function apiGitParity(options = {}) {
  assert.equal(process.version, "v22.21.1");
  assert.equal(process.versions.v8, "12.4.254.21-node.33");
  const fixture = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "demlik-api-git-parity-")),
    ),
    tempParent = path.join(fixture, "temps");
  fs.mkdirSync(tempParent);
  const binary =
    options.binary ??
    path.join(
      process.env.CARGO_TARGET_DIR ?? path.join(root, "target"),
      "debug/examples/api_git_driver",
    );
  if (!options.binary)
    execFileSync(
      process.env.CARGO ?? "cargo",
      [
        "build",
        "--locked",
        "-p",
        "demlik-code-graph",
        "--example",
        "api_git_driver",
      ],
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
  let report;
  try {
    const { cases, repos, recipes, safety } = gitCases(fixture);
    assert.equal(new Set(cases.map((c) => c.id)).size, cases.length);
    const input =
        cases
          .map(({ qualification, ...test }) => JSON.stringify(test))
          .join("\n") + "\n",
      before = snapshots(repos);
    const run = (program, args, text = input, env = {}) =>
      execFileSync(program, args, {
        cwd: root,
        input: text,
        encoding: "utf8",
        maxBuffer: 128 * 1024 * 1024,
        env: { ...process.env, TMPDIR: tempParent, ...env },
      })
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    const source = run(process.execPath, [
      "--import",
      require.resolve("tsx"),
      path.join(here, "api-git-reference.mts"),
    ]);
    assert.deepEqual(
      snapshots(repos),
      before,
      "source helper changed checkout/index/refs/files",
    );
    const safetyFile = path.join(safety.root, "out.tar"),
      safetyCase = {
        id: "api-git.archive-readonly-safety",
        operation: "export",
        input: {
          top: safety.root,
          packagePath: "packages/demo",
          revision: `--output=${safetyFile}`,
        },
      },
      safetyInput = JSON.stringify(safetyCase) + "\n";
    const sourceSafety = run(
      process.execPath,
      [
        "--import",
        require.resolve("tsx"),
        path.join(here, "api-git-reference.mts"),
      ],
      safetyInput,
    )[0];
    assert.equal(sourceSafety.output.error.name, "ApiInputError");
    assert.equal(fs.statSync(safetyFile).size, 0);
    fs.unlinkSync(safetyFile);
    const sourceLeaks = fs
      .readdirSync(tempParent)
      .filter((name) => name.startsWith("code-graph-api-base-"));
    assert.equal(
      sourceLeaks.length,
      1,
      "only measured cleanup refusal may retain a source temp",
    );
    for (const name of sourceLeaks) remove(path.join(tempParent, name));
    const removes = path.join(fixture, "removes");
    remove(removes);
    fs.mkdirSync(removes);
    fs.writeFileSync(path.join(removes, "file"), "file");
    fs.mkdirSync(path.join(removes, "directory"));
    fs.writeFileSync(path.join(removes, "directory/child"), "child");
    fs.symlinkSync(repos[0].root, path.join(removes, "symlink"));
    const native = run(binary, []);
    assert.deepEqual(
      snapshots(repos),
      before,
      "native helper changed checkout/index/refs/files",
    );
    const nativeSafety = run(binary, [], safetyInput)[0],
      nativeSafetyWrote = fs.existsSync(safetyFile);
    if (nativeSafetyWrote) fs.unlinkSync(safetyFile);
    const emptyPath = path.join(fixture, "empty-path");
    fs.mkdirSync(emptyPath);
    const missingCases = [
      {
        id: "api-git.missing-git.checkout",
        operation: "checkout",
        input: { root: repos[0].pkg },
      },
      {
        id: "api-git.missing-git.resolve",
        operation: "resolve",
        input: {
          top: repos[0].root,
          packagePath: "packages/demo",
          revision: "HEAD",
        },
      },
      {
        id: "api-git.missing-git.names",
        operation: "names",
        input: { cwd: repos[0].root, sha: repos[0].sha, dir: ".changeset/" },
        qualification: "captureDiagnostic",
      },
      {
        id: "api-git.missing-git.export",
        operation: "export",
        input: {
          top: repos[0].root,
          packagePath: "packages/demo",
          revision: repos[0].sha,
        },
        qualification: "archiveDiagnostic",
      },
    ];
    const missingInput =
      missingCases
        .map(({ qualification, ...test }) => JSON.stringify(test))
        .join("\n") + "\n";
    source.push(
      ...run(
        process.execPath,
        [
          "--import",
          require.resolve("tsx"),
          path.join(here, "api-git-reference.mts"),
        ],
        missingInput,
        { PATH: emptyPath },
      ),
    );
    native.push(...run(binary, [], missingInput, { PATH: emptyPath }));
    cases.push(...missingCases);
    const nativeLeaks = fs
      .readdirSync(tempParent)
      .filter((name) => name.startsWith("code-graph-api-base-"));
    const failures = [],
      nativeEvidence = {},
      nativeErrors = {};
    assert.equal(source.length, cases.length);
    assert.equal(native.length, cases.length);
    for (let i = 0; i < cases.length; i++) {
      try {
        const test = cases[i];
        assert.equal(source[i].id, test.id);
        assert.equal(native[i].id, test.id);
        assert.equal(source[i].ok, true);
        assert.equal(native[i].ok, true);
        assert.deepEqual(
          projection(native[i], test, tempParent),
          projection(source[i], test, tempParent),
        );
        assert.ok(native[i].observedCalls.includes(markers[test.operation]));
        nativeEvidence[test.id] = native[i].observedCalls;
        if (native[i].nativeDetails)
          nativeErrors[test.id] = native[i].nativeDetails;
      } catch (error) {
        failures.push({
          id: cases[i].id,
          qualification: cases[i].qualification ?? null,
          message: error.message,
          source: source[i],
          native: native[i],
        });
      }
    }
    if (nativeLeaks.length !== 1)
      failures.push({
        id: "api-git.export-error-temp-lifecycle",
        message: `expected only cleanup-refusal residue, got ${nativeLeaks.length}`,
        nativeLeaks,
      });
    if (
      nativeSafetyWrote ||
      nativeSafety.output?.error?.name !== "ApiInputError" ||
      !nativeSafety.observedCalls?.includes(markers.export)
    )
      failures.push({
        id: safetyCase.id,
        message:
          "raw option-like revision wrote source files or did not run/refuse native export",
        native: nativeSafety,
      });
    const result = (id) => native.find((row) => row.id === `api-git.${id}`);
    if (!failures.length) {
      const counted = result("read.default").output.value;
      assert.equal(counted.package, "demo");
      assert.deepEqual(
        counted.changesets.map((c) => c.file),
        [
          ".changeset/a.md",
          ".changeset/z.md",
          ".changeset/\u{10000}.md",
          ".changeset/\ue000.md",
        ],
      );
      assert.equal(counted.changesets[1].body, "\nZ\n");
      assert.equal(
        result("read.readme-case").output.value.changesets[0].file,
        ".changeset/ReadMe.md",
      );
      assert.equal(
        result("read.proto-name").output.value.changesets[0].bump,
        "minor",
      );
      assert.equal(result("read.lone-name").output.value.package, "\ud800");
      assert.deepEqual(result("read.lone-name").output.value.changesets, []);
      const compound = result("export.operation-and-cleanup").nativeDetails;
      assert.equal(compound.variant, "compound");
      assert.equal(compound.operation.variant, "symlink");
      assert.equal(compound.cleanup.variant, "io");
      assert.ok(compound.operation.sourceChain.length > 0);
      assert.ok(compound.cleanup.sourceChain.length > 0);
      assert.equal(result("resolve.both-nul").output.error.location, "args[4]");
      const capture = result("names.output-limit").nativeDetails.git;
      assert.ok(
        capture.stdout.length > 1048576 &&
          capture.stdout.length <= 1048576 + 8192,
      );
      assert.ok(capture.failures[0].includes("1048576"));
      assert.match(
        source.find((row) => row.id === "api-git.names.output-limit").output
          .error.message,
        /ENOBUFS/,
      );
      assert.equal(
        result("missing-git.export").nativeDetails.archive.ioErrors.length,
        2,
      );
    }
    const invalid = [
      null,
      {},
      { id: "bad-op", operation: "bad", input: {} },
      { id: "bad-root", operation: "checkout", input: { root: 1 } },
      {
        id: "extra",
        operation: "checkout",
        input: { root: repos[0].root },
        extra: true,
      },
      {
        id: "bad-input",
        operation: "checkout",
        input: { root: repos[0].root, extra: 1 },
      },
      {
        id: "null-option",
        operation: "read",
        input: { root: repos[0].pkg, base: "HEAD", repoRoot: null },
      },
    ];
    const invalidInput =
      invalid.map((row) => JSON.stringify(row)).join("\n") + "\n";
    const sourceInvalid = run(
        process.execPath,
        [
          "--import",
          require.resolve("tsx"),
          path.join(here, "api-git-reference.mts"),
        ],
        invalidInput,
      ),
      nativeInvalid = run(binary, [], invalidInput);
    assert.ok(sourceInvalid.every((row) => !row.ok));
    assert.ok(nativeInvalid.every((row) => !row.ok));
    assert.ok(nativeInvalid.every((row) => row.observedCalls.length === 0));
    const qualifications = cases
      .filter((c) => c.qualification)
      .map((c) => ({
        id: c.id,
        qualification: c.qualification,
        source: source[cases.indexOf(c)].output,
        native: native[cases.indexOf(c)].output,
      }));
    report = {
      reference: "75de37ea01a81cd7949e6275b7ee9cfdeb4e312d",
      node: process.version,
      v8: process.versions.v8,
      cases: cases.length,
      strictCases: cases.length - qualifications.length,
      qualifiedCases: qualifications.length,
      passed:
        cases.length -
        failures.filter((f) => cases.some((c) => c.id === f.id)).length,
      protocolRejected: invalid.length,
      failures,
      nativeEvidence,
      nativeErrors,
      qualifications,
      sideEffects: {
        ordinarySourceCheckoutIndexRefsFilesUnchanged: true,
        nativeCheckoutIndexRefsFilesUnchanged: true,
        sourceCleanupFailureResidue: sourceLeaks.length,
        nativeCleanupFailureResidue: nativeLeaks.length,
      },
      archiveReadOnlyQualification: {
        source: sourceSafety,
        native: nativeSafety,
        sourceCreatedZeroByteFile: true,
        nativeSourceUnchanged: !nativeSafetyWrote,
        strictParity: false,
      },
      recipeSha256: sha(JSON.stringify(recipes)),
      inputSha256: sha(input + missingInput),
      scope:
        "Blocking native Git base export/read and changeset discovery; backend diagnostics/recursive deletion failure paths and archive argument-index change are separately qualified. Raw option-like archive write behavior deliberately differs and is reproduced in an isolated fixture, not counted as strict parity.",
    };
    const reportFile =
      options.reportFile ?? path.join(root, "target/parity/api-git.json");
    fs.mkdirSync(path.dirname(reportFile), { recursive: true });
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + "\n");
    if (!options.quiet)
      console.log(
        JSON.stringify(
          {
            ...report,
            nativeEvidence: { cases: Object.keys(nativeEvidence).length },
            nativeErrors: { cases: Object.keys(nativeErrors).length },
            qualifications: qualifications.map(({ id, qualification }) => ({
              id,
              qualification,
            })),
            failures: failures.slice(0, 10),
            reportFile,
          },
          null,
          2,
        ),
      );
    if (!options.allowFailures)
      assert.equal(failures.length, 0, `Git base failures: ${reportFile}`);
    return { ...report, reportFile };
  } finally {
    remove(fixture);
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  await apiGitParity();
