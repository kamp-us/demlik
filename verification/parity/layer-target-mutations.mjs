import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTargetResolver } from "../../packages/code-graph/src/layers/resolve-target.js";

const baseline = process.argv[2];
assert.ok(
  baseline,
  "usage: node --import tsx layer-target-mutations.mjs <baseline-native-driver> [evidence.json]",
);
assert.ok(process.argv.length <= 4, "unexpected arguments");
assert.equal(process.version, "v22.21.1");
assert.equal(process.versions.v8, "12.4.254.21-node.33");
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const directory = await mkdtemp(
  path.join(tmpdir(), "demlik-layer-target-faults-"),
);
const workspace = path.join(directory, "workspace");
const project = path.join(directory, "project");
const cargo = process.env.CARGO ?? "cargo";
const targetDirectory = path.join(
  root,
  "target/parity/layer-target-mutation-build",
);
const owner = "crates/code-graph/src/layers/resolve_target.rs";
const recovery =
  "crates/code-graph/src/extract/wrangler_config/document/recovery.rs";
const resolve = (specifier) => ({
  action: "resolve",
  fromFile: "src/page.ts",
  specifier,
});
const item = (id, steps) => ({
  id,
  operation: "code_graph.layer_targets",
  input: { repoRoot: project, steps },
});
async function setup(config = "{}") {
  await rm(project, { recursive: true, force: true });
  const files = {
    "src/page.ts": "export {};",
    "src/lib/value.ts": "export {};",
    "src/lib/value.tsx": "export {};",
    "tsconfig.json": config,
    "first.json": '{"compilerOptions":{"paths":{"@first/*":[]}}}',
    "base.json": '{"compilerOptions":{"paths":{"@a/*":[]}}}',
    "node_modules/private.ts": "export {};",
  };
  for (const [file, contents] of Object.entries(files)) {
    const absolute = path.join(project, file);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, contents);
  }
}
function call(binary, item) {
  const child = spawnSync(binary, [], {
    input: `${JSON.stringify(item)}\n`,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stderr, "");
  const answer = JSON.parse(child.stdout);
  assert.equal(answer.id, item.id);
  assert.equal(answer.ok, true, JSON.stringify(answer.error));
  assert.ok(answer.observedCalls.includes("create_target_resolver"));
  assert.ok(answer.observedCalls.includes("TargetResolver::resolve"));
  return answer;
}
async function reference(item) {
  const resolveTarget = createTargetResolver(item.input.repoRoot);
  const out = [];
  for (const step of item.input.steps) {
    if (step.action === "write")
      await writeFile(path.join(item.input.repoRoot, step.file), step.contents);
    else out.push(resolveTarget(step.fromFile, step.specifier));
  }
  return out;
}
const controls = [];
try {
  const gap = { kind: "unresolved", specifier: "@a/missing" };
  const external = { kind: "external" };
  const mutations = [
    {
      name: "relative-probe-prefers-tsx",
      file: owner,
      before: '[".ts", ".tsx", ".d.ts", "/index.ts", "/index.tsx", ""]',
      after: '[".tsx", ".ts", ".d.ts", "/index.ts", "/index.tsx", ""]',
      item: item("probe-priority", [resolve("./lib/value")]),
      expected: [{ kind: "file", file: "src/lib/value.ts" }],
      changed: [{ kind: "file", file: "src/lib/value.tsx" }],
    },
    {
      name: "relative-js-suffix-is-not-stripped",
      file: owner,
      before: '[".js", ".jsx", ".mjs", ".cjs"]',
      after: '[".never"]',
      item: item("js-suffix", [resolve("./lib/value.js")]),
      expected: [{ kind: "file", file: "src/lib/value.ts" }],
      changed: [{ kind: "unresolved", specifier: "./lib/value.js" }],
    },
    {
      name: "extends-uses-first-parent",
      file: owner,
      before: "config.extends.into_iter().rev()",
      after: "config.extends.into_iter()",
      config: '{"extends":["./first.json","./base.json"]}',
      item: item("reverse-extends", [resolve("@a/missing")]),
      expected: [gap],
      changed: [external],
    },
    {
      name: "own-empty-paths-inherits-parent",
      file: owner,
      before: "if let Some(keys) = config.paths {",
      after:
        "if let Some(keys) = config.paths.filter(|keys| !keys.is_empty()) {",
      config: '{"extends":"./base.json","compilerOptions":{"paths":{}}}',
      item: item("empty-paths-replace", [resolve("@a/missing")]),
      expected: [external],
      changed: [gap],
    },
    {
      name: "node-modules-target-counted-as-repo",
      file: owner,
      before: ".any(|part| part == node_modules.units())",
      after: ".any(|part| { let _ = (part, &node_modules); false })",
      config:
        '{"compilerOptions":{"paths":{"private":["./node_modules/private.ts"]}}}',
      item: item("modules-external", [resolve("private")]),
      expected: [external],
      changed: [{ kind: "file", file: "node_modules/private.ts" }],
    },
    {
      name: "jsonc-error-string-not-repaired",
      file: recovery,
      before: "if let Some(repaired) = repair_tokens(raw, &parsed.syntax()) {",
      after:
        "if let Some(repaired) = repair_tokens(raw, &parsed.syntax()).filter(|_| false) {",
      config: '{"compilerOptions":{"paths":{"@\\q/*":[]}}}',
      item: item("escape-key-retained", [resolve("@/missing")]),
      expected: [{ kind: "unresolved", specifier: "@/missing" }],
      changed: [external],
    },
    {
      name: "jsonc-numeric-prefix-dropped",
      file: recovery,
      before: "while !prefix.is_empty() {",
      after: "while !prefix.is_empty() && false {",
      config: '{"compilerOptions":{"paths":{"@a/*":1e}}}',
      item: item("numeric-key-retained", [resolve("@a/missing")]),
      expected: [gap],
      changed: [external],
    },
    {
      name: "null-alias-cache-is-not-cached",
      file: owner,
      before: "self.keys_by_config.get(file)",
      after: "None::<&Option<Vec<JsString>>>",
      item: item("cached-null-survives-write", [
        resolve("@a/missing"),
        {
          action: "write",
          file: "tsconfig.json",
          contents: '{"compilerOptions":{"paths":{"@a/*":[]}}}',
        },
        resolve("@a/missing"),
      ]),
      expected: [external, external],
      changed: [external, gap],
    },
  ];
  await mkdir(workspace);
  for (const file of [
    "Cargo.toml",
    "Cargo.lock",
    "rust-toolchain.toml",
    "crates",
  ])
    await cp(path.join(root, file), path.join(workspace, file), {
      recursive: true,
    });
  for (const mutation of mutations) {
    await setup(mutation.config);
    const expected = await reference(mutation.item);
    assert.deepEqual(expected, mutation.expected, mutation.name);
    await setup(mutation.config);
    const original = call(baseline, mutation.item);
    assert.deepEqual(original.output, expected, mutation.name);
    const file = path.join(workspace, mutation.file),
      source = await readFile(file, "utf8");
    assert.equal(
      source.split(mutation.before).length,
      2,
      `${mutation.name}: exactly one owning edit`,
    );
    await writeFile(file, source.replace(mutation.before, mutation.after));
    process.stderr.write(
      `building disposable native fault: ${mutation.name}\n`,
    );
    execFileSync(
      cargo,
      [
        "build",
        "--locked",
        "--offline",
        "--package",
        "demlik-code-graph",
        "--example",
        "layer_target_driver",
      ],
      {
        cwd: workspace,
        env: { ...process.env, CARGO_TARGET_DIR: targetDirectory },
        stdio: "pipe",
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    await setup(mutation.config);
    const changed = call(
      path.join(targetDirectory, "debug/examples/layer_target_driver"),
      mutation.item,
    );
    assert.notDeepEqual(changed.output, original.output, mutation.name);
    assert.deepEqual(changed.output, mutation.changed, mutation.name);
    controls.push({
      name: mutation.name,
      detected: true,
      witness: mutation.item.id,
      baseline: original,
      mutated: changed,
    });
    await writeFile(file, source);
  }
  const evidence = {
    passed: controls.length,
    reference: {
      node: process.version,
      v8: process.versions.v8,
      resolver: "OXC 11.24.2",
      profile:
        "successful baseline/source/disposable compiled native calls; independently asserted intended changed outputs",
    },
    controls,
  };
  if (process.argv[3])
    await writeFile(process.argv[3], `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(
    JSON.stringify(
      {
        ...evidence,
        controls: controls.map(({ name, detected, witness }) => ({
          name,
          detected,
          witness,
        })),
      },
      null,
      2,
    ),
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
