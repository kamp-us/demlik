import { Command } from "commander";

export type Opts = {
  pretty?: boolean;
  json?: boolean;
  graph?: boolean;
  plan?: boolean;
  smells?: boolean;
  tree?: boolean;
  by?: string;
  file?: string;
  edges?: boolean;
  deep?: boolean;
  blast?: string;
  html?: boolean;
  ci?: boolean;
  failOn?: string;
  max?: string;
  thresholds?: string;
  out?: string;
  crossRuntime?: boolean;
  kinds?: boolean;
  unreachable?: boolean;
  unguarded?: boolean;
  clusters?: boolean;
  interfaceWidth?: boolean;
  nodeKinds?: string;
  layers?: boolean;
  layerRules?: string;
  boundaries?: boolean;
  boundaryRules?: string;
  collapse?: boolean;
  collapseConfig?: string;
  hotspots?: boolean;
  hotspotsDays?: string;
  hotspotsSince?: string;
  hotspotsLimit?: string;
  cycles?: boolean;
  envKeys?: boolean;
  comments?: boolean;
  writeCeilings?: boolean;
};

export function cleanExit(message: string): void {
  process.stderr.write(`code-graph: ${message}\n`);
  process.exitCode = 2;
}

function graphOptions(command: Command): Command {
  return command
    .option("--graph", "emit the full Graph JSON (the large dump)")
    .option("--plan", "emit ranked refactor targets (human table; --json for PlanRow[])")
    .option("--by <axis>", "plan ranking axis: rot | impact | complexity | size", "rot")
    .option("--smells", "emit all smells grouped by kind (human; --json for Smell[])")
    .option("--tree", "emit an indented file → function tree with inline smell markers")
    .option("--file <f>", "emit one module + its functions")
    .option("--edges", "run the opt-in edge pass (calls/calledBy/importedBy/chain + edge smells)")
    .option("--deep", "edge pass over the whole monorepo (cross-package callers; implies --edges)")
    .option("--blast <id>", "callers of <id> (direct + transitive); requires the edge pass")
    .option("--html", "emit a self-contained HTML report (human view); implies the edge pass")
    .option("--ci", "CI gate: exit non-zero per --fail-on / --max policy")
    .option("--fail-on <level>", "CI severity to fail on: high | warn", "high")
    .option("--max <n>", "CI: fail if total smell count exceeds <n>")
    .option("--thresholds <file>", "JSON file of partial threshold overrides merged over defaults");
}

function analysisOptions(command: Command): Command {
  return command
    .option(
      "--cross-runtime",
      "resolve env.<BINDING>.<method>() to the target worker (implies edges)",
    )
    .option("--kinds", "classify each node entry|effect|auth|plain (implies --cross-runtime)")
    .option("--unreachable", "exported symbols with no path from any entry (implies --kinds)")
    .option("--unguarded", "effect nodes reachable from an entry with no auth on the path")
    .option(
      "--clusters",
      "communities vs directories: where the layout lies (implies --cross-runtime)",
    )
    .option(
      "--interface-width",
      "exports per package + external (outside-package) consumer counts; implies the edge pass",
    )
    .option("--cycles", "module-import cycles, reported as participating files (implies --edges)")
    .option("--node-kinds <file>", "JSON file of node-kind rule overrides merged over defaults");
}

function featureOptions(command: Command): Command {
  return command
    .option("--layers", "layer gate: every import edge pointing UP the declared layer stack")
    .option(
      "--layer-rules <file>",
      "JSON file declaring the layer stack and allowlist (required by --layers)",
    )
    .option(
      "--boundaries",
      "feature boundaries: cross-feature imports not through <feature>/index.ts, rules/ importing beyond itself and contracts, lib/ importing a feature (gateable via --ci)",
    )
    .option(
      "--boundary-rules <file>",
      "JSON file of boundary-declaration overrides (features per scope, lib, contracts) merged over defaults",
    )
    .option(
      "--collapse",
      "collapse candidates (a report) + partial twins: a shared decision prologue over the same named constants, diverging afterwards (gateable via --ci). Implies --kinds",
    )
    .option(
      "--collapse-config <file>",
      "JSON file of collapse-setting overrides merged over defaults",
    )
    .option("--hotspots", "churn x complexity hotspots (git log joined with complexity)")
    .option("--hotspots-days <n>", "hotspots window in days", "90")
    .option("--hotspots-since <iso>", "window start ISO date (overrides --hotspots-days)")
    .option("--hotspots-limit <n>", "hotspots top-N (--json emits all rows)", "20")
    .option(
      "--env-keys",
      "env-var keys declared (wrangler vars/secrets, .dev.vars) but never read, and vice versa",
    )
    .option(
      "--comments",
      "comment census: comment lines per bucket and class (mechanical / protected / prose), by scope and by file",
    )
    .option(
      "--write-ceilings",
      "with --comments: rewrite comment-ceilings.json; with --collapse: record this scope's partial-twin count in collapse-ceilings.json; with --boundaries: record each declared scope's violation count in boundary-ceilings.json",
    );
}

function outputOptions(command: Command): Command {
  return command
    .option("--pretty", "pretty-print JSON output")
    .option("--json", "force JSON output on a view command")
    .option(
      "--out <file>",
      "write the view output to <file> directly (banner-safe); default is stdout",
    );
}

export function defineProgram(): Command {
  const command = new Command()
    .name("code-graph")
    .description("Agent-native TypeScript code-graph tool (SPEC.md)")
    .argument("<path>", "folder to analyze");
  return outputOptions(featureOptions(analysisOptions(graphOptions(command))));
}
