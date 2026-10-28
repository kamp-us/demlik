import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const require = createRequire(import.meta.url);
const nativeCompilerManifest = require.resolve(
  "@typescript/native-preview/package.json",
  { paths: [path.join(root, "packages/code-graph")] },
);
const suites = [
  {
    name: "smell-ledger",
    driver: "smell_ledger_driver",
    script: "graph-smell-ledger-run.mjs",
    args: [nativeCompilerManifest],
    format: "process",
    traceField: "nativeTrace",
  },
  {
    name: "icu77-smell",
    driver: "smell_ledger_driver",
    script: "icu77-smell-run.mjs",
    args: [nativeCompilerManifest],
    format: "process",
    traceField: "nativeTrace",
  },
  {
    name: "unreachable-ledger",
    driver: "unreachable_driver",
    script: "graph-unreachable-ledger-run.mjs",
    args: [nativeCompilerManifest],
    format: "process",
    traceField: "nativeTrace",
  },
  {
    name: "unreachable-render",
    driver: "unreachable_driver",
    script: "graph-unreachable-render-run.mjs",
    args: [nativeCompilerManifest],
    format: "process",
    traceField: "nativeTrace",
  },
  {
    name: "logical-root",
    driver: "graph_root_driver",
    script: "graph-logical-root.mjs",
    format: "process",
    traceField: "native",
  },
  {
    name: "assembly-warning",
    driver: "demlik_code_graph",
    unitTest: true,
    script: "graph-assembly-warning.mjs",
    format: "process",
    traceField: "nativeTrace",
  },
  {
    name: "collapse-report",
    driver: "collapse_report_driver",
    script: "graph-collapse-report.mjs",
    format: "process",
    traceField: "nativeTrace",
    evidenceField: "observedCalls",
  },
  {
    name: "collapse-render",
    driver: "collapse_render_driver",
    script: "graph-collapse-render-run.mjs",
    format: "process",
    traceField: "nativeTrace",
  },
  {
    name: "collapse-partial",
    driver: "collapse_partial_driver",
    script: "graph-collapse-partial.mjs",
    format: "process",
    traceField: "native",
  },
  {
    name: "text-interface",
    driver: "text_assembly_driver",
    script: "graph-text-interface.mjs",
    format: "process",
    traceField: "native",
  },
  {
    name: "hexagon",
    driver: "hexagon_driver",
    script: "graph-hexagon.mts",
    format: "process",
  },
  {
    name: "cli-config",
    driver: "cli_config_driver",
    script: "graph-cli-config.mts",
  },
  {
    name: "cli-frontdoor",
    driver: "cli_frontdoor_driver",
    script: "graph-cli-frontdoor.mts",
    format: "process",
  },
  {
    name: "cli-ledger-preflight",
    driver: "gate_preflight_driver",
    script: "graph-cli-ledger-preflight.mts",
    format: "process",
  },
  {
    name: "cli-layers",
    driver: "layer_cli_driver",
    script: "graph-cli-layers.mjs",
    format: "process",
    traceField: "nativeTrace",
    evidenceField: "observedCalls",
  },
  {
    name: "cli-boundaries",
    driver: "boundary_cli_driver",
    script: "graph-cli-boundaries.mjs",
    format: "process",
    traceField: "nativeTrace",
    evidenceField: "observedCalls",
  },
  {
    name: "cli-env-keys",
    driver: "env_keys_cli_driver",
    script: "graph-cli-env-keys.mjs",
    format: "process",
    traceField: "nativeTrace",
    evidenceField: "observedCalls",
  },
  {
    name: "cli-comments",
    driver: "comment_cli_driver",
    script: "graph-cli-comments.mjs",
    format: "process",
    traceField: "nativeTrace",
    evidenceField: "observedCalls",
  },
  {
    name: "cli-collapse",
    driver: "collapse_cli_driver",
    script: "graph-cli-collapse.mjs",
    format: "process",
    traceField: "nativeTrace",
    evidenceField: "observedCalls",
  },
  {
    name: "cli-unreachable",
    driver: "collapse_cli_driver",
    script: "graph-cli-unreachable-run.mjs",
    format: "process",
    traceField: "nativeTrace",
    evidenceField: "observedCalls",
  },
  {
    name: "cli-reports",
    driver: "collapse_cli_driver",
    script: "graph-cli-reports-run.mjs",
    format: "process",
    traceField: "nativeTrace",
    evidenceField: "observedCalls",
  },
  {
    name: "html",
    driver: "html_driver",
    script: "graph-html-run.mjs",
    format: "process",
    traceField: "nativeTrace",
    evidenceField: "observedCalls",
  },
  {
    name: "cli-html",
    driver: "collapse_cli_driver",
    script: "graph-cli-html-run.mjs",
    format: "process",
    traceField: "nativeTrace",
    evidenceField: "observedCalls",
  },
  {
    name: "cli-smell",
    driver: "collapse_cli_driver",
    script: "graph-cli-smell-run.mjs",
    format: "process",
    traceField: "nativeTrace",
    evidenceField: "observedCalls",
  },
  {
    name: "cli-tree-blast-find",
    driver: "collapse_cli_driver",
    script: "graph-cli-tree-blast-find-run.mjs",
    format: "process",
    traceField: "nativeTrace",
    evidenceField: "observedCalls",
  },
  {
    name: "icu77-persisted-gates",
    driver: "ledger_driver",
    script: "icu77-persisted-gates-run.mjs",
    format: "process",
    traceField: "nativeTrace",
  },
  {
    name: "icu77-collapse",
    driver: "collapse_report_driver",
    script: "icu77-collapse-run.mjs",
    format: "process",
    traceField: "nativeTrace",
    evidenceField: "observedCalls",
  },
  {
    name: "icu77-import-metadata",
    driver: "icu77_metadata_driver",
    script: "icu77-import-metadata-run.mjs",
    args: [nativeCompilerManifest],
    format: "process",
    traceField: "nativeTrace",
    evidenceField: "observedCalls",
  },
  {
    name: "icu77-callable-graph",
    driver: "icu77_callable_driver",
    script: "icu77-callable-graph-run.mjs",
    args: [nativeCompilerManifest],
    format: "process",
    traceField: "nativeTrace",
    evidenceField: "observedCalls",
  },
  {
    name: "icu77-query-groups",
    driver: "icu77_query_driver",
    script: "icu77-query-groups-run.mjs",
    args: [nativeCompilerManifest],
    format: "process",
    traceField: "nativeTrace",
    evidenceField: "observedCalls",
  },
  {
    name: "icu77-reachability",
    driver: "icu77_reach_driver",
    script: "icu77-reachability-run.mjs",
    args: [nativeCompilerManifest],
    format: "process",
    traceField: "nativeTrace",
    evidenceField: "observedCalls",
  },
  {
    name: "icu77-graph-pipeline",
    driver: "icu77_graph_pipeline_driver",
    script: "icu77-graph-pipeline-run.mjs",
    args: [nativeCompilerManifest],
    format: "process",
    traceField: "nativeTrace",
    evidenceField: "observedCalls",
  },
  {
    name: "icu77-module-coupling",
    driver: "icu77_coupling_driver",
    script: "icu77-module-coupling-run.mjs",
    args: [nativeCompilerManifest],
    format: "process",
    traceField: "nativeTrace",
    evidenceField: "observedCalls",
  },
  {
    name: "icu77-boundary-judgments",
    driver: "icu77_boundary_driver",
    script: "icu77-boundary-judgments-run.mjs",
    args: [],
    format: "process",
    traceField: "nativeTrace",
    evidenceField: "observedCalls",
  },
  {
    name: "icu77-census",
    driver: "icu77_census_probe_driver",
    script: "icu77-census-run.mjs",
    args: [root],
    format: "process",
    traceField: "nativeTrace",
    evidenceField: "observedCalls",
  },
  {
    name: "cli-plain-collapse",
    driver: "collapse_cli_driver",
    script: "graph-cli-plain-collapse-run.mjs",
    format: "process",
    traceField: "nativeTrace",
    evidenceField: "observedCalls",
  },
  {
    name: "cli-parser",
    driver: "cli_parser_driver",
    script: "graph-cli-parser.mts",
  },
  {
    name: "api-view",
    driver: "api_view_driver",
    script: "graph-api-view.mts",
    args: [nativeCompilerManifest],
  },
  {
    name: "api-raw-file",
    driver: "api_view_driver",
    script: "graph-api-raw-file.mts",
    args: [nativeCompilerManifest],
  },
  {
    name: "api-foundation",
    driver: "api_foundation_driver",
    script: "graph-api-foundation.mts",
  },
  {
    name: "boundary-gate",
    driver: "boundary_gate_driver",
    script: "graph-boundary-gate.mts",
  },
  {
    name: "scope-count",
    driver: "scope_count_driver",
    script: "graph-scope-count.mts",
  },
  {
    name: "boundary-render",
    driver: "boundary_render_driver",
    script: "graph-boundary-render.mts",
  },
  {
    name: "shape-judgments",
    driver: "shape_judgment_driver",
    script: "graph-shape-judgments.mts",
  },
  {
    name: "boundary-analysis",
    driver: "boundary_analyze_driver",
    script: "graph-boundary-analysis.mts",
  },
  {
    name: "scoped-reads",
    driver: "scoped_reads_driver",
    script: "graph-scoped-reads.mts",
  },
  {
    name: "test-reach",
    driver: "boundary_domain_driver",
    script: "graph-test-reach.mts",
  },
  {
    name: "layer-gate",
    driver: "layer_gate_driver",
    script: "graph-layer-gate.mts",
  },
  {
    name: "layers",
    driver: "layer_driver",
    script: "graph-layers.mts",
  },
  {
    name: "shape-entry",
    driver: "boundary_domain_driver",
    script: "graph-shape-entry.mts",
  },
  {
    name: "layer-targets",
    driver: "layer_target_driver",
    script: "graph-layer-targets.mts",
  },
  {
    name: "deployable-judgments",
    driver: "deployables_driver",
    script: "graph-deployable-judgments.mts",
  },
  {
    name: "comment-gate",
    driver: "comment_gate_driver",
    script: "graph-comment-gate.mts",
  },
  {
    name: "deployable-paths",
    driver: "deployables_driver",
    script: "graph-deployable-paths.mts",
  },
  {
    name: "comment-policy",
    driver: "comment_policy_driver",
    script: "graph-comment-policy.mts",
  },
  {
    name: "library-judgments",
    driver: "libraries_driver",
    script: "graph-library-judgments.mts",
  },
  {
    name: "libraries",
    driver: "libraries_driver",
    script: "graph-libraries.mts",
  },
  { name: "comments", driver: "comment_driver", script: "graph-comments.mts" },
  {
    name: "data-assembly",
    driver: "data_driver",
    script: "graph-data-assembly.mts",
  },
  { name: "data", driver: "data_driver", script: "graph-data.mts" },
  {
    name: "data-sites",
    driver: "data_driver",
    script: "graph-data-sites.mts",
  },
  {
    name: "boundary-zones",
    driver: "boundary_domain_driver",
    script: "graph-boundary-zones.mts",
  },
  { name: "analysis", driver: "analysis_driver", script: "graph-analysis.mts" },
  {
    name: "impure-uses",
    driver: "boundary_domain_driver",
    script: "graph-impure-uses.mts",
  },
  {
    name: "boundary-domain",
    driver: "boundary_domain_driver",
    script: "graph-boundary-domain.mts",
  },
  {
    name: "cross-runtime",
    driver: "cross_runtime_driver",
    script: "graph-cross-runtime.mts",
  },
  { name: "catalog", driver: "catalog_driver", script: "graph-catalog.mts" },
  {
    name: "boundary-config",
    driver: "boundary_config_driver",
    script: "graph-boundary-config.mts",
  },
  { name: "zoning", driver: "zoning_driver", script: "graph-zoning.mts" },
  { name: "kinds", driver: "kinds_driver", script: "graph-kinds.mts" },
  { name: "json", driver: "json_driver", script: "graph-json.mts" },
  { name: "query", driver: "query_driver", script: "graph-query.mts" },
  {
    name: "reconcile",
    driver: "reconcile_driver",
    script: "graph-reconcile.mts",
  },
  { name: "edges", driver: "edges_driver", script: "graph-edges.mts" },
  { name: "ledger", driver: "ledger_driver", script: "graph-ledger.mts" },
  { name: "project", driver: "project_driver", script: "graph-project.mts" },
  { name: "semantic", driver: "semantic_driver", script: "graph-semantic.mts" },
  { name: "syntax", driver: "syntax_driver", script: "graph-syntax.mts" },
  {
    name: "structure",
    driver: "structure_driver",
    script: "graph-structure.mts",
  },
];
const checkedUtf8 = new Set([
  "smell_ledger_driver",
  "unreachable_driver",
  "collapse_render_driver",
  "collapse_report_driver",
  "collapse_cli_driver",
  "html_driver",
  "graph_root_driver",
  "icu77_metadata_driver",
  "icu77_callable_driver",
  "icu77_query_driver",
  "icu77_reach_driver",
  "icu77_graph_pipeline_driver",
  "icu77_coupling_driver",
  "icu77_boundary_driver",
  "icu77_census_probe_driver",
  "collapse_partial_driver",
  "layer_cli_driver",
  "gate_preflight_driver",
  "hexagon_driver",
  "cli_config_driver",
  "cli_frontdoor_driver",
  "cli_parser_driver",
  "api_view_driver",
  "api_foundation_driver",
  "boundary_gate_driver",
  "scope_count_driver",
  "boundary_render_driver",
  "shape_judgment_driver",
  "boundary_analyze_driver",
  "scoped_reads_driver",
  "layer_gate_driver",
  "layer_driver",
  "layer_target_driver",
  "comment_gate_driver",
  "deployables_driver",
  "comment_driver",
  "comment_policy_driver",
  "libraries_driver",
  "boundary_config_driver",
  "boundary_domain_driver",
  "zoning_driver",
  "reconcile_driver",
]);

export async function graphParity(cargo) {
  execFileSync(
    cargo,
    [
      "build",
      "--locked",
      "--package",
      "demlik-code-graph",
      ...[
        ...new Set(
          suites.filter((suite) => !suite.unitTest).map(({ driver }) => driver),
        ),
      ].flatMap((driver) => ["--example", driver]),
    ],
    { cwd: root, stdio: "inherit" },
  );
  const directory = path.join(root, "target/parity");
  await mkdir(directory, { recursive: true });
  const results = [];
  const nativeEvidence = {};
  const qualifiedNativeEvidence = {};
  const transportProbes = {};
  for (const suite of suites) {
    let binary = path.join(root, "target/debug/examples", suite.driver);
    if (suite.unitTest) {
      const artifacts = execFileSync(
        cargo,
        [
          "test",
          "--locked",
          "--package",
          "demlik-code-graph",
          "--lib",
          "--no-run",
          "--message-format=json",
        ],
        { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
      );
      await writeFile(
        path.join(directory, `graph-${suite.name}.cargo.jsonl`),
        artifacts,
      );
      const selected = artifacts
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .filter(
          (event) =>
            event.reason === "compiler-artifact" &&
            event.target.name === suite.driver &&
            event.profile.test &&
            event.executable,
        );
      assert.equal(
        selected.length,
        1,
        `${suite.name}: actual Cargo test artifact`,
      );
      binary = selected[0].executable;
      assert.ok(binary.startsWith(path.join(root, "target/")));
    }
    if (checkedUtf8.has(suite.driver) && !transportProbes[suite.driver]) {
      const invalid = spawnSync(binary, suite.args ?? [], {
        cwd: root,
        input: Buffer.from([0xff, 0x0a]),
        encoding: "utf8",
        timeout: 5_000,
      });
      if (invalid.error) throw invalid.error;
      assert.ok(
        invalid.status !== null && invalid.status !== 0,
        `${suite.driver}: invalid UTF-8 must fail`,
      );
      assert.match(invalid.stderr, /UTF-8/);
      transportProbes[suite.driver] = {
        invalidUtf8Rejected: true,
        exitCode: invalid.status,
        diagnostic: invalid.stderr.trim(),
      };
    }
    const reportFile = path.join(directory, `graph-${suite.name}.json`);
    execFileSync(
      process.execPath,
      [
        "--import",
        require.resolve("tsx"),
        path.join(here, suite.script),
        binary,
        reportFile,
      ],
      { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
    );
    const report = JSON.parse(await readFile(reportFile, "utf8"));
    const passing =
      suite.format === "process"
        ? report.cases.filter(
            (row) =>
              row.valid !== false &&
              row.protocol !== true &&
              row.passed === true,
          )
        : report.cases.slice(0, report.passed);
    assert.equal(
      passing.length,
      report.passed,
      `${suite.name}: incomplete passing evidence`,
    );
    const rejectedInvalidInputRows =
      report.rejectedInvalidInputRows === undefined
        ? report.rejectedInvalidInputs
        : report.rejectedInvalidInputRows;
    assert.ok(
      Number.isSafeInteger(report.rejectedInvalidInputs) &&
        Number.isSafeInteger(rejectedInvalidInputRows) &&
        rejectedInvalidInputRows >= 0 &&
        rejectedInvalidInputRows <= report.rejectedInvalidInputs,
      `${suite.name}: invalid inline protocol row count`,
    );
    assert.equal(report.cases.length, report.passed + rejectedInvalidInputRows);
    if (suite.format === "process") {
      assert.deepEqual(report.failures, []);
      assert.equal(report.attempted, report.passed);
      assert.equal(
        report.unqualifiedPairs + report.qualifiedPairs,
        report.passed,
      );
      assert.equal(
        Object.keys(report.nativeEvidence).length,
        report.unqualifiedPairs,
      );
      assert.equal(
        Object.keys(report.qualifiedNativeEvidence).length,
        report.qualifiedPairs,
      );
    }
    for (const answer of passing) {
      const calls =
        suite.format === "process"
          ? (suite.traceField ? answer[suite.traceField] : answer.native.trace)
              .observedCalls
          : answer.observedCalls;
      assert.ok(
        calls.length > 0,
        `${suite.name}: no native behavior was exercised`,
      );
      const id = `graph.${suite.name}.${answer.id}`;
      assert.ok(
        !Object.hasOwn(nativeEvidence, id) &&
          !Object.hasOwn(qualifiedNativeEvidence, id),
        `duplicate case ${id}`,
      );
      const qualified =
        suite.format === "process"
          ? answer.qualifications.length > 0
          : answer.backendOffsetQualified;
      if (suite.format === "process") {
        const declared = qualified
          ? report.qualifiedNativeEvidence
          : report.nativeEvidence;
        assert.deepEqual(
          suite.evidenceField
            ? declared[answer.id][suite.evidenceField]
            : declared[answer.id],
          calls,
        );
      }
      const evidence = qualified ? qualifiedNativeEvidence : nativeEvidence;
      evidence[id] = calls;
    }
    results.push({
      name: suite.name,
      passed: report.passed,
      rejectedInvalidInputs: report.rejectedInvalidInputs,
      rejectedInvalidInputRows,
      ...(report.responseGuards === undefined
        ? {}
        : { responseGuards: report.responseGuards }),
      reference: report.reference,
      steps: report.steps,
      queries: report.queries,
      functions: report.functions,
      ...(suite.format === "process"
        ? {
            unqualifiedPairs: report.unqualifiedPairs,
            qualifiedPairs: report.qualifiedPairs,
            profiles: report.profiles,
            qualifiedCases: passing.filter(
              (row) => row.qualifications.length > 0,
            ),
          }
        : {}),
      ...(report.declarationCleanupQualification
        ? {
            declarationCleanupQualification:
              report.declarationCleanupQualification,
          }
        : {}),
      ...(report.backendOffsetQualifiedPairs === undefined
        ? {}
        : {
            unqualifiedPairs: report.unqualifiedPairs,
            backendOffsetQualifiedPairs: report.backendOffsetQualifiedPairs,
            backendOffsetQualification: report.comparison,
            backendOffsetCases: passing
              .filter((answer) => answer.backendOffsetQualified)
              .map((answer) => ({
                id: `graph.${suite.name}.${answer.id}`,
                source: answer.expected,
                native: answer.output,
              })),
          }),
      rustBinarySha256: createHash("sha256")
        .update(await readFile(binary))
        .digest("hex"),
      reportFile,
    });
  }
  return {
    passed: results.reduce((sum, suite) => sum + suite.passed, 0),
    rejectedInvalidInputs: results.reduce(
      (sum, suite) => sum + suite.rejectedInvalidInputs,
      0,
    ),
    suites: results,
    transportProbes,
    nativeEvidence,
    qualifiedNativeEvidence,
  };
}
