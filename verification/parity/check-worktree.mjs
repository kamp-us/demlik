import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

const checks = new Map();
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function cargoCheckEnvironment(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.CARGO_TARGET_DIR;
  delete env.DEMLIK_MUTATION_TARGET_DIR;
  delete env.CARGO_BUILD_TARGET_DIR;
  delete env.CARGO_BUILD_BUILD_DIR;
  return env;
}

export function assertCheckPath(file, owner) {
  const canonical = fs.realpathSync(file);
  const relative = path.relative(fs.realpathSync(owner), canonical);
  assert.ok(
    relative &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative),
    `check artifact must belong to ${owner}: ${file}`,
  );
  return canonical;
}

export function compiledCheckLibrary(rows, name, root, target) {
  const libraries = rows.filter(
    (row) =>
      row.reason === "compiler-artifact" &&
      row.target.name === name &&
      row.target.kind.includes("lib") &&
      row.filenames.some((file) => file.endsWith(".rlib")),
  );
  assert.equal(libraries.length, 1, `one check-owned ${name} library`);
  const artifact = libraries[0];
  assert.equal(artifact.fresh, false, `${name} must be rebuilt for this fault`);
  const sourcePath = assertCheckPath(artifact.target.src_path, root);
  const manifestPath = assertCheckPath(artifact.manifest_path, root);
  const files = artifact.filenames.filter((file) => file.endsWith(".rlib"));
  assert.equal(files.length, 1);
  return {
    artifact,
    sourcePath,
    manifestPath,
    path: assertCheckPath(files[0], target),
  };
}

export function checkEvidenceDirectory(sourceRoot, name) {
  assert.match(name, /^[a-z0-9-]+$/);
  const common = execFileSync("git", ["rev-parse", "--git-common-dir"], {
    cwd: sourceRoot,
    encoding: "utf8",
  }).trim();
  return path.join(
    path.dirname(path.resolve(sourceRoot, common)),
    ".fabrika",
    "rust-parity-evidence",
    name,
  );
}

export function createCheckWorktree(sourceRoot, name, evidenceDirectory) {
  assert.match(name, /^[a-z0-9-]+$/);
  if (evidenceDirectory === undefined) {
    const parent = checkEvidenceDirectory(sourceRoot, name);
    fs.mkdirSync(parent, { recursive: true });
    evidenceDirectory = fs.mkdtempSync(path.join(parent, "run-"));
  }
  const evidence = path.resolve(evidenceDirectory);
  fs.mkdirSync(evidence, { recursive: true });
  const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: sourceRoot,
    encoding: "utf8",
  }).trim();
  const parent = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), `demlik-check-${name}-`)),
  );
  const root = path.join(parent, "repo");
  const relative = path.relative(root, evidence);
  assert.ok(
    relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative),
    "evidence must outlive the check worktree",
  );
  const target = path.join(root, "target");
  const receipt = {
    sourceRoot: fs.realpathSync(sourceRoot),
    sourceCommit,
    worktree: root,
    target,
    defaultTarget: true,
    createdAt: new Date().toISOString(),
    removed: false,
  };
  const file = path.join(evidence, `${name}-worktree.json`);
  const save = () =>
    fs.writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`);
  const registeredHere = () =>
    execFileSync("git", ["worktree", "list", "--porcelain", "-z"], {
      cwd: sourceRoot,
      encoding: "utf8",
    })
      .split("\0")
      .includes(`worktree ${root}`);
  function remove(originalFailure) {
    let retentionError;
    if (fs.existsSync(root) && registeredHere()) {
      try {
        retainCheckFiles(root, evidence, name);
      } catch (error) {
        retentionError = error;
        receipt.retentionFailure = String(error);
      }
    }
    try {
      // A failed add can leave a registry entry even though it did not return.
      if (registeredHere()) {
        execFileSync("git", ["worktree", "remove", "--force", root], {
          cwd: sourceRoot,
          stdio: "pipe",
        });
      }
      assert.ok(!registeredHere(), "finished check registration must be gone");
      if (fs.existsSync(root))
        fs.rmSync(root, { recursive: true, force: true });
      assert.ok(!fs.existsSync(root), "finished check worktree must be gone");
      if (fs.existsSync(parent)) fs.rmdirSync(parent);
      receipt.removed = true;
      receipt.finishedAt = new Date().toISOString();
      checks.delete(root);
    } catch (error) {
      receipt.cleanupFailure = String(error);
      if (retentionError)
        throw new AggregateError(
          [originalFailure, retentionError, error].filter(Boolean),
          "check retention and cleanup failed",
        );
      if (originalFailure)
        throw new AggregateError(
          [originalFailure, error],
          "check execution and cleanup failed",
        );
      throw error;
    } finally {
      save();
    }
    if (retentionError) {
      if (originalFailure)
        throw new AggregateError(
          [originalFailure, retentionError],
          "check execution and retention failed",
        );
      throw retentionError;
    }
  }
  try {
    execFileSync("git", ["worktree", "add", "--detach", root, sourceCommit], {
      cwd: sourceRoot,
      stdio: "pipe",
    });
    save();
    const check = { root, target, remove, evidence, receiptFile: file };
    checks.set(root, check);
    return check;
  } catch (error) {
    receipt.setupFailure = String(error);
    try {
      remove();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "check worktree setup and cleanup failed",
      );
    }
    throw error;
  }
}

function retainCheckFiles(root, evidence, name) {
  const mapping = [];
  function copy(directory, relative = "") {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (["node_modules", ".git"].includes(entry.name)) continue;
      const file = path.join(directory, entry.name);
      const label = path.join(relative, entry.name);
      if (entry.isDirectory()) copy(file, label);
      else if (entry.isFile()) {
        const destination = path.join(evidence, `${name}-reports`, label);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.copyFileSync(file, destination);
        mapping.push({
          original: file,
          retained: destination,
          sha256: sha(fs.readFileSync(file)),
        });
      }
    }
  }
  copy(path.join(root, "target/parity"), "target/parity");
  for (const rootFile of fs.readdirSync(root)) {
    if (!/\.(json|jsonl|log|stdout|stderr)$/.test(rootFile)) continue;
    const file = path.join(root, rootFile);
    const tracked = execFileSync("git", ["ls-files", "--", rootFile], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    if (tracked || !fs.statSync(file).isFile()) continue;
    const destination = path.join(evidence, `${name}-reports-root`, rootFile);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(file, destination);
    mapping.push({
      original: file,
      retained: destination,
      sha256: sha(fs.readFileSync(file)),
    });
  }
  for (const entry of fs.existsSync(path.join(root, "target"))
    ? fs.readdirSync(path.join(root, "target"), { withFileTypes: true })
    : []) {
    if (
      entry.isFile() &&
      /\.(json|jsonl|log|stdout|stderr)$/.test(entry.name)
    ) {
      const file = path.join(root, "target", entry.name);
      const destination = path.join(
        evidence,
        `${name}-reports/target`,
        entry.name,
      );
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(file, destination);
      mapping.push({
        original: file,
        retained: destination,
        sha256: sha(fs.readFileSync(file)),
      });
    }
  }
  fs.writeFileSync(
    path.join(evidence, `${name}-retained.json`),
    `${JSON.stringify(mapping, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(evidence, `${name}-source.diff`),
    execFileSync("git", ["diff", "--binary", "HEAD", "--", "crates"], {
      cwd: root,
      maxBuffer: 32 << 20,
    }),
  );
}

export function ownedCheck(cwd = process.cwd()) {
  const root = fs.realpathSync(cwd);
  let check = checks.get(root);
  if (!check) {
    const file = process.env.DEMLIK_CHECK_WORKTREE_RECEIPT;
    assert.ok(
      file,
      "run building verification through check-worktree.mjs entry <script> [args]",
    );
    const receipt = JSON.parse(fs.readFileSync(file));
    assert.equal(
      receipt.worktree,
      root,
      "entry receipt must own the actual build directory",
    );
    assert.equal(receipt.removed, false, "entry worktree must still be owned");
    assert.equal(
      receipt.target,
      path.join(root, "target"),
      "receipt must own default target",
    );
    assert.equal(
      execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
      }).trim(),
      receipt.sourceCommit,
      "entry checkout must match owned revision",
    );
    assertCheckPath(
      file,
      path.dirname(
        execFileSync("git", ["rev-parse", "--git-common-dir"], {
          cwd: root,
          encoding: "utf8",
        }).trim(),
      ),
    );
    check = {
      root,
      target: path.join(root, "target"),
      evidence: path.dirname(file),
      receiptFile: file,
    };
  }
  const registered = execFileSync(
    "git",
    ["worktree", "list", "--porcelain", "-z"],
    { cwd: root, encoding: "utf8" },
  ).split("\0");
  assert.ok(
    registered.includes(`worktree ${root}`),
    "building check must be a registered Git worktree",
  );
  return check;
}

export function checkScratchDirectory(prefix) {
  const check = ownedCheck();
  fs.mkdirSync(check.target, { recursive: true });
  return fs.mkdtempSync(path.join(check.target, prefix));
}

export function prepareCheckWorktree(check, graph = false) {
  const sourceRoot = JSON.parse(fs.readFileSync(check.receiptFile)).sourceRoot;
  for (const relative of [
    "node_modules",
    "verification/parity/node_modules",
    "packages/code-graph/node_modules",
    "packages/tea/node_modules",
  ]) {
    const destination = path.join(check.root, relative);
    const source = path.join(sourceRoot, relative);
    if (!fs.existsSync(destination) && fs.existsSync(source)) {
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.symlinkSync(fs.realpathSync(source), destination, "dir");
    }
  }
  if (!graph || fs.existsSync(path.join(check.target, "icu77/prepared.json")))
    return;
  const archive = process.env.DEMLIK_ICU77_SOURCE_ARCHIVE;
  assert.ok(
    archive,
    "Graph checks require DEMLIK_ICU77_SOURCE_ARCHIVE naming the official pinned source archive",
  );
  const env = cargoCheckEnvironment({
    DEMLIK_ICU77_PREPARED: path.join(check.target, "icu77/prepared.json"),
    RUST_ICU_LINK_SEARCH_DIR: path.join(check.target, "icu77/install/lib"),
    RUST_ICU_MAJOR_VERSION_NUMBER: "77",
  });
  const args = [
    path.join(check.root, "tools/icu77/prepare.py"),
    "prepare",
    "--host",
    "aarch64-apple-darwin",
    "--target",
    "aarch64-apple-darwin",
    "--source-archive",
    path.resolve(archive),
  ];
  const result = spawnSync(process.env.DEMLIK_ICU77_PYTHON ?? "python3", args, {
    cwd: check.root,
    env,
    encoding: "utf8",
    maxBuffer: 32 << 20,
  });
  fs.writeFileSync(
    path.join(check.evidence, "icu-prepare.json"),
    `${JSON.stringify({ command: args, status: result.status, error: result.error?.message, stdout: result.stdout, stderr: result.stderr }, null, 2)}\n`,
  );
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function isCargo(program) {
  return (
    program === (process.env.CARGO ?? "cargo") ||
    path.basename(program) === "cargo"
  );
}

export function checkedSpawnSync(program, args = [], options = {}) {
  if (!isCargo(program) || !["build", "test", "check"].includes(args[0]))
    return spawnSync(program, args, options);
  const check = ownedCheck(options.cwd ?? process.cwd());
  const packageFlag = args.findIndex(
    (arg) => arg === "-p" || arg === "--package",
  );
  const packageName = packageFlag < 0 ? undefined : args[packageFlag + 1];
  const graph =
    packageName !== "demlik-tea" && packageName !== "demlik-wasm-runtime-local";
  prepareCheckWorktree(check, graph);
  const env = cargoCheckEnvironment({ ...options.env, CARGO_BUILD_JOBS: "1" });
  if (graph)
    Object.assign(env, {
      DEMLIK_ICU77_PREPARED: path.join(check.target, "icu77/prepared.json"),
      RUST_ICU_LINK_SEARCH_DIR: path.join(check.target, "icu77/install/lib"),
      RUST_ICU_MAJOR_VERSION_NUMBER: "77",
    });
  const command = [...args];
  if (
    (args[0] === "build" || args.includes("--no-run")) &&
    !args.some((arg) => arg.startsWith("--message-format"))
  )
    command.push("--message-format=json");
  const result = spawnSync(program, command, {
    ...options,
    stdio: "pipe",
    env,
    maxBuffer: options.maxBuffer ?? 64 << 20,
  });
  const label = path.basename(
    fs.mkdtempSync(path.join(check.evidence, "cargo-")),
  );
  fs.writeFileSync(
    path.join(check.evidence, `${label}.source.diff`),
    execFileSync("git", ["diff", "--binary", "HEAD", "--", "crates"], {
      cwd: check.root,
      maxBuffer: 32 << 20,
    }),
  );
  const stdout = result.stdout?.toString() ?? "";
  const stderr = result.stderr?.toString() ?? "";
  fs.writeFileSync(path.join(check.evidence, `${label}.stdout`), stdout);
  fs.writeFileSync(path.join(check.evidence, `${label}.stderr`), stderr);
  const selected = [];
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("{")) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      row.reason !== "compiler-artifact" ||
      !row.manifest_path?.startsWith(`${check.root}${path.sep}`)
    )
      continue;
    const files = [
      row.executable,
      ...(["demlik_tea", "demlik_code_graph", "demlik_parity"].includes(
        row.target.name,
      )
        ? row.filenames.filter((file) => file.endsWith(".rlib"))
        : []),
    ].filter(Boolean);
    for (const file of files) {
      assertCheckPath(file, check.target);
      if (file.endsWith(".rlib") && !row.fresh)
        compiledCheckLibrary([row], row.target.name, check.root, check.target);
      const bytes = fs.readFileSync(file);
      const hash = sha(bytes);
      const compressed = file.endsWith(".rlib");
      const retained = path.join(
        check.evidence,
        "selected",
        hash,
        `${path.basename(file)}${compressed ? ".gz" : ""}`,
      );
      fs.mkdirSync(path.dirname(retained), { recursive: true });
      if (!fs.existsSync(retained))
        fs.writeFileSync(retained, compressed ? gzipSync(bytes) : bytes, {
          mode: compressed ? 0o644 : 0o755,
        });
      selected.push({
        artifact: row,
        original: file,
        retained,
        sha256: hash,
        retainedSha256: sha(fs.readFileSync(retained)),
        encoding: compressed ? "gzip" : "raw",
      });
    }
  }
  fs.writeFileSync(
    path.join(check.evidence, `${label}.json`),
    `${JSON.stringify({ command: [program, ...command], cwd: check.root, target: check.target, status: result.status, signal: result.signal, error: result.error?.message, selected }, null, 2)}\n`,
  );
  if (options.stdio === "inherit") {
    process.stdout.write(stdout);
    process.stderr.write(stderr);
  }
  return result;
}

export function checkedExecFileSync(program, args = [], options = {}) {
  if (!isCargo(program) || !["build", "test", "check"].includes(args[0]))
    return execFileSync(program, args, options);
  const result = checkedSpawnSync(program, args, options);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const error = new Error(
      `${program} ${args.join(" ")} failed: ${result.stderr}`,
    );
    Object.assign(error, result);
    throw error;
  }
  return result.stdout;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  assert.equal(
    process.argv[2],
    "entry",
    "usage: check-worktree.mjs entry [--import loader] script [args]",
  );
  const sourceRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../..",
  );
  const argv = process.argv.slice(3);
  const nodeArgs = [];
  while (argv[0] === "--import") nodeArgs.push(argv.shift(), argv.shift());
  const script = argv.shift();
  assert.ok(
    script && !path.isAbsolute(script) && !script.split(/[\\/]/).includes(".."),
    "relative parity entry required",
  );
  const name = path.basename(script).replace(/\.[^.]+$/, "");
  const parent = checkEvidenceDirectory(sourceRoot, "owned-entries");
  fs.mkdirSync(parent, { recursive: true });
  const evidence = fs.mkdtempSync(path.join(parent, `${name}-`));
  const check = createCheckWorktree(sourceRoot, name, evidence);
  let failed;
  try {
    prepareCheckWorktree(check, script === "mutations.mjs");
    const result = spawnSync(
      process.execPath,
      [
        ...nodeArgs,
        path.join(check.root, "verification/parity", script),
        ...argv,
      ],
      {
        cwd: check.root,
        env: cargoCheckEnvironment({
          DEMLIK_CHECK_WORKTREE_RECEIPT: check.receiptFile,
          CARGO_BUILD_JOBS: "1",
        }),
        encoding: "utf8",
        maxBuffer: 128 << 20,
      },
    );
    fs.writeFileSync(path.join(evidence, "entry.stdout"), result.stdout ?? "");
    fs.writeFileSync(path.join(evidence, "entry.stderr"), result.stderr ?? "");
    fs.writeFileSync(
      path.join(evidence, "entry-process.json"),
      JSON.stringify(
        {
          argv: [process.execPath, ...nodeArgs, script, ...argv],
          cwd: check.root,
          status: result.status,
          signal: result.signal,
          error: result.error?.message,
          defaultTarget: check.target,
        },
        null,
        2,
      ) + "\n",
    );
    process.stdout.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    if (result.error) throw result.error;
    assert.equal(result.signal, null, "entry must not end by signal");
    assert.equal(
      result.status,
      0,
      `entry failed; retained evidence: ${evidence}`,
    );
  } catch (error) {
    failed = error;
    throw error;
  } finally {
    check.remove(failed);
  }
}
