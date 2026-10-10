import { Command } from "commander";
import { entryExportPresetNames } from "./kinds/presets.js";

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
  headers?: boolean;
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
  entryPreset?: string[];
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
  data?: boolean;
  comments?: boolean;
  writeCeilings?: boolean;
  acceptCrossings?: boolean;
  reason?: string;
  migrateCeilings?: boolean;
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
    .option(
      "--headers",
      "give each function node a `header`: its declaration header as written, from where its startLine places it (export and modifiers included) to the last token before its body (an arrow's ends on =>), no leading comment, plus its overload signatures with their start lines (overloads are never nodes); absent without the flag",
    )
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
    .option(
      "--data",
      "data edges: which function reads or writes which D1 / Durable Object / KV / R2 / queue binding",
    )
    .option("--cycles", "module-import cycles, reported as participating files (implies --edges)")
    .option("--node-kinds <file>", "JSON file of node-kind rule overrides merged over defaults")
    .option(
      "--entry-preset <name>",
      `turn on a built-in entrypoint-export preset (${entryExportPresetNames().join(" | ")}) even where the package does not depend on its framework; repeatable`,
      (name: string, previous: string[]) => [...previous, name],
      [] as string[],
    );
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
      "feature boundaries: cross-feature imports not through <feature>/index.ts (B1), rules/ importing beyond itself and contracts or using a world door by name such as any process.<member> (process.env, process.hrtime, process.platform, …), fetch or the clock (B2), lib/ importing a feature (B3), a file in no feature importing a feature's internals (B4), a declared world door used outside its owner files (B5, from the doors key of --boundary-rules; a type-only import of node:fs or node:child_process opens no door); a scope that declares features in --boundary-rules (unless its layout key sets it to rules) lays its features out as index.ts, ports.ts, application/, adapters/driving/ and adapters/driven/ instead of rules/, and adds application/ importing its own adapters/ (B6 application-imports-adapter), any world door used or opened in application/ (B7 impure-application), adapters/driving/ importing its own application/ or adapters/driven/ (B8 driving-reaches-driven), a world door used in index.ts, ports.ts or adapters/driving/ (B9 door-outside-driven-adapter) and a feature entry no zone names (B10 unknown-zone); libraries the rules file declares (libraryTypes, libraries, libraryRoots, worldLibraries of --boundary-rules) are judged between packages: a package under a library root no library names (B11 library-undeclared), a library importing a library whose type its own type does not list (B12 library-imports-up), a pure library using a world door or importing a world library (B13 impure-library) and a library imported from outside the zones its type names (B14 adapter-library-imported-outside-driven), with a census of the libraries; the shape of a hexagonal feature's own files, for the kinds the applicationShape key lists and none run until listed: an entry file (a library's src/index.ts, a feature's index.ts) that holds more than named re-exports (B15 index-not-exports-only) and an application/ import outside its allowlist of its own ports.ts and application/, another feature's index.ts, lib, a library whose type applicationMayImport lists and a pureDependencies package (B16 application-import-outside-allowlist), where testFiles, matched against a file's scope-relative and its repo-relative path, takes a test file out of the zones (B6-B10, B13, B15, B16 and B17 stop judging it), readAllowance lets a driving adapter import a listed driven file that holds no data write beside a library of a decidedBy type, or with no such import when the entry leaves decidedBy out (B8); across deployables, the kinds the acrossDeployables key of --boundary-rules lists are judged, and none run until listed: a worker binding its owning worker declares used outside a hexagonal feature's adapters/driven/ and outside that worker's wrangler main, which wires its own bindings (B17 binding-outside-driven-adapter), workers that bind each other in a loop (B18 worker-call-cycle, scope \".\", measured only by a run at the repo root) and a relative import into another workspace (B19 relative-import-crosses-workspace), with a census of the worker bindings read (gateable via --ci against boundary-ledger.json: fails on a crossing the ledger does not name, prunes entries whose crossing is gone)",
    )
    .option(
      "--accept-crossings",
      'with --boundaries: add every crossing boundary-ledger.json does not name yet, each carrying --reason "<why>" (required)',
    )
    .option("--reason <text>", "with --boundaries --accept-crossings: why these crossings stay")
    .option(
      "--migrate-ceilings",
      "with --boundaries: seed boundary-ledger.json from today's crossings (world-door uses, library crossings B11-B14, shape crossings B15-B16 and deployable crossings B17-B19 included) and delete boundary-ceilings.json; refuses if any scope's import crossings exceed its recorded count (library, shape and deployable crossings are not counted)",
    )
    .option(
      "--boundary-rules <file>",
      'JSON file of boundary-declaration overrides (features per scope, lib, contracts, doors: per scope, each world door and the scope-relative files that may open it, and layout: per scope, "rules" to keep the rules/ layout, a scope that declares features being hexagonal otherwise; libraryTypes: each library type, the types it imports, whether it is pure and where it may be imported from; libraries: package directory to type; libraryRoots: directories whose every package must be declared; worldLibraries: package globs a pure library may not import; acrossDeployables: the deployable rules to run, any of binding-outside-driven-adapter, worker-call-cycle and relative-import-crosses-workspace, none by default; bindingOwners: per scope, each worker binding and the scope-relative driven-adapter files that may use it, besides the main of the worker; applicationShape: the shape rules to run, any of index-not-exports-only and application-import-outside-allowlist, none by default; applicationMayImport: library types an application/ file may import, none by default; pureDependencies: package globs an application/ file may import; testFiles: globs of test files, each matched against the scope-relative and the repo-relative path of a file, which sit in no zone; readAllowance: per scope, driven files a driving adapter may import and, optionally, the decidedBy library types that make it so; left out, a listed file that only reads is licensed for any driving file) merged over defaults',
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
      "with --comments: rewrite comment-ceilings.json; with --collapse: record this scope's partial-twin count in collapse-ceilings.json. Not for --boundaries, whose crossings live one per entry in boundary-ledger.json: use --accept-crossings --reason, or --migrate-ceilings once from boundary-ceilings.json",
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
