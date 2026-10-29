import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  apiFoundationReference,
  apiFoundationSchema,
} from "./api-foundation-reference.mjs";
import {
  createCheckWorktree,
  checkedExecFileSync as execFileSync,
  checkedSpawnSync as spawnSync,
} from "./check-worktree.mjs";

const baseline = process.argv[2];
assert.ok(
  baseline,
  "usage: node --import tsx api-foundation-mutations.mjs <baseline-driver> [report.json]",
);
assert.ok(process.argv.length <= 4);
assert.equal(process.version, "v22.21.1");
assert.equal(process.versions.v8, "12.4.254.21-node.33");
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const mutationCheck = createCheckWorktree(
  process.cwd(),
  "api-foundation-mutations",
);
let mutationFailure;
try {
  const directory = mutationCheck.root;
  const workspace = mutationCheck.root;
  const target = mutationCheck.target;
  const binary = path.join(target, "debug/examples/api_foundation_driver");
  const buildEnvironment = {
    ...process.env,
    CARGO_PROFILE_DEV_DEBUG: "0",
    CARGO_PROFILE_TEST_DEBUG: "0",
    CARGO_INCREMENTAL: "0",
    CARGO_BUILD_JOBS: "1",
  };
  const baseHash = createHash("sha256")
    .update(await readFile(baseline))
    .digest("hex");
  const prefix = "crates/code-graph/src/api/";
  const map = `${prefix}map.rs`,
    input = `${prefix}input.rs`,
    diff = `${prefix}diff.rs`,
    model = `${prefix}model.rs`,
    verdict = `${prefix}ratchet/verdict.rs`,
    text = `${prefix}ratchet/text.rs`;
  const pool = {
    references: [
      [],
      [
        ["z#Z", "type Z = 1;"],
        ["a#A", "type A = 1;"],
      ],
      [
        ["z#Z", "type Z = 2;"],
        ["a#A", "type A = 1;"],
      ],
    ],
    entries: [
      { text: "export declare const a: Z;", references: 1 },
      { text: "export declare const a: Z;", references: 2 },
    ],
  };
  const row = (bump = "major", callout = false) => ({
    added: { bump, callout },
    changed: { bump, callout },
    removed: { bump, callout },
  });
  const rules = (bump = "major", callout = false) => ({
    callout: "BREAKING:",
    tiers: { stable: row(bump, callout) },
  });
  const opaque = {
    root: "/package",
    base: "123456😀abcdef",
    compiler: "compiler",
    subpaths: [
      {
        subpath: ".",
        tier: "stable",
        added: [],
        removed: [],
        changed: [
          ["a", 0, 1],
          ["b", 0, 1],
        ],
      },
    ],
  };
  const context = { changes: 2, callout: "BREAKING:" };
  const counted = (bump = "minor", body = "normal") => ({
    package: "pkg",
    changesets: [
      { file: "a.md", bump, body },
      { file: "a.md", bump: "patch", body: "normal" },
    ],
  });
  function item(id, value) {
    return {
      id,
      operation: "code_graph.api-foundation",
      input: apiFoundationSchema.parse(value),
    };
  }
  const r = (id, policy = rules(), changesets = counted(), d = opaque) =>
    item(id, { action: "ratchet", pool, diff: d, policy, changesets, context });
  const d = (id, name = "a") =>
    item(id, {
      action: "diff",
      pool,
      tier: "stable",
      before: [[name, 0]],
      after: [[name, 1]],
    });
  function call(binary, request) {
    const run = spawnSync(binary, [], {
      input: `${JSON.stringify(request)}\n`,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stderr, "");
    const answer = JSON.parse(run.stdout);
    assert.equal(answer.id, request.id);
    assert.equal(answer.ok, true, JSON.stringify(answer.error));
    assert.ok(answer.observedCalls.length);
    return answer.output;
  }
  const controls = [];
  try {
    const packageRoot = path.join(directory, "package");
    await mkdir(packageRoot);
    await writeFile(
      path.join(packageRoot, "old.d.ts"),
      "export declare const x: 1;",
    );
    await writeFile(
      path.join(packageRoot, "..inside.ts"),
      "export const x = 1;",
    );
    const subpath = (id, entry, base = null) =>
      item(id, {
        action: "subpaths",
        root: packageRoot,
        map: { ".": { entry } },
        base,
      });
    const mutations = [
      {
        name: "empty-current-map-is-accepted",
        file: map,
        before: "parse_map(value, true)",
        after: "parse_map(value, false)",
        item: item("nonempty-current-map", { action: "parse-map", value: {} }),
        beforeCheck: (v) => assert.equal(v.success, false),
        afterCheck: (v) => assert.equal(v.success, true),
      },
      {
        name: "record-constructor-error-becomes-schema-issue",
        file: map,
        before: "record_object(value).map_err(ApiSchemaError::TypeError)?",
        after: "value.as_object()",
        item: item("constructor-null-is-thrown", {
          action: "parse-map",
          value: { constructor: null },
        }),
        beforeCheck: (v) => assert.equal(v.thrown.name, "TypeError"),
        afterCheck: (v) => assert.equal(v.success, false),
      },
      {
        name: "strict-unknown-keys-are-ignored",
        file: input,
        before: "if !keys.is_empty() {",
        after: "if false {",
        item: item("policy-is-strict", {
          action: "parse-policy",
          value: { ...rules(), extra: true },
        }),
        beforeCheck: (v) => assert.equal(v.issues[0].code, "unrecognized_keys"),
        afterCheck: (v) => assert.equal(v.success, true),
      },
      {
        name: "empty-policy-marker-is-accepted",
        file: input,
        before: "if text.is_empty() {",
        after: "if false {",
        item: item("marker-minimum-one", {
          action: "parse-policy",
          value: { ...rules(), callout: "" },
        }),
        beforeCheck: (v) =>
          assert.equal(
            v.issues[0].message,
            "the callout marker must be non-empty",
          ),
        afterCheck: (v) => assert.equal(v.success, true),
      },
      {
        name: "empty-base-map-is-refused",
        file: map,
        before: "parse_map(map, false)",
        after: "parse_map(map, true)",
        item: item("base-may-publish-no-subpaths", {
          action: "subpaths",
          root: packageRoot,
          map: {},
          base: "abcdef0123456789",
        }),
        beforeCheck: (v) => assert.deepEqual(v, []),
        afterCheck: (v) => assert.equal(v.thrown.name, "ApiInputError"),
      },
      {
        name: "declaration-file-is-source-entry",
        file: map,
        before: "!SOURCE_EXTENSION.test(entry) || DECLARATION_FILE.test(entry)",
        after: "!SOURCE_EXTENSION.test(entry)",
        item: subpath("declarations-refused", "old.d.ts"),
        beforeCheck: (v) => assert.match(v.thrown.message, /is not a/),
        afterCheck: (v) => assert.equal(v.length, 1),
      },
      {
        name: "dotdot-basename-is-treated-as-contained",
        file: map,
        before: 'relative.starts_with("..")',
        after: 'relative.starts_with("../")',
        item: subpath("source-dotdot-basename-refusal", "..inside.ts"),
        beforeCheck: (v) => assert.match(v.thrown.message, /lies outside/),
        afterCheck: (v) => assert.equal(v.length, 1),
      },
      {
        name: "subpath-first-refusal-is-reversed",
        file: map,
        before: "map.sort_by(|(left, _), (right, _)| left.cmp(right));",
        after: "map.sort_by(|(left, _), (right, _)| right.cmp(left));",
        item: item("sorted-first-refusal", {
          action: "subpaths",
          root: packageRoot,
          map: { z: { entry: "missing.ts" }, a: { entry: "old.d.ts" } },
          base: null,
        }),
        beforeCheck: (v) => assert.match(v.thrown.message, /API map: a:/),
        afterCheck: (v) => assert.match(v.thrown.message, /API map: z:/),
      },
      {
        name: "private-reference-change-is-ignored",
        file: diff,
        before:
          "before.text == after.text\n        && before.references.len() == after.references.len()\n        && before\n            .references\n            .iter()\n            .all(|(key, value)| after.references.get(key) == Some(value))",
        after: "before.text == after.text",
        item: d("same-text-private-type-changed"),
        beforeCheck: (v) => assert.equal(v.changes.length, 1),
        afterCheck: (v) => assert.equal(v.changes.length, 0),
      },
      {
        name: "changed-entry-identity-is-copied",
        file: diff,
        before: "after: Arc::clone(now),",
        occurrences: 2,
        after:
          "after: Arc::new(ApiEntryText { text: now.text.clone(), references: Arc::clone(&now.references) }),",
        item: d("exact-after-entry-is-shared"),
        beforeCheck: (v) => assert.equal(v.identities[0].after.entry, 1),
        afterCheck: (v) => assert.equal(v.identities[0].after.entry, null),
        unchanged: (v) => ({ diff: v.diff, changes: v.changes }),
      },
      {
        name: "prototype-wrapper-becomes-own-row",
        file: model,
        before:
          'if name == "__proto__" {\n            self.changed_prototype = Some(value);',
        after: "if false {\n            self.changed_prototype = Some(value);",
        item: d(
          "prototype-wrapper-retains-identity-without-own-key",
          "__proto__",
        ),
        beforeCheck: (v) => {
          assert.equal(v.changes.length, 0);
          assert.equal(v.prototypes.changed.after.entry, 1);
        },
        afterCheck: (v) => assert.equal(v.changes.length, 1),
      },
      {
        name: "same-name-kind-order-is-reversed",
        file: verdict,
        before: ".then(left.kind.cmp(&right.kind))",
        after: ".then(right.kind.cmp(&left.kind))",
        item: item("collision-orders-added-changed-removed", {
          action: "changes",
          pool,
          diff: {
            ...opaque,
            subpaths: [
              {
                subpath: ".",
                tier: "stable",
                added: [["a", 1]],
                changed: [["a", 0, 1]],
                removed: [["a", 0]],
              },
            ],
          },
        }),
        beforeCheck: (v) =>
          assert.deepEqual(
            v.changes.map((x) => x.kind),
            ["added", "changed", "removed"],
          ),
        afterCheck: (v) =>
          assert.deepEqual(
            v.changes.map((x) => x.kind),
            ["removed", "changed", "added"],
          ),
      },
      {
        name: "default-row-overrides-named-tier",
        file: verdict,
        before:
          "let row = change\n        .tier\n        .as_ref()\n        .and_then(|tier| policy.tiers.get(tier))\n        .or(policy.default.as_ref());",
        after:
          "let row = policy.default.as_ref().or(change.tier.as_ref().and_then(|tier| policy.tiers.get(tier)));",
        item: r("named-tier-precedence", {
          ...rules("major"),
          default: row("none"),
        }),
        beforeCheck: (v) => assert.equal(v.verdict.passed, false),
        afterCheck: (v) => assert.equal(v.verdict.passed, true),
      },
      {
        name: "equal-counted-bump-misses",
        file: verdict,
        before: "needs.bump.rank() <= highest_bump.rank()",
        after: "needs.bump.rank() < highest_bump.rank()",
        item: r("equal-bump-is-met", rules("minor")),
        beforeCheck: (v) => assert.equal(v.verdict.passed, true),
        afterCheck: (v) => assert.equal(v.verdict.passed, false),
      },
      {
        name: "required-callout-is-ignored",
        file: verdict,
        before: "&& (!needs.callout || callout_found)",
        after: "&& true",
        item: r("callout-is-independent-debt", rules("minor", true)),
        beforeCheck: (v) => assert.equal(v.verdict.passed, false),
        afterCheck: (v) => assert.equal(v.verdict.passed, true),
      },
      {
        name: "callout-is-lossy-unicode-substring",
        file: verdict,
        before:
          "item.body\n            .units()\n            .windows(rules.callout.units().len())\n            .any(|part| part == rules.callout.units())",
        after: "item.body.to_lossy().contains(&rules.callout.to_lossy())",
        item: r(
          "high-surrogate-marker-in-astral-body",
          { callout: "\ud83d", tiers: { stable: row("minor", true) } },
          counted("minor", "😀"),
        ),
        beforeCheck: (v) => assert.equal(v.verdict.calloutFound, true),
        afterCheck: (v) => assert.equal(v.verdict.calloutFound, false),
      },
      {
        name: "duplicate-counted-file-is-dropped",
        file: verdict,
        before: "files.sort();",
        after: "files.sort(); files.dedup();",
        item: r("files-are-sorted-with-duplicates", rules("none")),
        beforeCheck: (v) =>
          assert.deepEqual(v.verdict.changesets, ["a.md", "a.md"]),
        afterCheck: (v) => assert.deepEqual(v.verdict.changesets, ["a.md"]),
      },
      {
        name: "same-rule-miss-identity-is-copied",
        file: verdict,
        before: "needs: Arc::clone(needs),",
        after:
          "needs: Arc::new(BumpRule { bump: needs.bump, callout: needs.callout }),",
        item: r("same-kind-shares-parsed-rule"),
        beforeCheck: (v) =>
          assert.deepEqual(v.rulesShared, [
            [true, true],
            [true, true],
          ]),
        afterCheck: (v) =>
          assert.deepEqual(v.rulesShared, [
            [true, false],
            [false, true],
          ]),
        unchanged: (v) => ({
          verdict: v.verdict,
          text: v.text,
          identities: v.identities,
        }),
      },
      {
        name: "negative-count-uses-singular",
        file: text,
        before: "if count == 1.0 {",
        after: "if count <= 1.0 {",
        item: item("number-context-retains-source-grammar", {
          action: "render",
          pool,
          verdict: {
            passed: true,
            base: "base",
            package: "pkg",
            changesets: [],
            highestBump: "none",
            calloutFound: false,
            misses: [],
          },
          context: { changes: -1, callout: "!" },
        }),
        beforeCheck: (v) => assert.match(v.text, /-1 changes/),
        afterCheck: (v) => assert.match(v.text, /-1 change against/),
      },
      {
        name: "sha-shortening-counts-eight-units",
        file: text,
        before: "verdict.base.units().len().min(7)",
        after: "verdict.base.units().len().min(8)",
        item: r("short-sha-splits-surrogate-pair"),
        beforeCheck: (v) => assert.ok(v.text.endsWith("123456\ud83d\n")),
        afterCheck: (v) => assert.ok(v.text.endsWith("123456😀\n")),
      },
      {
        name: "reference-render-order-is-reversed",
        file: text,
        before: "keys.sort();",
        after: "keys.sort(); keys.reverse();",
        item: r("private-references-render-in-key-order"),
        beforeCheck: (v) =>
          assert.ok(
            v.text.indexOf("a#A: type A") < v.text.indexOf("z#Z: type Z"),
          ),
        afterCheck: (v) =>
          assert.ok(
            v.text.indexOf("z#Z: type Z") < v.text.indexOf("a#A: type A"),
          ),
      },
    ];
    const originals = new Map();
    for (const mutation of mutations)
      if (!originals.has(mutation.file))
        originals.set(
          mutation.file,
          await readFile(path.join(root, mutation.file), "utf8"),
        );
    const expected = new Map();
    for (const mutation of mutations) {
      const answer = JSON.parse(
        JSON.stringify(apiFoundationReference(mutation.item.input)),
      );
      assert.deepEqual(
        call(baseline, mutation.item),
        answer,
        `baseline/source: ${mutation.name}`,
      );
      mutation.beforeCheck(answer);
      expected.set(mutation.name, answer);
      assert.equal(
        originals.get(mutation.file).split(mutation.before).length,
        (mutation.occurrences ?? 1) + 1,
        `fault sites: ${mutation.name}`,
      );
    }

    for (const mutation of mutations) {
      for (const [file, original] of originals)
        await writeFile(path.join(workspace, file), original);
      await writeFile(
        path.join(workspace, mutation.file),
        originals
          .get(mutation.file)
          .replaceAll(mutation.before, mutation.after),
      );
      execFileSync(
        process.env.CARGO ?? "cargo",
        [
          "build",
          "--offline",
          "-p",
          "demlik-code-graph",
          "--example",
          "api_foundation_driver",
        ],
        {
          cwd: workspace,
          env: buildEnvironment,
          encoding: "utf8",
          maxBuffer: 16 * 1024 * 1024,
          stdio: "pipe",
        },
      );
      const actual = call(binary, mutation.item),
        source = expected.get(mutation.name);
      assert.notDeepEqual(actual, source, `${mutation.name}: escaped`);
      mutation.afterCheck(actual);
      if (mutation.unchanged)
        assert.deepEqual(
          mutation.unchanged(actual),
          mutation.unchanged(source),
          `${mutation.name}: independent identity witness`,
        );
      controls.push({
        name: mutation.name,
        detected: true,
        item: mutation.item,
        expected: source,
        mutant: actual,
      });
      process.stdout.write(
        `${JSON.stringify({ detected: mutation.name, witness: mutation.item.id })}\n`,
      );
    }
    assert.equal(
      createHash("sha256")
        .update(await readFile(baseline))
        .digest("hex"),
      baseHash,
      "isolated target preserves baseline driver",
    );
    const report = {
      detected: controls.length,
      escaped: 0,
      baselineMatchesSource: true,
      baselineDriverUnchanged: true,
      baselineDriverHash: baseHash,
      reference: { node: process.version, v8: process.versions.v8 },
      buildProfile: {
        devDebug: 0,
        testDebug: 0,
        incremental: false,
        jobs: 1,
        target,
      },
      controls,
    };
    if (process.argv[3])
      await writeFile(process.argv[3], `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(
      `${JSON.stringify({ detected: report.detected, escaped: report.escaped })}\n`,
    );
  } finally {
  }
} catch (error) {
  mutationFailure = error;
  throw error;
} finally {
  mutationCheck.remove(mutationFailure);
}
