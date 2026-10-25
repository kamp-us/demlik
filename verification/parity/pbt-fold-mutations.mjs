import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const faults = [
  {
    id: "fold-reinitializes-each-message",
    file: "crates/tea/src/pbt.rs",
    changes: [
      {
        needle: "let update = machine.update.apply(&current, &message)?;",
        fault:
          "let reset = replay(machine, None, input, std::iter::empty::<M>())?; let update = machine.update.apply(&reset.state, &message)?;",
      },
    ],
    witness: "pbt-fold.transitions.loaded-transform",
  },
  {
    id: "fold-leaks-boot-commands",
    file: "crates/tea/src/pbt.rs",
    changes: [
      {
        needle: "let mut current = Arc::new(boot.state);",
        fault:
          "let mut boot_commands = boot.commands; let mut current = Arc::new(boot.state);",
      },
      {
        needle: "commands: update.commands,",
        fault:
          "commands: {let mut commands = std::mem::take(&mut boot_commands); commands.extend(update.commands); commands},",
      },
    ],
    witness: "pbt-fold.intake.duplicate-complete-boot-eight",
  },
  {
    id: "fold-skips-terminal-messages",
    file: "crates/tea/src/pbt.rs",
    changes: [
      {
        needle: "for message in messages {",
        fault:
          'for message in messages { if current.tag() == "done" { break; }',
      },
    ],
    witness: "pbt-fold.transitions.terminal-refusal",
  },
  {
    id: "fold-corrupts-prev-handle",
    file: "crates/tea/src/pbt.rs",
    changes: [{ needle: "prev: current,", fault: "prev: Arc::clone(&next)," }],
    witness: "pbt-fold.reducer.ordered-and-terminal",
  },
];
const digest = (value) => createHash("sha256").update(value).digest("hex");
function command(program, args, options = {}) {
  const p = spawnSync(program, args, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
  assert.equal(
    p.status,
    0,
    `${program} ${args.join(" ")}\n${p.stdout}\n${p.stderr}`,
  );
  return p;
}
function parity(root, binary, reportFile, expectedExit) {
  const p = spawnSync(
    "pnpm",
    [
      "exec",
      "node",
      "--import",
      "./verification/parity/node_modules/tsx/dist/loader.mjs",
      "verification/parity/pbt-fold.mts",
      "--native-bin",
      binary,
      "--report",
      reportFile,
    ],
    { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
  assert.equal(p.status, expectedExit, `${p.stdout}\n${p.stderr}`);
  assert(
    existsSync(reportFile),
    `adapter did not write ${reportFile}\nstdout:\n${p.stdout}\nstderr:\n${p.stderr}`,
  );
  return JSON.parse(readFileSync(reportFile, "utf8"));
}
export function pbtFoldMutations({
  binary,
  reportFile = "target/parity/pbt-fold-controls.json",
  only,
} = {}) {
  assert(binary, "baseline binary required");
  const root = process.cwd();
  mkdirSync(dirname(resolve(reportFile)), { recursive: true });
  const baseline = parity(
    root,
    binary,
    resolve(`${reportFile}.baseline.json`),
    0,
  );
  assert.equal(baseline.passed, baseline.compared);
  const originals = new Map(
    [...new Set(faults.map((f) => f.file))].map((file) => [
      file,
      readFileSync(file, "utf8"),
    ]),
  );
  const controls = [];
  for (const f of faults.filter((f) => !only || only.includes(f.id))) {
    const source = originals.get(f.file);
    for (const change of f.changes)
      assert.equal(
        source.split(change.needle).length,
        2,
        `${f.id} exact source site`,
      );
    const temporary = mkdtempSync(join(tmpdir(), "demlik-pbt-fold-mutant-")),
      target = mkdtempSync(join(tmpdir(), "demlik-pbt-fold-mutant-target-"));
    try {
      for (const path of ["Cargo.toml", "Cargo.lock", "crates"])
        cpSync(join(root, path), join(temporary, path), { recursive: true });
      let changed = source;
      for (const change of f.changes)
        changed = changed.replace(change.needle, change.fault);
      writeFileSync(join(temporary, f.file), changed);
      const build = command(
        process.env.CARGO ?? "cargo",
        [
          "build",
          "--locked",
          "-p",
          "demlik-tea",
          "--example",
          "pbt_fold_driver",
        ],
        { cwd: temporary, env: { ...process.env, CARGO_TARGET_DIR: target } },
      );
      const mutant = join(target, "debug/examples/pbt_fold_driver"),
        result = parity(root, mutant, join(temporary, "result.json"), 1),
        detectedIds = result.failures.map((c) => c.id);
      assert(
        detectedIds.includes(f.witness),
        `${f.id} must change its named behavioral witness`,
      );
      const saved = resolve(`target/parity/control-binaries/${f.id}`);
      mkdirSync(dirname(saved), { recursive: true });
      cpSync(mutant, saved);
      controls.push({
        id: f.id,
        compiled: true,
        witness: f.witness,
        detectedIds,
        source: {
          path: f.file,
          originalSha256: digest(source),
          mutatedSha256: digest(changed),
        },
        binary: { path: saved, sha256: digest(readFileSync(mutant)) },
        build: { exit: build.status, stderr: build.stderr },
        results: result,
      });
      writeFileSync(
        `${reportFile}.progress.json`,
        `${JSON.stringify({ baseline: baseline.binary, controls }, null, 2)}\n`,
      );
    } finally {
      for (const [file, before] of originals)
        assert.equal(readFileSync(file, "utf8"), before);
      rmSync(temporary, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  }
  const report = {
    baseline: {
      compared: baseline.compared,
      passed: baseline.passed,
      binary: baseline.binary,
    },
    controls,
    activeSourcesUnchanged: [...originals].every(
      ([file, source]) => readFileSync(file, "utf8") === source,
    ),
  };
  assert(report.activeSourcesUnchanged);
  writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const { values } = parseArgs({
    options: {
      "native-bin": { type: "string" },
      report: { type: "string" },
      only: { type: "string" },
    },
    strict: true,
  });
  const r = pbtFoldMutations({
    binary: values["native-bin"],
    reportFile: values.report,
    only: values.only?.split(","),
  });
  console.log(
    JSON.stringify({
      baseline: r.baseline.compared,
      controls: r.controls.map((c) => ({
        id: c.id,
        compiled: c.compiled,
        detected: c.detectedIds.length,
      })),
    }),
  );
}
