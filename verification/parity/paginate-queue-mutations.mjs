import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createCheckWorktree,
  checkedExecFileSync as execFileSync,
  checkedSpawnSync as spawnSync,
} from "./check-worktree.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const cargo = process.env.CARGO ?? "cargo";
const mutationCheck = createCheckWorktree(
  process.cwd(),
  "paginate-queue-mutations",
);
let mutationFailure;
try {
  const directory = mutationCheck.root;
  const reportDirectory = path.join(root, "target/parity");
  const mutations = [
    {
      name: "paginator-half-open-mark",
      file: "crates/tea/src/paginate/paginator.rs",
      before: "seen >= policy.high_water_mark",
      after: "seen > policy.high_water_mark",
      witness: "paginate.valve",
    },
    {
      name: "paginator-negative-contribution",
      file: "crates/tea/src/paginate/paginator.rs",
      before: "crate::js_math::max(0.0, count)",
      after: "count",
      witness: "paginate.count-0",
    },
    {
      name: "paginator-null-identity",
      file: "crates/tea/src/paginate/paginator.rs",
      before: "self.0.is_some_and(|value| value == number)",
      after: "self.number() == number",
      witness: "paginate.roundtrip-null-drain",
    },
    {
      name: "queue-claims-last-pending",
      file: "crates/tea/src/work_queue/ops.rs",
      before: ".position(|item| item.status == QueueItemStatus::Pending)?;",
      after: ".rposition(|item| item.status == QueueItemStatus::Pending)?;",
      witness: "queue.lifecycle-false",
    },
    {
      name: "queue-identity-patch-skips-change",
      file: "crates/tea/src/work_queue/ops.rs",
      before:
        "next[index] = patch(&target);\n    QueueChange {\n        next: Queue::from_items(next),\n        changed: true,\n    }",
      after:
        "let patched = patch(&target);\n    let changed = !Rc::ptr_eq(&target, &patched);\n    next[index] = patched;\n    QueueChange {\n        next: Queue::from_items(next),\n        changed,\n    }",
      witness: "queue.identity-patch",
    },
    {
      name: "queue-overwrites-refused-state",
      file: "crates/tea/src/work_queue/store.rs",
      before: ".map_err(QueueError::Restore)",
      after: ".or_else(|_| Ok(Queue::new()))",
      witness: "queue.store-migrate-refuse",
    },
    {
      name: "queue-changes-field-insertion-order",
      file: "crates/tea/src/work_queue/mod.rs",
      before: "self.field_order.push(key.into());",
      after: "self.field_order.insert(0, key.into());",
      witness: "queue.utf16",
    },
    {
      name: "queue-copies-loaded-array",
      file: "crates/tea/src/work_queue/mod.rs",
      before: "Self(self.0.clone())",
      after: "Self(Rc::new(RefCell::new(self.0.borrow().clone())))",
      witness: "queue.store-array-and-payload-alias",
    },
    {
      name: "queue-truncates-injected-clock",
      file: "crates/tea/src/work_queue/store.rs",
      before: "let result = enqueue_op(&queue, input, at, id);",
      after: "let result = enqueue_op(&queue, input, at.trunc(), id);",
      witness: "queue.store-utf16",
    },
    {
      name: "queue-drops-json-number-overflow",
      file: "crates/tea/src/data/number.rs",
      before: "PlainData::Number(value) => Ok(Self(Some(value))),",
      after:
        "PlainData::Number(value) => Ok(Self(Some(if value.is_finite() { value } else { 0.0 }))),",
      witness: "queue.raw-number-overflow",
    },
  ];
  const results = [];
  try {
    execFileSync(
      process.execPath,
      [path.join(here, "paginate-queue-run.mjs")],
      {
        cwd: root,
        stdio: "pipe",
      },
    );

    await mkdir(reportDirectory, { recursive: true });
    for (const mutation of mutations) {
      const file = path.join(directory, mutation.file);
      const original = await readFile(file, "utf8");
      assert.equal(
        original.split(mutation.before).length,
        2,
        `${mutation.name} must alter exactly one site`,
      );
      await writeFile(file, original.replace(mutation.before, mutation.after));
      const target = mutationCheck.target;
      execFileSync(
        cargo,
        [
          "build",
          "--locked",
          "--package",
          "demlik-parity",
          "--bin",
          "paginate-queue-parity",
        ],
        {
          cwd: directory,
          env: { ...process.env },
          stdio: "pipe",
        },
      );
      const reportFile = path.join(reportDirectory, `${mutation.name}.json`);
      const result = spawnSync(
        process.execPath,
        [
          path.join(here, "paginate-queue-run.mjs"),
          "--rust-bin",
          path.join(target, "debug/paginate-queue-parity"),
          "--report",
          reportFile,
        ],
        { cwd: root, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
      );
      assert.equal(
        result.status,
        1,
        `${mutation.name} must produce a behavioral failure: ${result.stderr}`,
      );
      const report = JSON.parse(await readFile(reportFile, "utf8"));
      const witness = report.failures.find(
        (test) => test.id === mutation.witness,
      );
      assert.ok(witness, `${mutation.name} must fail its named contract`);
      assert.equal(
        witness.reference.ok,
        true,
        "the reference must execute successfully",
      );
      assert.equal(
        witness.native.ok,
        true,
        "a build/driver failure does not count as detection",
      );
      results.push({
        name: mutation.name,
        detected: true,
        witness: mutation.witness,
        failures: report.failures.length,
      });
      await writeFile(file, original);
    }
    await writeFile(
      path.join(reportDirectory, "paginate-queue-mutations.json"),
      `${JSON.stringify(results, null, 2)}\n`,
    );
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  } finally {
  }
} catch (error) {
  mutationFailure = error;
  throw error;
} finally {
  mutationCheck.remove(mutationFailure);
}
