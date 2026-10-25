import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url)),
  root = path.resolve(here, "../..");
const cargo = process.env.CARGO ?? "cargo";
const owner = "crates/tea/src/paginate/paginated_walk.rs";
const directory = await mkdtemp(
  path.join(tmpdir(), "demlik-paginated-walk-mutations-"),
);
const reportDirectory = path.join(root, "target/parity");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const original = await readFile(path.join(root, owner), "utf8");
const guard = `if !matches!(
            state.walk().snapshot().phase,
            PaginatorPhase::Fetching { .. }
        ) {`;
const mutations = [
  {
    name: "repeat-start-fetches-again",
    before: `if walk.ptr_eq(state.walk())
            || !matches!(walk.snapshot().phase, PaginatorPhase::Fetching { .. })`,
    after: `if !matches!(walk.snapshot().phase, PaginatorPhase::Fetching { .. })`,
    witness: "walk.repeat-arm",
  },
  {
    name: "fetch-precedes-page-work",
    before: "page_commands.extend(fetched.commands);",
    after:
      "let mut next_commands = fetched.commands;\n            next_commands.extend(page_commands);\n            page_commands = next_commands;",
    witness: "walk.command-order",
  },
  {
    name: "late-error-corrupts-resilience",
    before: `pub fn page_err(&self, state: &State<C, P, E>, msg: PageErr<E>) -> WalkResult<C, P, E, O, F> {
        ${guard}`,
    after: `pub fn page_err(&self, state: &State<C, P, E>, msg: PageErr<E>) -> WalkResult<C, P, E, O, F> {
        if false && !matches!(state.walk().snapshot().phase, PaginatorPhase::Fetching { .. }) {`,
    witness: "walk.late-done",
  },
  {
    name: "late-timer-corrupts-resilience",
    before: `msg: &DeadlineExceeded,
    ) -> WalkResult<C, P, E, O, F> {
        ${guard}`,
    after: `msg: &DeadlineExceeded,
    ) -> WalkResult<C, P, E, O, F> {
        if false && !matches!(state.walk().snapshot().phase, PaginatorPhase::Fetching { .. }) {`,
    witness: "walk.late-paused",
  },
  {
    name: "late-success-loses-page-work",
    before: `pub fn page_ok(&self, state: &State<C, P, E>, msg: PageOk<P>) -> WalkResult<C, P, E, O, F> {
        let settled`,
    after: `pub fn page_ok(&self, state: &State<C, P, E>, msg: PageOk<P>) -> WalkResult<C, P, E, O, F> {
        if !matches!(state.walk().snapshot().phase, PaginatorPhase::Fetching { .. }) { return Ok(Step::new(state.clone(), vec![])); }
        let settled`,
    witness: "walk.late-done",
  },
  {
    name: "resume-reanchors-live-resilience",
    before: `self.arm_and_fetch(
            state,
            paginator::resume(state.walk(), &self.policy),
            at.into(),
        )`,
    after: `let at = at.into();
        let state = State::from_parts(state.walk().clone(), self.rc.resume(state.resilience(), at));
        self.arm_and_fetch(&state, paginator::resume(state.walk(), &self.policy), at)`,
    witness: "walk.budget-retry",
  },
  {
    name: "drain-never-reopens-valve",
    before: "if walk.ptr_eq(state.walk()) {",
    after: "if true {",
    witness: "walk.backpressure",
  },
  {
    name: "failed-done-is-stuck",
    before: ") && !self.is_complete(state)",
    after: ")",
    witness: "walk.done-failed-slot",
  },
  {
    name: "undefined-failure-is-healthy",
    before: "Some(CallPhase::Failed { .. })",
    after:
      "Some(CallPhase::Failed { error }) if !matches!(error.as_ref(), CallFailure::Undefined | CallFailure::Missing)",
    witness: "walk.undefined-error-stuck",
  },
  {
    name: "callback-error-is-silenced",
    before: `(self.on_page)(&page).map_err(|cause| WalkError::Callback {
            phase: CallbackPhase::OnPage,
            cause,
        })?`,
    after: "(self.on_page)(&page).unwrap_or_default()",
    witness: "walk.callback-onPage",
  },
  {
    name: "fetch-key-is-not-page",
    before: 'pub const PAGE_KEY: &str = "page";',
    after: 'pub const PAGE_KEY: &str = "pages";',
    witness: "walk.basic",
  },
];
const results = [];
try {
  execFileSync(process.execPath, [path.join(here, "paginated-walk-run.mjs")], {
    cwd: root,
    stdio: "pipe",
    timeout: 120_000,
  });
  for (const file of [
    "Cargo.toml",
    "Cargo.lock",
    "rust-toolchain.toml",
    "crates",
  ])
    await cp(path.join(root, file), path.join(directory, file), {
      recursive: true,
    });
  await mkdir(reportDirectory, { recursive: true });
  for (const mutation of mutations) {
    assert.equal(
      original.split(mutation.before).length,
      2,
      `${mutation.name} exact source site`,
    );
    const modified = original.replace(mutation.before, mutation.after);
    const file = path.join(directory, owner);
    await writeFile(file, modified);
    const target = path.join(
      root,
      "target/parity/paginated-walk-mutation-build",
    );
    execFileSync(
      cargo,
      [
        "build",
        "--locked",
        "-p",
        "demlik-parity",
        "--bin",
        "paginated-walk-parity",
      ],
      {
        cwd: directory,
        env: { ...process.env, CARGO_TARGET_DIR: target },
        stdio: "pipe",
        timeout: 120_000,
      },
    );
    const binary = path.join(target, "debug/paginated-walk-parity");
    const reportFile = path.join(reportDirectory, `walk-${mutation.name}.json`);
    const result = spawnSync(
      process.execPath,
      [
        path.join(here, "paginated-walk-run.mjs"),
        "--rust-bin",
        binary,
        "--report",
        reportFile,
      ],
      {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
        timeout: 120_000,
      },
    );
    assert.equal(
      result.status,
      1,
      `${mutation.name} must fail behavior: ${result.stderr}`,
    );
    const report = JSON.parse(await readFile(reportFile, "utf8"));
    const witness = report.failures.find(
      (value) => value.id === mutation.witness,
    );
    assert.ok(witness, `${mutation.name} must fail its named contract`);
    assert.equal(witness.reference.ok, true);
    assert.equal(
      witness.native.ok,
      true,
      "a driver refusal or crash is not fault detection",
    );
    assert.deepEqual(report.referenceChanges, []);
    assert.equal(await readFile(path.join(root, owner), "utf8"), original);
    results.push({
      name: mutation.name,
      witness: mutation.witness,
      changedCases: report.failures.map((value) => value.id),
      originalSha256: hash(original),
      mutantSha256: hash(modified),
      binarySha256: hash(await readFile(binary)),
      buildSucceeded: true,
      bothWitnessesExecuted: true,
      sourceUnchanged: true,
    });
    process.stdout.write(
      `${mutation.name}: detected ${report.failures.length} cases\n`,
    );
    await writeFile(file, original);
  }
  await writeFile(
    path.join(reportDirectory, "paginated-walk-mutations.json"),
    `${JSON.stringify({ controls: results.length, detected: results.length, results }, null, 2)}\n`,
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
