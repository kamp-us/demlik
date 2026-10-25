import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { apiDiffModeParity } from "./api-diff-mode-run.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const published = "crates/code-graph/src/api/diff/published.rs";
const cli = "crates/code-graph/src/api/cli.rs";
const controls = [
  {
    name: "revision-refusal-precedes-current-map",
    file: published,
    edits: [
      ["    let parts = api_subpaths(&root, map)?;\n", ""],
      [
        "    let sha = resolve_base(&checkout_of(&root)?, base)?;",
        "    let sha = resolve_base(&checkout_of(&root)?, base)?;\n    let parts = api_subpaths(&root, map)?;",
      ],
    ],
    ids: ["api-workflow.diff.map-before-base"],
  },
  {
    name: "invalid-current-map-still-emits",
    file: published,
    edits: [
      [
        "    let parts = api_subpaths(&root, map)?;",
        "    let early_repo = options.repo_root;\n    let _ = read_side(&root, &[], compiler, &mut options, early_repo, None)?;\n    let parts = api_subpaths(&root, map)?;",
      ],
    ],
    ids: ["api-workflow.diff.empty-current-before-warn"],
  },
  {
    name: "warning-callback-rejection-is-ignored",
    file: published,
    edits: [
      [
        "let mut forward = |message: &JsString| warn(message);",
        "let mut forward = |message: &JsString| { let _ = warn(message); Ok(()) };",
      ],
    ],
    ids: [
      "api-workflow.diff.current-warning-input",
      "api-workflow.diff.current-warning-callback",
    ],
  },
  {
    name: "absent-base-package-calls-map-loader",
    file: published,
    edits: [
      [
        `        Ok(false) => finish(
            work,
            Ok(BaseSide {
                subpaths: Vec::new(),
                names: IndexMap::new(),
            }),
        )
        .map(BaseMapStep::Complete),`,
        `        Ok(false) => Ok(BaseMapStep::Awaiting(BaseMapRequest { work })),`,
      ],
    ],
    ids: [
      "api-workflow.diff.before-package-skips-callback",
      "api-workflow.diff.base-package-file-skips-callback",
    ],
  },
  {
    name: "empty-base-map-still-emits",
    file: published,
    edits: [["if present.is_empty() {", "if false && present.is_empty() {"]],
    ids: ["api-workflow.diff.no-base-rows-skips-emit"],
  },
  {
    name: "base-warning-context-is-lost",
    file: published,
    edits: [['JsString::from(" at the base ")', 'JsString::from("")']],
    ids: [
      "api-workflow.diff.both-warning-contexts",
      "api-workflow.diff.base-warning-context",
    ],
  },
  {
    name: "base-reads-current-entry-paths",
    file: published,
    edits: [
      [
        "subpaths_at_base(&work.guard.tree().root, &work.parts)",
        "subpaths_at_base(&work.root, &work.parts)",
      ],
    ],
    ids: ["api-workflow.diff.dirty-default"],
  },
  {
    name: "gone-subpaths-are-forgotten",
    file: published,
    edits: [
      [
        ".filter(|part| !kept.contains(&part.subpath))",
        ".filter(|part| !kept.contains(&part.subpath) && false)",
      ],
    ],
    ids: ["api-workflow.diff.base-map-file-async"],
  },
  {
    name: "base-tier-overwrites-current-tier",
    file: published,
    edits: [
      [
        ".filter(|part| !kept.contains(&part.subpath))",
        ".filter(|part| !kept.contains(&part.subpath) || true)",
      ],
    ],
    ids: ["api-workflow.diff.base-map-file-async"],
  },
  {
    name: "subpath-order-is-reversed",
    file: published,
    edits: [
      [
        "all.sort_by(|a, b| a.subpath.cmp(&b.subpath));",
        "all.sort_by(|a, b| b.subpath.cmp(&a.subpath));",
      ],
    ],
    ids: ["api-workflow.diff.base-map-file-async"],
  },
  {
    name: "base-tree-finally-does-not-remove",
    file: published,
    edits: [
      [
        "match (result, remove_base_tree(&tree.temp)) {",
        "match (result, { let _ = &tree; Ok::<(), ApiError>(()) }) {",
      ],
    ],
    ids: [
      "api-workflow.diff.base-map-file-async",
      "api-workflow.temp-lifecycle",
    ],
  },
  {
    name: "cleanup-erases-original-callback-failure",
    file: published,
    edits: [
      [
        `            (Err(operation), Err(cleanup)) => Err(ApiError::OperationAndCleanup {
                operation: Box::new(operation),
                cleanup: Box::new(cleanup),
            }),`,
        `            (Err(_operation), Err(cleanup)) => Err(cleanup),`,
      ],
    ],
    ids: ["api-workflow.diff.callback-cleanup-failure"],
  },
  {
    name: "stray-flags-are-accepted",
    file: cli,
    edits: [["if !stray.is_empty() {", "if false && !stray.is_empty() {"]],
    ids: ["api-workflow.mode.stray-order"],
  },
  {
    name: "policy-validation-follows-the-diff",
    file: cli,
    edits: [
      ["        let policy = bump_policy(&policy_value)?;\n", ""],
      [
        "        let changesets = read_changesets_since(",
        "        let policy = bump_policy(&policy_value)?;\n        let changesets = read_changesets_since(",
      ],
    ],
    ids: ["api-workflow.mode.policy-before-map-schema"],
  },
  {
    name: "input-looking-callback-is-treated-as-input",
    file: cli,
    edits: [
      [
        "if failure.is_input() {",
        'if failure.is_input() || failure.message().to_lossy().starts_with("ApiInputError:") {',
      ],
    ],
    ids: ["api-workflow.mode.emit-callback-looking"],
  },
  {
    name: "cleanup-visible-input-is-treated-as-crash",
    file: cli,
    edits: [
      [
        "if failure.is_input() {",
        "if matches!(&failure, ApiError::Input(_)) {",
      ],
    ],
    ids: ["api-workflow.mode.emit-cleanup-input-raw"],
  },
  {
    name: "report-callback-failure-is-swallowed",
    file: cli,
    edits: [
      [
        `                return Err(ApiRunError {
                    report: Box::new(report),
                    processing: Some(Box::new(failure)),
                });`,
        `                let _ = report;
                return Ok(ApiRunOutcome { exit, failure: Some(failure) });`,
      ],
    ],
    ids: ["api-workflow.mode.emit-then-report-fails"],
  },
  {
    name: "ratchet-miss-returns-success",
    file: cli,
    edits: [
      [
        "                ApiExit::RatchetMiss",
        "                ApiExit::Success",
      ],
    ],
    ids: ["api-workflow.mode.ratchet-miss-false-false"],
  },
  {
    name: "json-ratchet-returns-text",
    file: cli,
    edits: [["if run.host.json {", "if false && run.host.json {"]],
    ids: ["api-workflow.mode.ratchet-met-true-false"],
  },
  {
    name: "json-payload-has-no-final-newline",
    file: cli,
    edits: [["    text.push('\\n');", '    text.push_str("");']],
    ids: ["api-workflow.mode.view-flags-false", "api-workflow.out-file-bytes"],
  },
  {
    name: "crash-line-uses-rust-whitespace",
    file: cli,
    edits: [[".is_some_and(js_space)", ".is_some_and(char::is_whitespace)"]],
    ids: ["api-workflow.mode.emit-callback-raw"],
  },
  {
    name: "inactive-mode-reports-orphan-policy",
    file: cli,
    edits: [
      [
        "if flags.api_base.is_none() && flags.api_policy.is_none() {",
        "if false && flags.api_base.is_none() && flags.api_policy.is_none() {",
      ],
    ],
    ids: ["api-workflow.mode.inactive"],
  },
];

export async function apiDiffModeMutations(options = {}) {
  assert.equal(process.version, "v22.21.1");
  assert.equal(process.versions.v8, "12.4.254.21-node.33");
  const baselineTarget =
    process.env.CARGO_TARGET_DIR ?? path.join(root, "target");
  const target =
    options.mutationTarget ??
    path.join(root, "target/reconciler-mutation-build");
  assert.notEqual(path.resolve(target), path.resolve(baselineTarget));
  const binary =
    options.binary ?? path.join(baselineTarget, "debug/api_mode_driver");
  const artifactHash = hash(fs.readFileSync(binary));
  const originals = new Map(
    [published, cli].map((file) => [
      file,
      fs.readFileSync(path.join(root, file), "utf8"),
    ]),
  );
  const referenceFiles = [
    "packages/code-graph/src/api/diff.ts",
    "packages/code-graph/src/api/cli.ts",
  ];
  const referenceHashes = Object.fromEntries(
    referenceFiles.map((file) => [
      file,
      hash(fs.readFileSync(path.join(root, file))),
    ]),
  );
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "demlik-api-workflow-faults-")),
  );
  const workspace = path.join(directory, "workspace");
  fs.mkdirSync(workspace);
  const environment = {
    ...process.env,
    CARGO_TARGET_DIR: target,
    CARGO_PROFILE_DEV_DEBUG: "0",
    CARGO_PROFILE_TEST_DEBUG: "0",
    CARGO_INCREMENTAL: "0",
    CARGO_BUILD_JOBS: "1",
  };
  const detected = [];
  try {
    const baseline = await apiDiffModeParity({
      binary,
      compiler: options.compiler,
      quiet: true,
      reportFile: path.join(
        root,
        "target/parity/api-diff-mode-mutation-baseline.json",
      ),
    });
    for (const entry of ["Cargo.toml", "Cargo.lock", "crates"])
      fs.cpSync(path.join(root, entry), path.join(workspace, entry), {
        recursive: true,
      });
    for (const control of controls.filter(
      (control) => !options.only || options.only.includes(control.name),
    )) {
      for (const [file, source] of originals)
        fs.writeFileSync(path.join(workspace, file), source);
      let source = originals.get(control.file);
      for (const [before, after] of control.edits) {
        assert.equal(
          source.split(before).length,
          2,
          `unique fault site: ${control.name}`,
        );
        source = source.replace(before, after);
      }
      fs.writeFileSync(path.join(workspace, control.file), source);
      execFileSync(
        process.env.CARGO ?? "cargo",
        [
          "build",
          "--locked",
          "--offline",
          "-p",
          "demlik-parity",
          "--bin",
          "api_mode_driver",
        ],
        {
          cwd: workspace,
          env: environment,
          stdio: "pipe",
          maxBuffer: 16 * 1024 * 1024,
        },
      );
      const result = await apiDiffModeParity({
        binary: path.join(target, "debug/api_mode_driver"),
        compiler: options.compiler,
        quiet: true,
        allowFailures: true,
        caseIds: control.ids.filter(
          (id) =>
            ![
              "api-workflow.temp-lifecycle",
              "api-workflow.out-file-bytes",
            ].includes(id),
        ),
        reportFile: path.join(
          root,
          `target/parity/api-diff-mode-mutants/${control.name}.json`,
        ),
      });
      const failing = result.failures.map((failure) => failure.id);
      assert.ok(failing.length, `${control.name}: escaped`);
      assert.ok(
        control.ids.some((id) => failing.includes(id)),
        `${control.name}: unrelated failure: ${failing.join(",")}`,
      );
      for (const id of failing) {
        assert.ok(
          !Object.hasOwn(result.nativeEvidence, id),
          `${control.name}: failed case claimed strict evidence`,
        );
        assert.ok(
          !Object.hasOwn(result.qualifiedNativeEvidence, id),
          `${control.name}: failed case claimed qualified evidence`,
        );
      }
      detected.push({
        name: control.name,
        detected: true,
        compiled: true,
        file: control.file,
        originalSha256: hash(originals.get(control.file)),
        mutantSha256: hash(source),
        expectedWitnesses: control.ids,
        observedCases: result.cases,
        selectedIds: result.selectedIds,
        detectedWitnesses: failing,
      });
      if (!options.quiet)
        console.log(
          JSON.stringify({ detected: control.name, witnesses: failing.length }),
        );
    }
    for (const [file, source] of originals)
      assert.equal(
        fs.readFileSync(path.join(root, file), "utf8"),
        source,
        "active source unchanged",
      );
    for (const file of referenceFiles)
      assert.equal(
        hash(fs.readFileSync(path.join(root, file))),
        referenceHashes[file],
        "frozen Source unchanged",
      );
    assert.equal(
      hash(fs.readFileSync(binary)),
      artifactHash,
      "isolated build preserved baseline artifact",
    );
    const report = {
      reference: "75de37ea01a81cd7949e6275b7ee9cfdeb4e312d",
      node: process.version,
      v8: process.versions.v8,
      detected: detected.length,
      escaped: 0,
      baseline: {
        cases: baseline.cases,
        strict: baseline.strictCases,
        qualified: baseline.qualifiedCases,
        passed: baseline.passed,
      },
      build: {
        baselineTarget,
        mutationTarget: target,
        debug: 0,
        incremental: false,
        jobs: 1,
      },
      activeSourceUnchanged: true,
      baselineArtifactUnchanged: true,
      baselineArtifactHash: artifactHash,
      referenceHashes,
      controls: detected,
    };
    const reportFile =
      options.reportFile ??
      path.join(root, "target/parity/api-diff-mode-mutations.json");
    fs.mkdirSync(path.dirname(reportFile), { recursive: true });
    fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
    if (!options.quiet)
      console.log(
        JSON.stringify({ detected: detected.length, escaped: 0, reportFile }),
      );
    return report;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  await apiDiffModeMutations();
