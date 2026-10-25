import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const require = createRequire(import.meta.url);
const directory = await mkdtemp(path.join(tmpdir(), "demlik-boundary-domain-"));
const reports = path.join(root, "target/parity");
const target = path.join(reports, "reconcile-mutation-build");
const faults = [
  {
    name: "entry-prefers-last-form",
    file: "shape/entry_file.rs",
    before: '.nodes("body").into_iter().find_map(form_of)',
    after: '.nodes("body").into_iter().rev().find_map(form_of)',
    script: "graph-shape-entry.mts",
    driver: "boundary_domain_driver",
    witness: "first-default",
  },
  {
    name: "entry-accepts-empty-named-reexport",
    file: "shape/entry_file.rs",
    before:
      'statement.nodes("specifiers").is_empty() {\n                Some("statement")',
    after: 'statement.nodes("specifiers").is_empty() {\n                None',
    script: "graph-shape-entry.mts",
    driver: "boundary_domain_driver",
    witness: "form-25",
  },
  {
    name: "binding-main-is-not-clean",
    file: "deployables/bindings.rs",
    before: "let clean = if file.is_main {",
    after: "let clean = if false && file.is_main {",
    script: "graph-deployable-judgments.mts",
    driver: "deployables_driver",
    witness: "deployables.all-kinds-main-and-nested",
  },
  {
    name: "binding-owners-exempt-application",
    file: "deployables/bindings.rs",
    before: "} else if !file.driven {",
    after: "} else if !file.driven && file.owners.is_empty() {",
    script: "graph-deployable-judgments.mts",
    driver: "deployables_driver",
    witness: "deployables.owner-owner-does-not-exempt-application",
  },
  {
    name: "deployable-reader-ignores-unparsed-workers",
    file: "deployables/model.rs",
    before: "if !reading.is_empty() && !catalog.unparsed_configs.is_empty() {",
    after:
      "if false && !reading.is_empty() && !catalog.unparsed_configs.is_empty() {",
    script: "graph-deployable-judgments.mts",
    driver: "deployables_driver",
    witness: 'deployables.broken-config-["binding-outside-driven-adapter"]',
  },
  {
    name: "library-allowance-forgets-inherited-function-name",
    file: "libraries/allowance.rs",
    before: 'Ok(if dir == "name" {',
    after: 'Ok(if false && dir == "name" {',
    script: "graph-library-judgments.mts",
    driver: "libraries_driver",
    witness: 'library-judgment.inherited-toString-name-"toString"-false',
  },
  {
    name: "workspace-crossing-keeps-last-type-only",
    file: "deployables/workspaces.rs",
    before: "held.1 &= edge.type_only;",
    after: "held.1 = edge.type_only;",
    script: "graph-deployable-paths.mts",
    driver: "deployables_driver",
    witness: "workspace-path-0-1",
  },
  {
    name: "worker-graph-judges-durable-object-targets",
    file: "deployables/cycles.rs",
    before: "if declaration.kind != BindingKind::Service {",
    after: "if declaration.kind == BindingKind::Workflow {",
    script: "graph-deployable-paths.mts",
    driver: "deployables_driver",
    witness: "worker-graph.catalog-0",
  },
  {
    name: "worker-cycles-judge-single-workers",
    file: "deployables/cycles.rs",
    before: ".filter(|members| members.len() > 1)",
    after: ".filter(|members| !members.is_empty())",
    script: "graph-deployable-paths.mts",
    driver: "deployables_driver",
    witness: "worker-cycles.self-binding-is-not-cycle",
  },
  {
    name: "library-allowance-accepts-unreadable-imports",
    file: "libraries/allowance.rs",
    before: "if imported.unreadable {",
    after: "if false && imported.unreadable {",
    script: "graph-library-judgments.mts",
    driver: "libraries_driver",
    witness: "library-judgment.allowance-unreadable",
  },
  {
    name: "library-verdict-loses-type-precedence",
    file: "libraries/violations.rs",
    before: "if barred {",
    after: "if false && barred {",
    script: "graph-library-judgments.mts",
    driver: "libraries_driver",
    witness: "library-judgment.precedence-and-impurity",
  },
  {
    name: "library-census-counts-unmeasured-scopes",
    file: "libraries/census.rs",
    before: ".filter(|dir| scopes.contains(dir))",
    after: ".filter(|dir| { let _ = (&scopes, dir); true })",
    script: "graph-library-judgments.mts",
    driver: "libraries_driver",
    witness: "library-judgment.empty-measured-scopes",
  },
  {
    name: "library-owner-ignores-nearest-library",
    file: "libraries.rs",
    before:
      "dirs.sort_by_key(|dir| std::cmp::Reverse(dir.encode_utf16().count()));",
    after: "dirs.sort_by_key(|dir| dir.encode_utf16().count());",
    script: "graph-libraries.mts",
    driver: "libraries_driver",
    witness: "libraries.real-packages-and-nearest-owner",
  },
  {
    name: "workspace-duplicate-takes-last-owner",
    file: "../layers/resolve_target.rs",
    before: "if by_name.contains_key(name) {",
    after: "if false && by_name.contains_key(name) {",
    script: "graph-libraries.mts",
    driver: "libraries_driver",
    witness: "packages.order-0",
  },
  {
    name: "impurity-ignores-runtime-imports",
    file: "impure.rs",
    before: ".filter(|edge| runtime.contains(&edge.specifier))",
    after: ".filter(|edge| runtime.contains(&edge.specifier) || true)",
    witness: "runtime-filter",
  },
  {
    name: "declaration-allows-duplicate-features",
    file: "declaration.rs",
    before: "if seen.contains(feature) {",
    after: "if false && seen.contains(feature) {",
    witness: "duplicate-feature",
  },
  {
    name: "impurity-forgets-bound-names",
    file: "impure_uses.rs",
    before: "bound: bound_names(syntax),",
    after: "bound: IndexSet::new(),",
    script: "graph-impure-uses.mts",
    witness: "bound-parameter",
  },
  {
    name: "test-role-keeps-impurity-verdicts",
    file: "zones/test_role.rs",
    before: "    match kind {",
    after:
      "    if matches!(kind, BoundaryKind::Impure) { return true; }\n    match kind {",
    script: "graph-boundary-zones.mts",
    witness: "test-role-all-kinds",
  },
];
try {
  for (const name of [
    "Cargo.toml",
    "Cargo.lock",
    "rust-toolchain.toml",
    "crates",
  ])
    await cp(path.join(root, name), path.join(directory, name), {
      recursive: true,
    });
  await mkdir(reports, { recursive: true });
  const receipt = [];
  for (const fault of faults) {
    const file = path.join(
      directory,
      "crates/code-graph/src/boundaries",
      fault.file,
    );
    const source = await readFile(
      path.join(root, "crates/code-graph/src/boundaries", fault.file),
      "utf8",
    );
    assert.equal(source.split(fault.before).length, 2, fault.name);
    await writeFile(file, source.replace(fault.before, fault.after));
    execFileSync(
      process.env.CARGO ?? "cargo",
      [
        "build",
        "--locked",
        "--package",
        "demlik-code-graph",
        "--example",
        fault.driver ?? "boundary_domain_driver",
      ],
      {
        cwd: directory,
        env: { ...process.env, CARGO_TARGET_DIR: target },
        stdio: "pipe",
      },
    );
    const reportFile = path.join(reports, `${fault.name}.json`);
    await rm(reportFile, { force: true });
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        require.resolve("tsx"),
        path.join(here, fault.script ?? "graph-boundary-domain.mts"),
        path.join(
          target,
          "debug/examples",
          fault.driver ?? "boundary_domain_driver",
        ),
        reportFile,
      ],
      { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    );
    assert.equal(result.status, 1, result.stderr);
    const report = JSON.parse(await readFile(reportFile, "utf8"));
    const witness = report.failures.find((item) => item.id === fault.witness);
    assert.ok(witness, fault.name);
    assert.equal(witness.reference.ok, true);
    assert.equal(witness.native.ok, true, "a failed driver is not detection");
    await writeFile(file, source);
    receipt.push({
      name: fault.name,
      detected: true,
      witness: witness.id,
      failures: report.failures.length,
      reportFile,
    });
  }
  await writeFile(
    path.join(reports, "boundary-domain-mutations.json"),
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
} finally {
  await rm(directory, { recursive: true, force: true });
}
