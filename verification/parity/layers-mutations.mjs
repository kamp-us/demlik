import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCheapProject } from "../../packages/code-graph/src/extract/project.js";
import { analyzeLayers } from "../../packages/code-graph/src/layers/analyze.js";
import {
  compileMatchers,
  LayerTieError,
  layerOf,
} from "../../packages/code-graph/src/layers/classify.js";
import { reconcile } from "../../packages/code-graph/src/layers/reconcile.js";
import {
  AllowedEdgeSchema,
  LayerRulesSchema,
} from "../../packages/code-graph/src/layers/rules.js";
import {
  createCheckWorktree,
  checkedExecFileSync as execFileSync,
  checkedSpawnSync as spawnSync,
} from "./check-worktree.mjs";

const baseline = process.argv[2];
assert.ok(
  baseline,
  "usage: node --import tsx layers-mutations.mjs <baseline-layer-driver> [evidence.json]",
);
assert.ok(process.argv.length <= 4);
assert.equal(process.version, "v22.21.1");
assert.equal(process.versions.v8, "12.4.254.21-node.33");
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const mutationCheck = createCheckWorktree(process.cwd(), "layers-mutations");
let mutationFailure;
try {
  const directory = mutationCheck.root;
  const workspace = mutationCheck.root,
    project = path.join(directory, "project");
  const targetDirectory = mutationCheck.target;
  const cargo = process.env.CARGO ?? "cargo";
  const base = "crates/code-graph/src/layers/";
  const edge = (from, to, line = 1) => ({
    from,
    fromLine: line,
    fromLayer: "domain",
    toLine: 1,
    to,
    toLayer: "service",
    specifier: "../target",
    typeOnly: false,
  });
  const allowed = (from, to, sites, reason = "why") => ({
    from,
    to,
    sites,
    reason,
  });
  const report = (violations) => ({
    layers: ["service", "domain"],
    filesScanned: 2,
    census: {
      down: 0,
      sideways: 0,
      up: violations.length,
      unlayered: 0,
      external: 0,
      unresolved: 0,
    },
    violations,
    unresolved: [],
  });
  const item = (id, operation, input) => ({
    id,
    operation: `code_graph.layer_${operation}`,
    input,
  });
  function parsed(schema, value) {
    const result = schema.safeParse(value);
    return result.success
      ? { valid: true, data: result.data }
      : { valid: false, issue: result.error.issues[0] };
  }
  function reference(item) {
    switch (item.operation) {
      case "code_graph.layer_schema":
        return parsed(LayerRulesSchema, item.input.value);
      case "code_graph.layer_sites_schema":
        return parsed(AllowedEdgeSchema, {
          from: "a",
          to: "b",
          sites: item.input.sites,
          reason: "why",
        });
      case "code_graph.layer_classify": {
        const matchers = compileMatchers(item.input.layers);
        return item.input.files.map((file) => {
          try {
            return layerOf(file, matchers);
          } catch (error) {
            if (!(error instanceof LayerTieError)) throw error;
            return {
              thrown: {
                name: error.name,
                message: error.message,
                file: error.file,
                patterns: error.patterns,
              },
            };
          }
        });
      }
      case "code_graph.layer_analyze":
        return analyzeLayers(
          loadCheapProject(item.input.root),
          item.input.repoRoot,
          LayerRulesSchema.parse(item.input.rules),
        );
      case "code_graph.layer_reconcile":
        return reconcile(item.input.report, item.input.allowed);
      default:
        throw Error(`unknown operation ${item.operation}`);
    }
  }
  function call(binary, item) {
    const child = spawnSync(binary, [], {
      input: `${JSON.stringify(item)}\n`,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stderr, "");
    const answer = JSON.parse(child.stdout);
    assert.equal(answer.id, item.id);
    assert.equal(answer.ok, true, JSON.stringify(answer.error));
    const owner = {
      "code_graph.layer_schema": "LayerRules::parse",
      "code_graph.layer_sites_schema": "AllowedEdge::parse",
      "code_graph.layer_classify": "classify::layer_of",
      "code_graph.layer_analyze": "analyze::analyze_layers",
      "code_graph.layer_reconcile": "reconcile::reconcile",
    }[item.operation];
    assert.ok(owner);
    assert.ok(answer.observedCalls.includes(owner));
    return answer;
  }
  const controls = [];
  try {
    await mkdir(project, { recursive: true });
    await mkdir(path.join(project, "src/domain"), { recursive: true });
    await writeFile(
      path.join(project, "src/service.ts"),
      "export type Service=unknown;",
    );
    await writeFile(
      path.join(project, "src/domain/rule.ts"),
      "// first\nimport type { Service } from '../service.js';\nexport const x=1;",
    );
    const mutations = [
      {
        name: "omitted-layer-stack-is-validated-before-default",
        file: `${base}rules/input.rs`,
        before:
          'let layers = match get(object, "layers") {\n        None => Vec::new(),',
        after:
          'let layers = match get(object, "layers") {\n        None => return Err(minimum(&field(&[], "layers"), "array", 2)),',
        item: item("default-stack-is-empty", "schema", {
          schema: "rules",
          value: {},
        }),
        beforeCheck: (answer) => assert.equal(answer.output.valid, true),
        afterCheck: (answer) => {
          assert.equal(answer.output.valid, false);
          assert.deepEqual(answer.output.issue.path, ["layers"]);
        },
      },
      {
        name: "zero-sites-admitted",
        file: `${base}rules/input.rs`,
        before: "if *number <= 0.0 {",
        after: "if *number < 0.0 {",
        item: item("zero-sites-refused", "sites_schema", { sites: 0 }),
        beforeCheck: (answer) => assert.equal(answer.output.valid, false),
        afterCheck: (answer) => {
          assert.equal(answer.output.valid, true);
          assert.equal(answer.output.data.sites, 0);
        },
      },
      {
        name: "specificity-counts-utf16-units",
        file: `${base}classify.rs`,
        before:
          "literal_chars: char::decode_utf16(pattern.units().iter().copied())\n                    .filter(|character| !matches!(character, Ok('*' | '/')))\n                    .count(),",
        after:
          "literal_chars: pattern.units().iter().filter(|unit| !matches!(**unit, 42 | 47)).count(),",
        item: item("astral-literal-is-one-character", "classify", {
          layers: [
            { name: "emoji", paths: ["**/*😀.ts"] },
            { name: "ascii", paths: ["**/x*.ts"] },
          ],
          files: ["x😀.ts"],
        }),
        beforeCheck: (answer) =>
          assert.equal(answer.output[0].thrown.file, "x😀.ts"),
        afterCheck: (answer) =>
          assert.deepEqual(answer.output, [{ name: "emoji", rank: 0 }]),
      },
      {
        name: "same-layer-pattern-tie-refused",
        file: `${base}classify.rs`,
        before: "winner.layer.rank != rival.layer.rank",
        after: "winner.layer.rank == rival.layer.rank",
        item: item("same-layer-overlap-is-allowed", "classify", {
          layers: [
            {
              name: "plumbing",
              paths: ["**/*-plumbing.ts", "**/billing-p*.ts"],
            },
          ],
          files: ["src/billing-plumbing.ts"],
        }),
        beforeCheck: (answer) =>
          assert.deepEqual(answer.output, [{ name: "plumbing", rank: 0 }]),
        afterCheck: (answer) =>
          assert.equal(answer.output[0].thrown.file, "src/billing-plumbing.ts"),
      },
      {
        name: "upward-type-only-marker-lost",
        file: `${base}analyze.rs`,
        before: "type_only: literal.type_only,",
        after: "type_only: false,",
        item: item("type-only-upward-site", "analyze", {
          root: project,
          repoRoot: project,
          rules: {
            layers: [
              { name: "service", paths: ["src"] },
              { name: "domain", paths: ["src/domain"] },
            ],
          },
        }),
        beforeCheck: (answer) =>
          assert.equal(answer.output.violations[0].typeOnly, true),
        afterCheck: (answer) =>
          assert.equal(answer.output.violations[0].typeOnly, false),
      },
      {
        name: "shrinking-pair-count-is-accepted",
        file: `${base}reconcile.rs`,
        before: "if entry.sites != edges.len() as u64 {",
        after: "if entry.sites < edges.len() as u64 {",
        item: item("a-removed-site-is-still-progress", "reconcile", {
          report: report([edge("a", "target")]),
          allowed: [allowed("a", "target", 2)],
        }),
        beforeCheck: (answer) => {
          assert.equal(answer.output.passed, false);
          assert.equal(answer.output.miscounted[0].actual, 1);
        },
        afterCheck: (answer) => {
          assert.equal(answer.output.passed, true);
          assert.equal(answer.output.allowedSites, 1);
        },
      },
      {
        name: "first-duplicate-allowance-wins",
        file: `${base}reconcile.rs`,
        before: "let declared: IndexMap<_, _> = allowed\n        .iter()",
        after: "let declared: IndexMap<_, _> = allowed\n        .iter().rev()",
        item: item("last-duplicate-declaration-owns-count", "reconcile", {
          report: report([edge("a", "target", 1), edge("a", "target", 2)]),
          allowed: [
            allowed("a", "target", 1, "first"),
            allowed("a", "target", 2, "last"),
          ],
        }),
        beforeCheck: (answer) => assert.equal(answer.output.passed, true),
        afterCheck: (answer) => {
          assert.equal(answer.output.passed, false);
          assert.equal(answer.output.miscounted[0].declared.reason, "first");
        },
      },
      {
        name: "space-pair-key-is-redefined",
        file: `${base}reconcile.rs`,
        before: 'out.push_str(" ");',
        after: 'out.push_str("::");',
        item: item("source-space-key-collision-is-retained", "reconcile", {
          report: report([edge("a b", "c", 1), edge("a", "b c", 2)]),
          allowed: [allowed("a", "b c", 2)],
        }),
        beforeCheck: (answer) => assert.equal(answer.output.passed, true),
        afterCheck: (answer) => {
          assert.equal(answer.output.passed, false);
          assert.equal(answer.output.undeclared[0].from, "a b");
          assert.equal(answer.output.miscounted.length, 1);
        },
      },
    ];

    for (const mutation of mutations) {
      const expected = reference(mutation.item),
        original = call(baseline, mutation.item);
      assert.deepEqual(original.output, expected, mutation.name);
      mutation.beforeCheck(original);
      const file = path.join(workspace, mutation.file),
        source = await readFile(file, "utf8");
      assert.equal(
        source.split(mutation.before).length,
        2,
        `${mutation.name}: exactly one owner edit`,
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
          "layer_driver",
        ],
        {
          cwd: workspace,
          env: { ...process.env },
          stdio: "pipe",
          maxBuffer: 16 * 1024 * 1024,
        },
      );
      const changed = call(
        path.join(targetDirectory, "debug/examples/layer_driver"),
        mutation.item,
      );
      assert.notDeepEqual(changed.output, original.output, mutation.name);
      mutation.afterCheck(changed);
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
        parser: "OXC0.151.0",
        resolver: "OXC11.24.2",
        profile:
          "successful actual source/baseline/disposable compiled native calls; independent intended-output assertions",
      },
      controls,
    };
    if (process.argv[3])
      await writeFile(
        process.argv[3],
        `${JSON.stringify(evidence, null, 2)}\n`,
      );
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
  }
} catch (error) {
  mutationFailure = error;
  throw error;
} finally {
  mutationCheck.remove(mutationFailure);
}
