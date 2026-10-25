import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const require = createRequire(import.meta.url);
const suites = [
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

export async function graphParity(cargo) {
  execFileSync(
    cargo,
    [
      "build",
      "--locked",
      "--package",
      "demlik-code-graph",
      ...suites.flatMap(({ driver }) => ["--example", driver]),
    ],
    { cwd: root, stdio: "inherit" },
  );
  const directory = path.join(root, "target/parity");
  await mkdir(directory, { recursive: true });
  const results = [];
  const nativeEvidence = {};
  for (const suite of suites) {
    const binary = path.join(root, "target/debug/examples", suite.driver);
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
    nativeEvidence,
  };
}
