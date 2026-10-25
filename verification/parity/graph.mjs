import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const require = createRequire(import.meta.url);
const suites = [
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
      ...[...new Set(suites.map(({ driver }) => driver))].flatMap((driver) => [
        "--example",
        driver,
      ]),
    ],
    { cwd: root, stdio: "inherit" },
  );
  const directory = path.join(root, "target/parity");
  await mkdir(directory, { recursive: true });
  const results = [];
  const nativeEvidence = {};
  const transportProbes = {};
  for (const suite of suites) {
    const binary = path.join(root, "target/debug/examples", suite.driver);
    if (checkedUtf8.has(suite.driver) && !transportProbes[suite.driver]) {
      const invalid = spawnSync(binary, [], {
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
    const passing = report.cases.slice(0, report.passed);
    assert.equal(
      passing.length,
      report.passed,
      `${suite.name}: incomplete passing evidence`,
    );
    assert.equal(
      report.cases.length,
      report.passed + report.rejectedInvalidInputs,
    );
    for (const answer of passing) {
      assert.ok(
        answer.observedCalls.length > 0,
        `${suite.name}: no native behavior was exercised`,
      );
      const id = `graph.${suite.name}.${answer.id}`;
      assert.ok(!Object.hasOwn(nativeEvidence, id), `duplicate case ${id}`);
      nativeEvidence[id] = answer.observedCalls;
    }
    results.push({
      name: suite.name,
      passed: report.passed,
      rejectedInvalidInputs: report.rejectedInvalidInputs,
      reference: report.reference,
      steps: report.steps,
      queries: report.queries,
      functions: report.functions,
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
  };
}
