import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  shapeJudgmentReference,
  shapeJudgmentSchema,
} from "./shape-judgment-reference.mjs";

const baseline = process.argv[2];
assert.ok(
  baseline,
  "usage: node --import tsx shape-judgment-mutations.mjs <baseline-driver> [evidence.json]",
);
assert.ok(process.argv.length <= 4);
assert.equal(process.version, "v22.21.1");
assert.equal(process.versions.v8, "12.4.254.21-node.33");
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const directory = await mkdtemp(
  path.join(tmpdir(), "demlik-shape-judgment-faults-"),
);
const project = path.join(directory, "project"),
  workspace = path.join(directory, "workspace");
const targetDirectory = path.join(
    root,
    "target/parity/shape-judgment-mutation-build",
  ),
  targetBinary = path.join(
    targetDirectory,
    "debug/examples/shape_judgment_driver",
  );
const cargo = process.env.CARGO ?? "cargo";
const buildEnvironment = {
  ...process.env,
  CARGO_PROFILE_DEV_DEBUG: "0",
  CARGO_PROFILE_TEST_DEBUG: "0",
  CARGO_INCREMENTAL: "0",
  CARGO_BUILD_JOBS: "1",
  CARGO_TARGET_DIR: targetDirectory,
};
const applicationOwner =
    "crates/code-graph/src/boundaries/shape/application.rs",
  judgeOwner = "crates/code-graph/src/boundaries/shape/judge.rs";
const scope = "services/api",
  file = "src/orders/application/use.ts";
const rules = {
  features: { [scope]: ["orders"] },
  libraryTypes: {
    core: { imports: [], pure: true },
    adapter: { imports: [], pure: false, importedFrom: ["driven"] },
  },
  libraries: { "packages/core": "core", "packages/adapter": "adapter" },
  applicationShape: [
    "index-not-exports-only",
    "application-import-outside-allowlist",
  ],
  applicationMayImport: ["core"],
  pureDependencies: ["zod"],
};
const edge = (specifier, target = null, typeOnly = false) => ({
  specifier,
  kind: "static",
  typeOnly,
  target,
});
function item(id, edges, extra = {}, form = null) {
  return {
    id,
    operation: "code_graph.shape-judgment",
    input: {
      repoRoot: project,
      rules,
      scope,
      file,
      facts: {
        kind: "opaque",
        edges,
        runtimeSpecifiers: edges
          .filter((edge) => !edge.typeOnly)
          .map((edge) => edge.specifier),
        offendingForm: form,
      },
      action: { kind: "judge", placeFile: file },
      judged: [],
      ...extra,
    },
  };
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
  const method =
    item.input.action.kind === "application"
      ? "application_violations"
      : "judge_shape";
  assert.ok(
    answer.observedCalls.includes(method),
    JSON.stringify(answer.observedCalls),
  );
  return answer.output;
}
const first = (answer) => answer.violations[0];
const controls = [];
const baselineHash = createHash("sha256")
  .update(await readFile(baseline))
  .digest("hex");
try {
  await mkdir(project, { recursive: true });
  for (const kind of ["core", "adapter"]) {
    await mkdir(path.join(project, `packages/${kind}`), { recursive: true });
    await writeFile(
      path.join(project, `packages/${kind}/package.json`),
      JSON.stringify({ name: `@shop/${kind}` }),
    );
  }
  const collision = `${scope}/src/generated/client.ts`;
  const disabledEntry = item(
    "disabled-entry-kind",
    [],
    {
      rules: { ...rules, applicationShape: [] },
      file: "src/orders/index.ts",
      action: { kind: "judge", placeFile: "src/orders/index.ts" },
    },
    "declaration",
  );
  const mutations = [
    {
      name: "equal-copy-is-judged",
      file: applicationOwner,
      before: "std::ptr::eq(*held, edge)",
      after:
        "held.specifier == edge.specifier && held.kind == edge.kind && held.type_only == edge.type_only && held.target == edge.target",
      item: item("equal-object-does-not-share-membership", [edge("hono")], {
        judged: [{ kind: "copy", index: 0 }],
      }),
      beforeCheck: (answer) => assert.equal(answer.violations.length, 1),
      afterCheck: (answer) => assert.deepEqual(answer.violations, []),
    },
    {
      name: "last-specifier-replaces-first",
      file: applicationOwner,
      before: "held.to = to;",
      after: "held.to = to; held.specifier = &edge.specifier;",
      item: item("first-specifier-is-retained", [
        edge("z-alias", "src/generated/client.ts", true),
        edge("a-alias", "src/generated/client.ts", false),
      ]),
      beforeCheck: (answer) => assert.equal(first(answer).specifier, "z-alias"),
      afterCheck: (answer) => assert.equal(first(answer).specifier, "a-alias"),
    },
    {
      name: "type-only-fold-uses-or",
      file: applicationOwner,
      before: "held.type_only &= edge.type_only;",
      after: "held.type_only |= edge.type_only;",
      item: item("one-runtime-import-makes-the-reach-runtime", [
        edge("a", "src/generated/client.ts", true),
        edge("b", "src/generated/client.ts", false),
      ]),
      beforeCheck: (answer) => assert.equal(first(answer).typeOnly, false),
      afterCheck: (answer) => assert.equal(first(answer).typeOnly, true),
    },
    {
      name: "first-target-owns-map-collision",
      file: applicationOwner,
      before: "held.to = to;",
      after: "if held.to.is_none() { held.to = to; }",
      item: item("latest-edge-owns-to-at-one-map-key", [
        edge("file-alias", "src/generated/client.ts", true),
        edge(collision),
      ]),
      beforeCheck: (answer) => assert.equal(first(answer).to, null),
      afterCheck: (answer) => assert.equal(first(answer).to, collision),
    },
    {
      name: "impure-module-is-judged-again",
      file: applicationOwner,
      before:
        "!impure_modules_opened(std::slice::from_ref(edge), file.runtime_specifiers).is_empty()",
      after:
        "false && !impure_modules_opened(std::slice::from_ref(edge), file.runtime_specifiers).is_empty()",
      item: item("runtime-impure-import-belongs-to-b7", [edge("node:fs")]),
      beforeCheck: (answer) => assert.deepEqual(answer.violations, []),
      afterCheck: (answer) => assert.equal(first(answer).specifier, "node:fs"),
    },
    {
      name: "restricted-library-is-judged-again",
      file: applicationOwner,
      before: "&& imported_from_outside(world.libraries, &dir.into(), None)",
      after:
        "&& false && imported_from_outside(world.libraries, &dir.into(), None)",
      item: item("restricted-library-belongs-to-b14", [edge("@shop/adapter")]),
      beforeCheck: (answer) => assert.deepEqual(answer.violations, []),
      afterCheck: (answer) =>
        assert.equal(first(answer).specifier, "@shop/adapter"),
    },
    {
      name: "pure-package-subpath-is-refused",
      file: applicationOwner,
      before: "in_package_globs(&world.rules.pure, specifier)",
      after: "false && in_package_globs(&world.rules.pure, specifier)",
      item: item("pure-package-covers-its-subpath", [edge("zod/v4")]),
      beforeCheck: (answer) => assert.deepEqual(answer.violations, []),
      afterCheck: (answer) => assert.equal(first(answer).specifier, "zod/v4"),
    },
    {
      name: "own-zone-allowlist-is-ignored",
      file: applicationOwner,
      before: "file.own.contains(&place.zone_name())",
      after: "false && file.own.contains(&place.zone_name())",
      item: item("own-ports-remain-allowed", [
        edge("../ports", "src/orders/ports.ts"),
      ]),
      beforeCheck: (answer) => assert.deepEqual(answer.violations, []),
      afterCheck: (answer) =>
        assert.equal(first(answer).to, `${scope}/src/orders/ports.ts`),
    },
    {
      name: "b15-runs-while-disabled",
      file: judgeOwner,
      before:
        "context\n        .shape\n        .kinds\n        .contains(&ShapeKind::IndexNotExportsOnly)",
      after: "true",
      item: disabledEntry,
      beforeCheck: (answer) => assert.deepEqual(answer.violations, []),
      afterCheck: (answer) =>
        assert.equal(first(answer).kind, "index-not-exports-only"),
    },
    {
      name: "b16-runs-while-disabled",
      file: judgeOwner,
      before:
        "context\n        .shape\n        .kinds\n        .contains(&ShapeKind::ApplicationImportOutsideAllowlist)",
      after: "true",
      item: item("disabled-application-kind", [edge("hono")], {
        rules: { ...rules, applicationShape: [] },
      }),
      beforeCheck: (answer) => assert.deepEqual(answer.violations, []),
      afterCheck: (answer) =>
        assert.equal(
          first(answer).kind,
          "application-import-outside-allowlist",
        ),
    },
    {
      name: "inner-library-barrel-becomes-entry",
      file: judgeOwner,
      before: 'file.file == "src/index.ts"',
      after: 'file.file.to_lossy().ends_with("index.ts")',
      item: item(
        "only-the-library-root-entry",
        [],
        {
          scope: "packages/core",
          file: "src/schema/index.ts",
          action: { kind: "judge", placeFile: "src/schema/index.ts" },
        },
        "declaration",
      ),
      beforeCheck: (answer) => assert.deepEqual(answer.violations, []),
      afterCheck: (answer) =>
        assert.equal(first(answer).kind, "index-not-exports-only"),
    },
    {
      name: "any-library-grants-entry-scope",
      file: judgeOwner,
      before: ".any(|dir| context.scope == dir)",
      after: ".any(|_| true)",
      item: item(
        "library-entry-belongs-to-its-own-scope",
        [],
        {
          file: "src/index.ts",
          action: { kind: "judge", placeFile: "src/index.ts" },
        },
        "declaration",
      ),
      beforeCheck: (answer) => assert.deepEqual(answer.violations, []),
      afterCheck: (answer) =>
        assert.equal(first(answer).kind, "index-not-exports-only"),
    },
  ];
  for (const mutation of mutations) {
    shapeJudgmentSchema.parse(mutation.item.input);
    const expected = JSON.parse(
      JSON.stringify(shapeJudgmentReference(mutation.item.input)),
    );
    const answer = call(baseline, mutation.item);
    assert.deepEqual(
      answer,
      expected,
      `${mutation.name}: baseline/source mismatch`,
    );
    mutation.beforeCheck(answer);
    mutation.expected = expected;
  }
  await mkdir(workspace);
  for (const entry of ["Cargo.toml", "Cargo.lock", "crates"])
    await cp(path.join(root, entry), path.join(workspace, entry), {
      recursive: true,
    });
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
        "shape_judgment_driver",
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
    assert.notDeepEqual(actual, mutation.expected, `${mutation.name}: escaped`);
    mutation.afterCheck(actual);
    controls.push({
      name: mutation.name,
      witness: mutation.item.id,
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
    "fault builds must preserve the baseline driver",
  );
  const report = {
    baselineDriverUnchanged: true,
    baselineDriverHash: baselineHash,
    detected: controls.length,
    escaped: 0,
    baselineMatchesSource: true,
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
    await writeFile(process.argv[3], `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(
    `${JSON.stringify({ detected: report.detected, escaped: report.escaped })}\n`,
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
