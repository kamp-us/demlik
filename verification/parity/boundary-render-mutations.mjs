import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  boundaryRenderReference,
  renderCase,
} from "./boundary-render-reference.mjs";
import {
  createCheckWorktree,
  checkedExecFileSync as execFileSync,
  checkedSpawnSync as spawnSync,
} from "./check-worktree.mjs";

const baseline = process.argv[2];
assert.ok(
  baseline,
  "usage: node --import tsx boundary-render-mutations.mjs <baseline-driver> [evidence.json]",
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
  "boundary-render-mutations",
);
let mutationFailure;
try {
  const directory = mutationCheck.root;
  const workspace = mutationCheck.root;
  // Reuse the one existing lean fault cache, always separate from the baseline target.
  const targetDirectory = mutationCheck.target;
  const targetBinary = path.join(
    targetDirectory,
    "debug/examples/boundary_render_driver",
  );
  const cargo = process.env.CARGO ?? "cargo";
  const buildEnvironment = {
    ...process.env,
    CARGO_PROFILE_DEV_DEBUG: "0",
    CARGO_PROFILE_TEST_DEBUG: "0",
    CARGO_INCREMENTAL: "0",
    CARGO_BUILD_JOBS: "1",
  };
  const owner = "crates/code-graph/src/boundaries/render.rs";
  const libraryOwner = "crates/code-graph/src/boundaries/libraries/census.rs";
  const deployableOwner =
    "crates/code-graph/src/boundaries/deployables/census.rs";
  const scope = "services/api";
  const report = { scope, features: [], filesScanned: 0, violations: [] };
  const noCensuses = { libraries: null, deployables: null };
  const format = { json: false, pretty: false };
  const first = {
    scope,
    kind: "cross-feature",
    from: "src/orders/use.ts",
    to: "src/billing/private.ts",
    specifier: "../billing/private",
  };
  const b8 = { ...first, kind: "driving-reaches-driven" };
  const write = {
    file: "src/orders/adapters/driven/db.ts",
    line: 3,
    binding: "DB",
  };
  const state = {
    kind: "opaque",
    scopesChecked: 1,
    unrecorded: [],
    pruned: [],
    kept: { entries: [] },
    writes: [],
  };
  function boundaries(
    id,
    reports = [report],
    censuses = noCensuses,
    ownFormat = format,
  ) {
    return renderCase(id, "code_graph.boundary-render", {
      reports,
      under: ".",
      censuses,
      ...ownFormat,
    });
  }
  function gate(id, result) {
    return renderCase(id, "code_graph.boundary-ledger-render", {
      result,
      ...format,
    });
  }
  function occurrences(text, needle) {
    return text.split(needle).length - 1;
  }
  function call(binary, item) {
    const run = spawnSync(binary, [], {
      input: `${JSON.stringify(item)}\n`,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stderr, "");
    const answer = JSON.parse(run.stdout);
    assert.equal(answer.id, item.id);
    assert.equal(answer.ok, true, JSON.stringify(answer.error));
    assert.ok(answer.observedCalls.some((name) => name.startsWith("render_")));
    return answer.output;
  }

  const large = Number(1234567890123456768n);
  const censusWitness = boundaries(
    "large-native-counts-use-js-number-text",
    [report],
    {
      libraries: { types: {}, undeclared: [], unjudgedImports: large },
      deployables: {
        workers: [
          { worker: "api", files: [], bindings: { DB: large }, sites: [] },
        ],
        unresolvedServiceBindings: large,
      },
    },
  );
  const controls = [];
  const baselineHash = createHash("sha256")
    .update(await readFile(baseline))
    .digest("hex");
  try {
    const mutations = [
      {
        name: "empty-workers-become-absent",
        file: owner,
        before: "let mut lines = match &report.workers {",
        after:
          "let mut lines = match &report.workers.as_ref().filter(|workers| !workers.is_empty()).cloned() {",
        item: boundaries("present-empty-workers-still-have-a-call-graph", [
          { ...report, workers: [] },
        ]),
        beforeCheck: (answer) =>
          assert.equal(
            answer,
            "services/api — worker call graph\n  0 worker(s) — 0 violation(s)",
          ),
        afterCheck: (answer) => assert.ok(answer.includes("library scope")),
      },
      {
        name: "empty-requested-library-becomes-absent",
        file: owner,
        before: "let declared = if censuses.libraries.is_none() {",
        after:
          "let declared = if censuses.libraries.is_none_or(|census| census.types.is_empty()) {",
        item: boundaries(
          "requested-empty-library-still-names-library-scope",
          [],
          {
            libraries: { types: {}, undeclared: [], unjudgedImports: 0 },
            deployables: null,
          },
        ),
        beforeCheck: (answer) =>
          assert.ok(answer.includes("feature or library scope")),
        afterCheck: (answer) => assert.ok(answer.includes("no feature scope")),
      },
      {
        name: "pretty-boundary-json-ignored",
        file: owner,
        before:
          "deployables: censuses.deployables,\n            },\n            pretty,",
        after:
          "deployables: censuses.deployables,\n            },\n            false,",
        item: boundaries(
          "nested-pretty-output-is-not-compact",
          [report],
          noCensuses,
          { json: true, pretty: true },
        ),
        beforeCheck: (answer) =>
          assert.ok(answer.includes('\n  "scopes": [\n')),
        afterCheck: (answer) => assert.equal(answer.includes("\n"), false),
      },
      {
        name: "test-advice-omitted",
        file: owner,
        before: 'TestReachesCompositionRoot => ("B20", Advice::Test),',
        after: 'TestReachesCompositionRoot => ("B20", Advice::Feature),',
        item: gate("b20-adds-test-advice", {
          ...state,
          unrecorded: [{ ...first, kind: "test-reaches-composition-root" }],
        }),
        beforeCheck: (answer) =>
          assert.ok(
            answer.stdout.includes(
              "  A test drives the one feature under test",
            ),
          ),
        afterCheck: (answer) =>
          assert.equal(answer.stdout.includes("  A test drives"), false),
      },
      {
        name: "advice-follows-entry-order",
        file: owner,
        before: "let needed: BTreeSet<_> = unrecorded",
        after: "let needed: Vec<_> = unrecorded",
        item: gate("advice-groups-are-deduplicated", {
          ...state,
          unrecorded: [b8, b8],
        }),
        beforeCheck: (answer) =>
          assert.equal(
            occurrences(answer.stdout, "  In a hexagonal feature"),
            1,
          ),
        afterCheck: (answer) =>
          assert.equal(
            occurrences(answer.stdout, "  In a hexagonal feature"),
            2,
          ),
      },
      {
        name: "shape-advice-before-deployable",
        file: owner,
        before: "    Deployable,\n    Shape,",
        after: "    Shape,\n    Deployable,",
        item: gate("advice-has-canonical-group-order", {
          ...state,
          unrecorded: [
            { ...first, kind: "index-not-exports-only", to: null },
            { ...first, kind: "worker-call-cycle", to: null },
          ],
        }),
        beforeCheck: (answer) =>
          assert.ok(
            answer.stdout.indexOf("  Use a worker binding") <
              answer.stdout.indexOf("  Keep an entry file"),
          ),
        afterCheck: (answer) =>
          assert.ok(
            answer.stdout.indexOf("  Keep an entry file") <
              answer.stdout.indexOf("  Use a worker binding"),
          ),
      },
      {
        name: "pruning-fails-the-gate",
        file: owner,
        before: "let exit_code = u8::from(!passed);",
        after: "let exit_code = u8::from(!result.pruned.is_empty());",
        item: gate("pruned-only-still-passes", { ...state, pruned: [first] }),
        beforeCheck: (answer) => assert.equal(answer.exitCode, 0),
        afterCheck: (answer) => assert.equal(answer.exitCode, 1),
      },
      {
        name: "write-note-ignores-ledger-key",
        file: owner,
        before: ".writes\n                .get(&ledger_key(entry))",
        after: ".writes\n                .values()\n                .next()",
        item: gate("a-different-crossing-write-is-not-this-crossing-write", {
          ...state,
          unrecorded: [b8],
          writes: [{ entry: { ...b8, to: "different-target.ts" }, write }],
        }),
        beforeCheck: (answer) =>
          assert.equal(answer.stdout.includes("[write:"), false),
        afterCheck: (answer) => assert.ok(answer.stdout.includes("[write: DB")),
      },
      {
        name: "empty-entry-reason-omitted",
        file: owner,
        before: ".reason\n        .as_ref()\n        .map_or_else",
        after:
          ".reason\n        .as_ref()\n        .filter(|reason| !reason.is_empty())\n        .map_or_else",
        item: renderCase(
          "empty-reason-is-present-data",
          "code_graph.boundary-accepted-render",
          {
            result: { ...state, unrecorded: [{ ...first, reason: "" }] },
            reason: "new",
            ...format,
          },
        ),
        beforeCheck: (answer) => assert.ok(answer.endsWith("  — ")),
        afterCheck: (answer) => assert.equal(answer.endsWith("  — "), false),
      },
      {
        name: "migration-deduplicates-opaque-ledger",
        file: owner,
        before: "number(scopes), number(ledger.entries.len() as f64)",
        after:
          "number(scopes), number(ledger.entries.iter().map(|entry| ledger_key(entry)).collect::<BTreeSet<_>>().len() as f64)",
        item: renderCase(
          "migration-renders-given-ledger-count",
          "code_graph.boundary-migrated-render",
          { ledger: { entries: [first, first] }, scopes: 1, ...format },
        ),
        beforeCheck: (answer) =>
          assert.ok(answer.includes("with 2 crossing(s)")),
        afterCheck: (answer) =>
          assert.ok(answer.includes("with 1 crossing(s)")),
      },
      {
        name: "empty-refusal-silenced",
        file: owner,
        before:
          "pub fn render_migration_refused(breaches: &[CeilingBreach]) -> JsString {",
        after:
          "pub fn render_migration_refused(breaches: &[CeilingBreach]) -> JsString {\n    if breaches.is_empty() { return JsString::default(); }",
        item: renderCase(
          "empty-refusal-remains-an-observable-refusal",
          "code_graph.boundary-refusal-render",
          { breaches: [] },
        ),
        beforeCheck: (answer) =>
          assert.ok(
            answer.startsWith(
              "--migrate-ceilings refused, nothing written: 0 scope(s)",
            ),
          ),
        afterCheck: (answer) => assert.equal(answer, ""),
      },
      {
        name: "library-large-count-uses-rust-decimal",
        file: libraryOwner,
        before: "number(census.unjudged_imports)",
        after: "census.unjudged_imports as usize",
        item: censusWitness,
        beforeCheck: (answer) =>
          assert.ok(answer.includes("1234567890123456800 imports")),
        afterCheck: (answer) =>
          assert.ok(answer.includes("1234567890123456768 imports")),
      },
      {
        name: "deployable-large-count-uses-rust-decimal",
        file: deployableOwner,
        before: "number(n),",
        after: "n as usize,",
        item: censusWitness,
        beforeCheck: (answer) =>
          assert.ok(answer.includes("1234567890123456800 service bindings")),
        afterCheck: (answer) =>
          assert.ok(answer.includes("1234567890123456768 service bindings")),
      },
      {
        name: "binding-large-count-uses-rust-decimal",
        file: deployableOwner,
        before: 'format!(" {}", number(row.bindings[name])).into(),',
        after: 'format!(" {}", row.bindings[name] as usize).into(),',
        item: censusWitness,
        beforeCheck: (answer) =>
          assert.ok(answer.includes("DB 1234567890123456800")),
        afterCheck: (answer) =>
          assert.ok(answer.includes("DB 1234567890123456768")),
      },
      {
        name: "raw-scope-replaced-by-unicode-replacement",
        file: owner,
        before: 'report.scope.clone(), " — library scope".into()',
        after:
          'String::from_utf16_lossy(report.scope.units()).into(), " — library scope".into()',
        item: boundaries("raw-utf16-scope-survives-rendering", [
          { ...report, scope: "raw\ud800" },
        ]),
        beforeCheck: (answer) => assert.ok(answer.startsWith("raw\ud800 —")),
        afterCheck: (answer) => assert.ok(answer.startsWith("raw� —")),
      },
      {
        name: "scope-fact-narrowed-to-natural-counter",
        file: owner,
        before: "number(result.scopes_checked)",
        after: "number(result.scopes_checked as usize as f64)",
        item: gate("fractional-scope-fact-is-source-valid", {
          ...state,
          scopesChecked: 0.5,
        }),
        beforeCheck: (answer) =>
          assert.ok(answer.stdout.includes("PASS — 0.5 scope(s)")),
        afterCheck: (answer) =>
          assert.ok(answer.stdout.includes("PASS — 0 scope(s)")),
      },
      {
        name: "measured-fact-narrowed-to-natural-counter",
        file: owner,
        before: "number(breach.measured)",
        after: "number(breach.measured as usize as f64)",
        item: renderCase(
          "negative-measured-fact-is-source-valid",
          "code_graph.boundary-refusal-render",
          { breaches: [{ scope, measured: -1, ceiling: 0 }] },
        ),
        beforeCheck: (answer) =>
          assert.ok(answer.includes("api: -1 crossing(s)")),
        afterCheck: (answer) =>
          assert.ok(answer.includes("api: 0 crossing(s)")),
      },
    ];
    for (const mutation of mutations) {
      mutation.expected = boundaryRenderReference(mutation.item);
      const actual = call(baseline, mutation.item);
      assert.deepEqual(
        actual,
        mutation.expected,
        `${mutation.name}: baseline/source mismatch`,
      );
      mutation.beforeCheck(actual);
    }

    const originals = new Map();
    for (const mutation of mutations)
      if (!originals.has(mutation.file))
        originals.set(
          mutation.file,
          await readFile(path.join(root, mutation.file), "utf8"),
        );
    for (const mutation of mutations) {
      for (const [file, original] of originals)
        await writeFile(path.join(workspace, file), original);
      const original = originals.get(mutation.file);
      assert.equal(
        original.split(mutation.before).length,
        2,
        `unique fault site: ${mutation.name}`,
      );
      await writeFile(
        path.join(workspace, mutation.file),
        original.replace(mutation.before, mutation.after),
      );
      execFileSync(
        cargo,
        [
          "build",
          "--offline",
          "-p",
          "demlik-code-graph",
          "--example",
          "boundary_render_driver",
        ],
        {
          cwd: workspace,
          env: buildEnvironment,
          encoding: "utf8",
          maxBuffer: 16 * 1024 * 1024,
          stdio: "pipe",
        },
      );
      const actual = call(targetBinary, mutation.item);
      assert.notDeepEqual(
        actual,
        mutation.expected,
        `${mutation.name}: escaped`,
      );
      mutation.afterCheck(actual);
      controls.push({
        name: mutation.name,
        witness: mutation.item,
        expected: mutation.expected,
        mutant: actual,
        detected: true,
      });
      process.stdout.write(`${JSON.stringify({ detected: mutation.name })}\n`);
    }
    const afterHash = createHash("sha256")
      .update(await readFile(baseline))
      .digest("hex");
    assert.equal(
      afterHash,
      baselineHash,
      "fault builds preserve baseline driver",
    );
    const result = {
      reference: { node: process.version, v8: process.versions.v8 },
      baselineDriverUnchanged: true,
      baselineDriverHash: baselineHash,
      baselineMatchesSource: true,
      detected: controls.length,
      escaped: 0,
      buildProfile: {
        devDebug: 0,
        testDebug: 0,
        incremental: false,
        jobs: 1,
        target: targetDirectory,
      },
      controls,
    };
    if (process.argv[3])
      await writeFile(process.argv[3], `${JSON.stringify(result, null, 2)}\n`);
    process.stdout.write(
      `${JSON.stringify({ detected: result.detected, escaped: result.escaped })}\n`,
    );
  } finally {
  }
} catch (error) {
  mutationFailure = error;
  throw error;
} finally {
  mutationCheck.remove(mutationFailure);
}
