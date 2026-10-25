import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { apiBaseParserParity } from "./api-base-run.mjs";
import { apiGitParity } from "./api-git-run.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const p = "crates/code-graph/src/api/",
  changesets = `${p}ratchet/changesets.rs`,
  base = `${p}base.rs`,
  archive = `${p}base/archive.rs`,
  capture = `${p}capture.rs`;
const mutations = [
  {
    name: "initial-bom-is-not-removed",
    file: changesets,
    kind: "parser",
    edits: [
      [
        "text.units().strip_prefix(&[0xfeff]).unwrap_or(text.units())",
        "text.units()",
      ],
    ],
    ids: ["api-base.parse.bom"],
  },
  {
    name: "first-duplicate-bump-wins",
    file: changesets,
    kind: "parser",
    edits: [
      ["bumps.insert(name, bump);", "bumps.entry(name).or_insert(bump);"],
    ],
    ids: ["api-base.parse.ordered"],
  },
  {
    name: "tree-revision-is-accepted-as-a-commit",
    file: base,
    edits: [['commit.push_str("^{commit}");', 'commit.push_str("");']],
    ids: ["api-git.resolve.tree"],
  },
  {
    name: "git-tree-names-lose-nul-delimiters",
    file: base,
    edits: [['"-z".into(),', ""]],
    ids: ["api-git.names.root"],
  },
  {
    name: "changed-changesets-count-as-added",
    file: changesets,
    edits: [
      [".filter(|file| !at_base.contains(file))", ".filter(|_file| true)"],
    ],
    ids: ["api-git.read.default"],
  },
  {
    name: "regular-file-selection-follows-symlinks",
    file: changesets,
    edits: [
      ["if !entry\n            .file_type()", "if !fs::metadata(entry.path())"],
    ],
    ids: ["api-git.read.default"],
  },
  {
    name: "readme-exclusion-ignores-case",
    file: changesets,
    edits: [
      [
        'name != "README.md"',
        '!name.to_lossy().eq_ignore_ascii_case("README.md")',
      ],
    ],
    ids: ["api-git.read.readme-case"],
  },
  {
    name: "git-refusal-precedes-package-name-read",
    file: changesets,
    edits: [
      ["    let named = package_name(&root)?;", ""],
      [
        "    let sha = resolve_base(&checkout_of(&root)?, base)?;",
        "    let sha = resolve_base(&checkout_of(&root)?, base)?;\n    let named = package_name(&root)?;",
      ],
    ],
    ids: [
      "api-git.read.invalid-package-before-invalid-base",
      "api-git.read.missing-package-json",
    ],
  },
  {
    name: "archived-dependencies-are-overwritten",
    file: archive,
    edits: [["|| Path::new(&link.to_lossy()).exists()", ""]],
    ids: ["api-git.export.archived-deps"],
  },
  {
    name: "failed-export-keeps-its-temporary-tree",
    file: archive,
    edits: [
      [
        "Err(operation) => Err(after_failure(&temp, operation)),",
        "Err(operation) => Err(operation),",
      ],
    ],
    ids: ["api-git.export-error-temp-lifecycle"],
  },
  {
    name: "archive-options-can-write-the-source-checkout",
    file: archive,
    edits: [
      [
        '        "--".into(),\n        revision.clone(),',
        "        revision.clone(),",
      ],
    ],
    ids: ["api-git.archive-readonly-safety"],
  },
  {
    name: "remove-reports-success-without-deleting",
    file: archive,
    edits: [
      [
        "pub fn remove_base_tree(temp: &JsString) -> Result<(), ApiError> {",
        "pub fn remove_base_tree(temp: &JsString) -> Result<(), ApiError> {\n    let _=temp; return Ok(());",
      ],
    ],
    ids: ["api-git.remove.directory", "api-git.remove.file"],
  },
  {
    name: "git-accepts-source-output-overflow",
    file: capture,
    edits: [
      [
        "MAX_BUFFER: usize = 1024 * 1024;",
        "MAX_BUFFER: usize = 128 * 1024 * 1024;",
      ],
    ],
    ids: ["api-git.names.output-limit"],
  },
];
export async function apiGitMutations(options = {}) {
  assert.equal(process.version, "v22.21.1");
  assert.equal(process.versions.v8, "12.4.254.21-node.33");
  const target =
      options.mutationTarget ??
      path.join(root, "target/reconciler-mutation-build"),
    baselineTarget = process.env.CARGO_TARGET_DIR ?? path.join(root, "target");
  assert.notEqual(path.resolve(target), path.resolve(baselineTarget));
  const baselineGit =
      options.gitBinary ??
      path.join(baselineTarget, "debug/examples/api_git_driver"),
    baselineParser =
      options.parserBinary ??
      path.join(baselineTarget, "debug/examples/api_base_driver");
  if (!options.gitBinary || !options.parserBinary)
    execFileSync(
      process.env.CARGO ?? "cargo",
      [
        "build",
        "--locked",
        "-p",
        "demlik-code-graph",
        ...(!options.gitBinary ? ["--example", "api_git_driver"] : []),
        ...(!options.parserBinary ? ["--example", "api_base_driver"] : []),
      ],
      {
        cwd: root,
        stdio: "pipe",
        env: {
          ...process.env,
          CARGO_TARGET_DIR: baselineTarget,
          CARGO_PROFILE_DEV_DEBUG: "0",
          CARGO_PROFILE_TEST_DEBUG: "0",
          CARGO_INCREMENTAL: "0",
          CARGO_BUILD_JOBS: "1",
        },
      },
    );
  const baselines = new Map(
    [baselineGit, baselineParser].map((file) => [
      file,
      hash(fs.readFileSync(file)),
    ]),
  );
  const originals = new Map(
    [...new Set(mutations.map((m) => m.file))].map((file) => [
      file,
      fs.readFileSync(path.join(root, file), "utf8"),
    ]),
  );
  const referenceFiles = [
    "packages/code-graph/src/api/base.ts",
    "packages/code-graph/src/api/ratchet/changesets.ts",
  ];
  const referenceHashes = Object.fromEntries(
    referenceFiles.map((file) => [
      file,
      hash(fs.readFileSync(path.join(root, file))),
    ]),
  );
  const directory = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "demlik-api-git-faults-")),
    ),
    workspace = path.join(directory, "workspace");
  fs.mkdirSync(workspace);
  const environment = {
      ...process.env,
      CARGO_TARGET_DIR: target,
      CARGO_PROFILE_DEV_DEBUG: "0",
      CARGO_PROFILE_TEST_DEBUG: "0",
      CARGO_INCREMENTAL: "0",
      CARGO_BUILD_JOBS: "1",
    },
    controls = [];
  const reportFile =
    options.reportFile ??
    path.join(root, "target/parity/api-git-mutations.json");
  try {
    const baselineIO = await apiGitParity({
      binary: baselineGit,
      quiet: true,
      reportFile: path.join(
        root,
        "target/parity/api-git-mutation-baseline.json",
      ),
    });
    const baselineText = await apiBaseParserParity({
      binary: baselineParser,
      quiet: true,
      reportFile: path.join(
        root,
        "target/parity/api-git-parser-mutation-baseline.json",
      ),
    });
    for (const entry of ["Cargo.toml", "Cargo.lock", "crates"])
      fs.cpSync(path.join(root, entry), path.join(workspace, entry), {
        recursive: true,
      });
    for (const mutation of mutations) {
      for (const [file, original] of originals)
        fs.writeFileSync(path.join(workspace, file), original);
      let source = originals.get(mutation.file);
      for (const [before, after] of mutation.edits) {
        assert.equal(
          source.split(before).length,
          2,
          `unique fault site: ${mutation.name}`,
        );
        source = source.replace(before, after);
      }
      fs.writeFileSync(path.join(workspace, mutation.file), source);
      const example =
        mutation.kind === "parser" ? "api_base_driver" : "api_git_driver";
      execFileSync(
        process.env.CARGO ?? "cargo",
        [
          "build",
          "--locked",
          "--offline",
          "-p",
          "demlik-code-graph",
          "--example",
          example,
        ],
        {
          cwd: workspace,
          env: environment,
          stdio: "pipe",
          maxBuffer: 16 * 1024 * 1024,
        },
      );
      const result =
        mutation.kind === "parser"
          ? await apiBaseParserParity({
              binary: path.join(target, `debug/examples/${example}`),
              quiet: true,
              allowFailures: true,
              reportFile: path.join(
                root,
                `target/parity/api-git-mutants/${mutation.name}.json`,
              ),
            })
          : await apiGitParity({
              binary: path.join(target, `debug/examples/${example}`),
              quiet: true,
              allowFailures: true,
              reportFile: path.join(
                root,
                `target/parity/api-git-mutants/${mutation.name}.json`,
              ),
            });
      const failing = result.failures.map((f) => f.id);
      assert.ok(failing.length > 0, `${mutation.name}: escaped`);
      assert.ok(
        mutation.ids.some((id) => failing.includes(id)),
        `${mutation.name}: unrelated failure ${failing.join(",")}`,
      );
      controls.push({
        name: mutation.name,
        detected: true,
        compiled: true,
        expectedWitnesses: mutation.ids,
        detectedWitnesses: failing,
        mutantSha256: hash(source),
        originalSha256: hash(originals.get(mutation.file)),
        file: mutation.file,
      });
      if (!options.quiet)
        console.log(
          JSON.stringify({
            detected: mutation.name,
            witnesses: failing.length,
          }),
        );
    }
    for (const [file, bytes] of originals)
      assert.equal(
        fs.readFileSync(path.join(root, file), "utf8"),
        bytes,
        "active source unchanged",
      );
    for (const [file, bytes] of baselines)
      assert.equal(
        hash(fs.readFileSync(file)),
        bytes,
        "isolated builds preserve actual baseline artifact",
      );
    for (const file of referenceFiles)
      assert.equal(
        hash(fs.readFileSync(path.join(root, file))),
        referenceHashes[file],
        "frozen Source unchanged",
      );
    const report = {
      reference: "75de37ea01a81cd7949e6275b7ee9cfdeb4e312d",
      node: process.version,
      v8: process.versions.v8,
      detected: controls.length,
      escaped: 0,
      baselineIO: {
        cases: baselineIO.cases,
        strict: baselineIO.strictCases,
        qualified: baselineIO.qualifiedCases,
        passed: baselineIO.passed,
      },
      baselineParser: {
        cases: baselineText.cases,
        passed: baselineText.passed,
      },
      baselineArtifactsUnchanged: true,
      activeSourceUnchanged: true,
      referenceHashes,
      baselineArtifactHashes: Object.fromEntries(baselines),
      build: {
        mutationTarget: target,
        baselineTarget,
        debug: 0,
        incremental: false,
        jobs: 1,
      },
      controls,
    };
    fs.mkdirSync(path.dirname(reportFile), { recursive: true });
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + "\n");
    if (!options.quiet)
      console.log(
        JSON.stringify({ detected: controls.length, escaped: 0, reportFile }),
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
  await apiGitMutations();
