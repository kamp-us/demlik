#!/usr/bin/env node
// Engine benchmark for @demlik/code-graph. #384 measured ts-morph against oxc and tsgo prototypes;
// since #397 code-graph runs on oxc and tsgo itself, so this measures the production passes and,
// given a baseline, checks their output against the ts-morph engine's. Run by hand, never in CI:
//
//   node packages/code-graph/bench/engines.mjs [target] [--baseline <graph.json>]
//       [--codegraph] [--runs <n>] [--json <file>]
//
// `target` defaults to packages/code-graph. `--baseline` is `code-graph <target> --graph --edges`
// as the ts-morph engine printed it, from a checkout before #397; the parity rows compare against
// it. Every engine runs in its own child process under `/usr/bin/time`, so wall time and peak RSS
// are per engine. See FINDINGS.md for the numbers and their read.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const BENCH_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = path.resolve(BENCH_DIR, "..");
const SRC = (rel) => pathToFileURL(path.join(PACKAGE_DIR, "src", rel)).href;

function findUp(start, name) {
  let dir = start;
  for (;;) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const elapsed = (t0) => Math.round(performance.now() - t0);

function writeResult(out, result) {
  fs.writeFileSync(
    out,
    JSON.stringify({ ...result, selfMaxRssKb: process.resourceUsage().maxRSS }),
  );
}

async function childCheap(target, out) {
  const { loadCheapProject } = await import(SRC("extract/project.ts"));
  const { assembleGraph } = await import(SRC("extract/assemble.ts"));
  const { resolveThresholds } = await import(SRC("config.ts"));
  const thresholds = resolveThresholds(undefined, () => {});
  const t0 = performance.now();
  const loaded = loadCheapProject(target);
  const loadMs = elapsed(t0);
  const graph = assembleGraph(loaded, thresholds);
  writeResult(out, {
    workMs: elapsed(t0),
    phases: { loadMs, assembleMs: elapsed(t0) - loadMs },
    files: graph.modules.length,
    functions: graph.functions.length,
  });
}

async function childEdge(target, out) {
  const { loadEdgeProject, findRepoRoot } = await import(SRC("extract/project.ts"));
  const { assembleGraphWithEdges } = await import(SRC("extract/assemble.ts"));
  const { buildClusterReport } = await import(SRC("query/clusters.ts"));
  const { resolveThresholds } = await import(SRC("config.ts"));
  const thresholds = resolveThresholds(undefined, () => {});
  const t0 = performance.now();
  let loaded;
  try {
    loaded = loadEdgeProject(target, "package", findRepoRoot(target));
  } catch (error) {
    writeResult(out, { error: error instanceof Error ? error.message : String(error) });
    return;
  }
  const loadMs = elapsed(t0);
  const graph = assembleGraphWithEdges(loaded, thresholds, "package", loaded.tsConfigPath);
  const assembleMs = elapsed(t0) - loadMs;
  const t1 = performance.now();
  buildClusterReport(graph.functions, graph.modules);
  writeResult(out, {
    workMs: elapsed(t0),
    phases: { loadMs, assembleMs, clustersMs: elapsed(t1) },
    files: graph.modules.length,
    functions: graph.functions.length,
    graph,
  });
}

// The floor every node child stands on: node + the tsx loader + the src modules the edge child
// imports, doing no work.
async function childFloor(_target, out) {
  await import(SRC("extract/project.ts"));
  await import(SRC("extract/assemble.ts"));
  await import(SRC("query/clusters.ts"));
  writeResult(out, { workMs: 0 });
}

async function runChild(argv) {
  const [engine, target, out] = argv;
  if (engine === "floor") return childFloor(target, out);
  if (engine === "cheap") return childCheap(target, out);
  if (engine === "edge") return childEdge(target, out);
  throw new Error(`unknown engine ${engine}`);
}

// Peak RSS of a child and everything it waited for, from the OS: BSD `time -l` prints bytes,
// GNU `time -v` prints kilobytes. Absent `/usr/bin/time`, node children still self-report.
function timeFlavour() {
  if (!fs.existsSync("/usr/bin/time")) return null;
  const probe = spawnSync("/usr/bin/time", ["-l", "true"], { encoding: "utf8" });
  if (probe.status === 0 && /maximum resident set size/.test(probe.stderr)) return "bsd";
  const gnu = spawnSync("/usr/bin/time", ["-v", "true"], { encoding: "utf8" });
  if (gnu.status === 0 && /Maximum resident set size/.test(gnu.stderr)) return "gnu";
  return null;
}

function peakKbFrom(flavour, stderr) {
  if (flavour === "bsd") {
    const m = /(\d+)\s+maximum resident set size/.exec(stderr);
    return m ? Math.round(Number(m[1]) / 1024) : null;
  }
  if (flavour === "gnu") {
    const m = /Maximum resident set size \(kbytes\): (\d+)/.exec(stderr);
    return m ? Number(m[1]) : null;
  }
  return null;
}

function measure(flavour, command, args, options = {}) {
  const wrapped =
    flavour === null
      ? { cmd: command, args }
      : { cmd: "/usr/bin/time", args: [flavour === "bsd" ? "-l" : "-v", command, ...args] };
  const t0 = performance.now();
  const run = spawnSync(wrapped.cmd, wrapped.args, {
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
    ...options,
  });
  return {
    wallMs: elapsed(t0),
    status: run.status,
    stdout: run.stdout ?? "",
    stderr: run.stderr ?? "",
    peakKb: peakKbFrom(flavour, run.stderr ?? ""),
  };
}

function nodeChild(flavour, engine, target, tmp) {
  const out = path.join(tmp, `${engine}.json`);
  const tsx = import.meta.resolve("tsx");
  const run = measure(flavour, process.execPath, [
    "--max-old-space-size=16384",
    "--import",
    tsx,
    fileURLToPath(import.meta.url),
    "--child",
    engine,
    target,
    out,
  ]);
  if (run.status !== 0 || !fs.existsSync(out)) {
    const tail = run.stderr.trim().split("\n").slice(-3).join(" ").slice(0, 300);
    return { ...run, error: `exit ${run.status}: ${tail}` };
  }
  const result = JSON.parse(fs.readFileSync(out, "utf8"));
  return { ...run, ...result, peakKb: run.peakKb ?? result.selfMaxRssKb };
}

// Type packages a TypeScript 5 program picks up on its own: every `@types/*` in a
// `node_modules/@types` at or above `dir`. TypeScript 7 (tsgo) defaults `types` to `[]`, so a
// tsconfig that leaves `types` unset would hand the two checkers different programs.
function ambientTypes(dir) {
  const names = new Set();
  for (let at = dir; ; at = path.dirname(at)) {
    const root = path.join(at, "node_modules", "@types");
    if (fs.existsSync(root)) for (const name of fs.readdirSync(root)) names.add(name);
    if (path.dirname(at) === at) break;
  }
  return [...names].sort();
}

function sourceFilesUnder(target) {
  return spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: target,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  })
    .stdout.split("\0")
    .filter(
      (f) => /\.tsx?$/.test(f) && !/\.d\.ts$/.test(f) && !/(^|\/)(node_modules|dist)\//.test(f),
    );
}

// A target without a tsconfig of its own (the repo root) gets one synthesized over its source
// files, so the checkers have a program to check. The edge pass has no such seam.
function checkerConfig(target, tmp) {
  const own = findUp(target, "tsconfig.json");
  if (own !== null) {
    const setsTypes = /"types"\s*:/.test(fs.readFileSync(own, "utf8"));
    const types = setsTypes ? [] : ambientTypes(path.dirname(own));
    return {
      tsconfig: own,
      synthesized: false,
      tsgoArgs: types.length ? ["--types", types.join(",")] : [],
    };
  }
  const packages = path.join(target, "packages");
  const typeRoots = fs.existsSync(packages)
    ? fs
        .readdirSync(packages, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => path.join(packages, d.name, "node_modules", "@types"))
        .filter((d) => fs.existsSync(d))
    : [];
  const types = [...new Set(typeRoots.flatMap((d) => fs.readdirSync(d)))].sort();
  const tsconfig = path.join(tmp, "tsconfig.json");
  fs.writeFileSync(
    tsconfig,
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        lib: ["ES2022", "DOM", "DOM.Iterable"],
        jsx: "react-jsx",
        strict: true,
        skipLibCheck: true,
        noEmit: true,
        esModuleInterop: true,
        resolveJsonModule: true,
        typeRoots,
        types,
      },
      files: sourceFilesUnder(target).map((f) => path.join(target, f)),
    }),
  );
  return { tsconfig, synthesized: true, tsgoArgs: [] };
}

async function binaries() {
  const { tsgoBinary } = await import(SRC("engine/tsgo.ts"));
  const tsgo = await tsgoBinary();
  const tscPkg = path.dirname(fileURLToPath(import.meta.resolve("typescript/package.json")));
  return {
    tsgo: tsgo.path,
    tsgoVersion: tsgo.version,
    tsc: path.join(tscPkg, "lib", "tsc.js"),
    tscVersion: JSON.parse(fs.readFileSync(path.join(tscPkg, "package.json"), "utf8")).version,
  };
}

function checkRun(flavour, command, args) {
  const run = measure(flavour, command, [...args, "--noEmit", "--pretty", "false"]);
  const diagnostics = (run.stdout.match(/error TS\d+/g) ?? []).length;
  if (run.status !== 0 && run.status !== 1 && run.status !== 2) {
    return { ...run, error: `exit ${run.status}: ${run.stderr.trim().split("\n").at(-1)}` };
  }
  return { ...run, diagnostics };
}

const CODEGRAPH = "@colbymchenry/codegraph@1.6.0";

// #381's question: colbymchenry/codegraph's own index over the same source files. It writes a
// `.codegraph/` directory into the project it indexes, so it indexes a scratch copy.
function codegraphRun(flavour, target, tmp) {
  const copy = path.join(tmp, "codegraph-copy");
  fs.rmSync(copy, { recursive: true, force: true });
  for (const f of sourceFilesUnder(target)) {
    const dest = path.join(copy, f);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(target, f), dest);
  }
  const env = { ...process.env, CODEGRAPH_NO_DAEMON: "1", CODEGRAPH_TELEMETRY: "0" };
  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  const run = measure(flavour, npx, ["-y", CODEGRAPH, "init", "-y", copy], { env });
  if (run.status !== 0) return { ...run, error: `exit ${run.status}` };
  const own = /in ([\d.]+)s/.exec(run.stdout);
  const nodes = /([\d,]+) nodes, ([\d,]+) edges/.exec(run.stdout);
  return {
    ...run,
    ownIndexMs: own ? Math.round(Number(own[1]) * 1000) : null,
    graph: nodes ? `${nodes[1]} nodes, ${nodes[2]} edges` : null,
  };
}

const EXAMPLES = 3;

function setDiff(baseline, candidate) {
  const b = new Set(baseline);
  const c = new Set(candidate);
  const missing = [...b].filter((x) => !c.has(x));
  const extra = [...c].filter((x) => !b.has(x));
  return {
    matching: c.size - extra.length,
    missing: missing.length,
    extra: extra.length,
    examples: { missing: missing.slice(0, EXAMPLES), extra: extra.slice(0, EXAMPLES) },
  };
}

// The facts the parity rows compare, read off a Graph: resolved module edges, each function's
// position and name, and every call edge with the declaration it names.
function graphFacts(graph) {
  return {
    moduleEdges: graph.modules.flatMap((m) =>
      m.importEdges
        .filter((e) => e.target !== null)
        .map((e) => `${m.file} -> ${e.target} ${e.kind}${e.typeOnly ? " type" : ""}`),
    ),
    functions: graph.functions.map((f) => `${f.id} @${f.startLine}-${f.endLine} ${f.kind}`),
    callees: graph.functions.flatMap((f) =>
      (f.edges?.calls ?? []).map(
        (c) => `${f.id} :${c.line} -> ${c.calleeId}${c.declaration ? ` (${c.declaration})` : ""}`,
      ),
    ),
  };
}

function parityAgainst(baselineFile, edge) {
  if (!baselineFile || edge.error) return null;
  const baseline = graphFacts(JSON.parse(fs.readFileSync(baselineFile, "utf8")));
  const candidate = graphFacts(edge.graph);
  return {
    moduleEdges: setDiff(baseline.moduleEdges, candidate.moduleEdges),
    functions: setDiff(baseline.functions, candidate.functions),
    callees: setDiff(baseline.callees, candidate.callees),
  };
}

const mb = (kb) => (kb === null || kb === undefined ? "n/a" : `${Math.round(kb / 1024)} MB`);
const sec = (ms) => `${(ms / 1000).toFixed(2)} s`;

function row(name, r, parity, note = "") {
  if (r === null) return `| ${name} | not measured | not measured | ${parity} |`;
  if (r.error) return `| ${name} | not measured | not measured | not measured: ${r.error} |`;
  const work = r.workMs !== undefined ? ` (work ${sec(r.workMs)})` : "";
  return `| ${name} | ${sec(r.wallMs)}${work} | ${mb(r.peakKb)} | ${parity}${note} |`;
}

const counts = (d) => `${d.matching} match / ${d.missing} missing / ${d.extra} extra`;

function parityLines(parity) {
  if (parity === null) return ["No `--baseline`: parity not measured."];
  const out = [
    "| Parity against the ts-morph baseline | Result |",
    "|---|---|",
    `| module edges (resolved, in the file set) | ${counts(parity.moduleEdges)} |`,
    `| functions (id, lines, kind) | ${counts(parity.functions)} |`,
    `| callee edges (caller, line, callee, declaration) | ${counts(parity.callees)} |`,
  ];
  for (const [name, diff] of Object.entries(parity)) {
    for (const side of ["missing", "extra"]) {
      for (const example of diff.examples[side]) out.push(`- ${name} ${side}: \`${example}\``);
    }
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--child") return runChild(args.slice(1));
  const { values: opts, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      baseline: { type: "string" },
      codegraph: { type: "boolean", default: false },
      runs: { type: "string", default: "3" },
      json: { type: "string" },
    },
  });
  const target = path.resolve(positionals[0] ?? PACKAGE_DIR);
  const repoRoot = path.dirname(findUp(target, "pnpm-workspace.yaml") ?? path.join(target, "x"));
  const label = path.relative(repoRoot, target) || ".";
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "code-graph-bench-"));
  const flavour = timeFlavour();
  const bin = await binaries();
  const { tsconfig, synthesized, tsgoArgs } = checkerConfig(target, tmp);
  const log = (m) => process.stderr.write(`bench: ${m}\n`);

  const runs = Math.max(1, Number(opts.runs));
  const load = os
    .loadavg()
    .map((l) => l.toFixed(1))
    .join(" ");
  log(
    `target ${label}; ${runs} run(s) per engine; peak RSS via ${flavour ? `/usr/bin/time (${flavour})` : "self-report"}`,
  );
  // Each engine runs `runs` times, interleaved per round so a load spike hits every engine
  // alike; the row reports the median wall and the median peak.
  const plan = {
    floor: () => nodeChild(flavour, "floor", target, tmp),
    cheap: () => nodeChild(flavour, "cheap", target, tmp),
    edge: () => nodeChild(flavour, "edge", target, tmp),
    tsgoCheck: () => checkRun(flavour, bin.tsgo, ["-p", tsconfig, ...tsgoArgs]),
    tscCheck: () => checkRun(flavour, process.execPath, [bin.tsc, "-p", tsconfig]),
    ...(opts.codegraph ? { codegraph: () => codegraphRun(flavour, target, tmp) } : {}),
  };
  const samples = Object.fromEntries(Object.keys(plan).map((k) => [k, []]));
  for (let round = 1; round <= runs; round++) {
    for (const [name, run] of Object.entries(plan)) {
      log(`round ${round}/${runs}: ${name}`);
      samples[name].push(run());
    }
  }
  const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)];
  const pick = (list) => {
    const ok = list.filter((r) => !r.error);
    if (ok.length === 0) return list[0];
    return {
      ...ok[ok.length - 1],
      wallMs: median(ok.map((r) => r.wallMs)),
      workMs: ok[0].workMs === undefined ? undefined : median(ok.map((r) => r.workMs)),
      peakKb: ok.some((r) => r.peakKb == null) ? null : median(ok.map((r) => r.peakKb)),
    };
  };
  const { floor, cheap, edge, tsgoCheck, tscCheck } = Object.fromEntries(
    Object.entries(samples).map(([k, v]) => [k, pick(v)]),
  );
  const codegraph = samples.codegraph ? pick(samples.codegraph) : null;
  const parity = parityAgainst(opts.baseline, edge);
  const edgeFacts = edge.error ? null : graphFacts(edge.graph);

  const lines = [
    `### Target \`${label}\``,
    "",
    `${cheap.files ?? "?"} files parsed` +
      `${synthesized ? "; checkers ran against a synthesized tsconfig (the target has none)" : ""}. ` +
      `Median of ${runs} run(s); load average at start: ${load}.`,
    "",
    "| Engine | Wall (process) | Peak RSS | Output |",
    "|---|---|---|---|",
    row("harness floor (node + tsx + imports, no work)", floor, "subtract from every node row"),
    row(
      "cheap pass (oxc: `loadCheapProject` + `assembleGraph`)",
      cheap,
      `${cheap.functions ?? "?"} functions`,
    ),
    row(
      "edge pass (oxc + tsgo: `loadEdgeProject` + `assembleGraphWithEdges` + clusters)",
      edge,
      edgeFacts === null
        ? ""
        : `${new Set(edgeFacts.moduleEdges).size} resolved module edges; ${edgeFacts.callees.length} callee edges`,
    ),
    row(
      `tsgo full check (\`tsgo --noEmit\`, ${bin.tsgoVersion})`,
      tsgoCheck,
      `${tsgoCheck.diagnostics ?? "?"} diagnostics (cost proxy)`,
    ),
    row(
      `tsc full check (\`tsc --noEmit\`, TypeScript ${bin.tscVersion})`,
      tscCheck,
      `${tscCheck.diagnostics ?? "?"} diagnostics`,
    ),
  ];
  if (codegraph !== null) {
    lines.push(
      row(
        `colbymchenry/codegraph (\`npx ${CODEGRAPH} init\`)`,
        codegraph,
        `index only, no parity (#381); ${codegraph.graph ?? ""}`,
        codegraph.ownIndexMs ? `; its own index timer ${sec(codegraph.ownIndexMs)}` : "",
      ),
    );
  }
  lines.push("", ...parityLines(parity));
  lines.push(
    "",
    `Phases of the last run (ms): \`${JSON.stringify({ cheap: cheap.phases, edge: edge.phases })}\``,
  );
  process.stdout.write(`${lines.join("\n").replaceAll(repoRoot, "<repo>")}\n`);

  const jsonOut = opts.json;
  if (jsonOut) {
    const strip = ({ stdout, stderr, graph, ...rest }) => rest;
    fs.writeFileSync(
      jsonOut,
      JSON.stringify(
        {
          target: label,
          runs,
          loadAverage: load,
          node: process.version,
          platform: `${os.type()} ${os.release()} ${os.arch()}`,
          cpu: os.cpus()[0]?.model,
          memoryGb: Math.round(os.totalmem() / 1024 ** 3),
          versions: { tsgo: bin.tsgoVersion, tsc: bin.tscVersion },
          engines: {
            floor: strip(floor),
            cheap: strip(cheap),
            edge: strip(edge),
            tsgoCheck: strip(tsgoCheck),
            tscCheck: strip(tscCheck),
            codegraph: codegraph && strip(codegraph),
          },
          parity,
        },
        null,
        2,
      ),
    );
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

await main();
