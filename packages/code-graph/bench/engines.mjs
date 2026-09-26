#!/usr/bin/env node
// Engine benchmark for @demlik/code-graph (#384): ts-morph (today's loaders) against oxc
// (syntax + module resolution) and tsgo (the native checker). Run by hand, never in CI:
//
//   node packages/code-graph/bench/engines.mjs [target] [--codegraph] [--runs <n>] [--json <file>]
//
// `target` defaults to packages/code-graph. Every engine runs in its own child process under
// `/usr/bin/time`, so wall time and peak RSS are per engine; parity is computed here, in the
// parent, from the artifacts each child writes. See FINDINGS.md for the numbers and their read.
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

function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

function lineOf(starts, offset) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

const elapsed = (t0) => Math.round(performance.now() - t0);

function writeResult(out, result) {
  fs.writeFileSync(
    out,
    JSON.stringify({ ...result, selfMaxRssKb: process.resourceUsage().maxRSS }),
  );
}

async function childTsMorphCheap(target, out) {
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

function calleeKey(id) {
  if (id.startsWith("external:")) return null;
  const bare = id.startsWith("workspace:") ? id.slice("workspace:".length) : id;
  if (bare.startsWith("../")) return null;
  return bare.replace(/#\d+$/, "").toLowerCase();
}

async function childTsMorphEdge(target, out) {
  const { loadEdgeProject, findRepoRoot } = await import(SRC("extract/project.ts"));
  const { assembleGraphWithEdges } = await import(SRC("extract/assemble.ts"));
  const { buildClusterReport } = await import(SRC("query/clusters.ts"));
  const { nameTokens } = await import(SRC("collapse/tokens.ts"));
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
  const clusters = buildClusterReport(graph.functions, graph.modules);
  const clustersImportOnly = buildClusterReport([], graph.modules);
  const clustersMs = elapsed(t1);
  writeResult(out, {
    workMs: elapsed(t0),
    phases: { loadMs, assembleMs, clustersMs },
    files: graph.modules.length,
    functions: graph.functions.length,
    edges: graph.modules.flatMap((m) =>
      m.importEdges
        .filter((e) => e.target !== null)
        .map((e) => ({ from: m.file, to: e.target, typeOnly: e.typeOnly })),
    ),
    clusters,
    clustersImportOnly,
    tokens: graph.functions.map((f) => ({
      key: `${f.file}:${f.startLine}:${f.name}`,
      tokens: nameTokens(f.name),
    })),
    spans: graph.functions.map((f) => [f.file.toLowerCase(), f.startLine, f.endLine]),
    callees: graph.functions.flatMap((f) =>
      (f.edges?.calls ?? []).flatMap((c) => {
        const key = calleeKey(c.calleeId);
        return key === null ? [] : [`${f.file.toLowerCase()}:${c.line}->${key}`];
      }),
    ),
  });
}

// oxc: the same file set (listSourceFiles is file discovery, not engine logic), parsed with
// oxc-parser and resolved with oxc-resolver. Nothing here reads ts-morph.
function oxcImportEdges(file, source, module, resolver, fileSet, root) {
  const edges = [];
  const push = (specifier, kind, typeOnly) => {
    let target = null;
    const resolved = resolver.sync(path.dirname(file), specifier);
    if (resolved.path) {
      const rel = path.relative(root, resolved.path).split(path.sep).join("/");
      if (fileSet.has(rel)) target = rel;
    }
    edges.push({ specifier, kind, typeOnly, target });
  };
  for (const imp of module.staticImports) {
    const text = source.slice(imp.start, imp.end);
    push(imp.moduleRequest.value, "static", /^import\s+type[\s{]/.test(text));
  }
  for (const exp of module.staticExports) {
    // The module record gives `import { x } from "m"; export { x }` an indirect export entry
    // naming "m" and spanning the import; only an `export … from` statement is an edge here.
    const request = exp.entries.find((e) => e.moduleRequest !== null)?.moduleRequest;
    const text = source.slice(exp.start, exp.end);
    if (!request || !/^export\b/.test(text) || !/\bfrom\s*['"]/.test(text)) continue;
    push(request.value, "export-from", /^export\s+type[\s{*]/.test(text));
  }
  for (const dyn of module.dynamicImports) {
    const raw = source.slice(dyn.moduleRequest.start, dyn.moduleRequest.end).trim();
    const literal = /^(['"`])([^'"`]*)\1$/.exec(raw);
    if (literal) push(literal[2], "dynamic", false);
  }
  return edges;
}

// The name ts-morph's getName() reports for a member: the key's source text, so a string key
// keeps its quotes, a private one its `#`, and a computed one its brackets.
function memberName(holder, source) {
  const key = holder.key;
  if (!key) return null;
  const text = source.slice(key.start, key.end);
  if (holder.computed) return `[${text}]`;
  return key.type === "Identifier" ? key.name : text;
}

// Mirrors the *shape* of src/extract/functions.ts's discovery on the ESTree AST oxc emits:
// named function declarations, class and object-literal methods/accessors, constructors, and
// arrows / function expressions bound to a name.
function oxcFunctions(program, source) {
  const found = [];
  const bindingName = (parent) => {
    if (!parent) return null;
    if (parent.type === "VariableDeclarator") {
      return parent.id.type === "Identifier" ? parent.id.name : null;
    }
    if (parent.type === "Property" && !parent.method && parent.kind === "init") {
      return memberName(parent, source);
    }
    if (parent.type === "PropertyDefinition") return memberName(parent, source);
    if (parent.type === "ExportDefaultDeclaration") return "default";
    return null;
  };
  const visit = (node, parent) => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child, parent);
      return;
    }
    if (typeof node.type !== "string") return;
    let name = null;
    const methodValue =
      parent &&
      (parent.type === "MethodDefinition" ||
        (parent.type === "Property" && (parent.method || parent.kind !== "init")));
    if (node.type === "FunctionDeclaration" && node.body) {
      name = node.id?.name ?? (parent?.type === "ExportDefaultDeclaration" ? "default" : null);
    } else if (node.type === "MethodDefinition" && node.value?.body) {
      name = node.kind === "constructor" ? "constructor" : memberName(node, source);
    } else if (node.type === "Property" && (node.method || node.kind !== "init")) {
      name = memberName(node, source);
    } else if (node.type === "ArrowFunctionExpression") {
      name = bindingName(parent);
    } else if (node.type === "FunctionExpression" && !methodValue) {
      name = node.id?.name ?? bindingName(parent);
    }
    if (name !== null) found.push({ name, start: node.start });
    for (const [field, child] of Object.entries(node)) {
      if (field !== "type" && child !== null && typeof child === "object") visit(child, node);
    }
  };
  visit(program, null);
  return found;
}

async function childOxc(target, out) {
  const { parseSync } = await import("oxc-parser");
  const { ResolverFactory } = await import("oxc-resolver");
  const { listSourceFiles } = await import(SRC("extract/project.ts"));
  const { buildClusterReport } = await import(SRC("query/clusters.ts"));
  const { nameTokens } = await import(SRC("collapse/tokens.ts"));
  const t0 = performance.now();
  const files = listSourceFiles(target);
  const rel = (abs) => path.relative(target, abs).split(path.sep).join("/");
  const fileSet = new Set(files.map(rel));
  // One tsconfig per target, the one `loadEdgeProject` would pick, so both engines resolve under
  // the same config; only a target with none (the repo root) falls back to per-file discovery.
  const ownTsconfig = findUp(target, "tsconfig.json");
  const resolver = new ResolverFactory({
    tsconfig: ownTsconfig === null ? "auto" : { configFile: ownTsconfig },
    extensions: [".ts", ".tsx", ".d.ts", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"],
    extensionAlias: {
      ".js": [".ts", ".tsx", ".d.ts", ".js"],
      ".mjs": [".mts", ".mjs"],
      ".cjs": [".cts", ".cjs"],
    },
    conditionNames: ["types", "import", "node", "default"],
  });
  const modules = [];
  const parsed = [];
  let parseFailures = 0;
  for (const abs of files) {
    const source = fs.readFileSync(abs, "utf8");
    const result = parseSync(abs, source);
    if (result.errors.length > 0) {
      parseFailures++;
      continue;
    }
    const file = rel(abs);
    const importEdges = oxcImportEdges(abs, source, result.module, resolver, fileSet, target);
    modules.push({ file, importEdges, isTest: /\.(test|spec)\.tsx?$/.test(file) });
    parsed.push({ file, source, program: result.program });
  }
  const graphMs = elapsed(t0);
  const t1 = performance.now();
  const clusters = buildClusterReport([], modules);
  const clustersMs = elapsed(t1);
  const t2 = performance.now();
  const tokens = parsed.flatMap(({ file, source, program }) => {
    const starts = lineStarts(source);
    return oxcFunctions(program, source).map((f) => ({
      key: `${file}:${lineOf(starts, f.start)}:${f.name}`,
      tokens: nameTokens(f.name),
    }));
  });
  const tokensMs = elapsed(t2);
  writeResult(out, {
    workMs: elapsed(t0),
    phases: { graphMs, clustersMs, tokensMs },
    files: modules.length,
    parseFailures,
    edges: modules.flatMap((m) =>
      m.importEdges
        .filter((e) => e.target !== null)
        .map((e) => ({ from: m.file, to: e.target, typeOnly: e.typeOnly })),
    ),
    clustersImportOnly: clusters,
    tokens,
  });
}

// tsgo's programmatic surface (@typescript/native-preview/unstable/sync): open the project,
// walk each target file's call expressions on tsgo's own AST, and resolve every callee through
// the checker in one batched getSymbolAtLocation per file.
async function childTsgoCallees(target, out, tsconfig) {
  const { API } = await import("@typescript/native-preview/unstable/sync");
  const { SyntaxKind } = await import("@typescript/native-preview/unstable/ast");
  const { listSourceFiles } = await import(SRC("extract/project.ts"));
  const t0 = performance.now();
  // tsgo hands back declaration paths case-folded on a case-insensitive filesystem.
  const relLower = (abs) =>
    path.relative(target.toLowerCase(), abs.toLowerCase()).split(path.sep).join("/");
  const targetFiles = new Map(listSourceFiles(target).map((abs) => [relLower(abs), abs]));
  const api = new API({ cwd: path.dirname(tsconfig) });
  const snapshot = api.updateSnapshot({ openProjects: [tsconfig] });
  const project = snapshot.getProject(tsconfig);
  const openMs = elapsed(t0);
  const declKinds = new Set([
    SyntaxKind.FunctionDeclaration,
    SyntaxKind.MethodDeclaration,
    SyntaxKind.VariableDeclaration,
    SyntaxKind.PropertyDeclaration,
    SyntaxKind.PropertyAssignment,
    SyntaxKind.GetAccessor,
    SyntaxKind.SetAccessor,
  ]);
  const callees = [];
  const programFiles = [];
  let callSites = 0;
  for (const name of project.program.getSourceFileNames()) {
    const fileKey = relLower(name);
    if (!targetFiles.has(fileKey)) continue;
    programFiles.push(fileKey);
    const sf = project.program.getSourceFile(name);
    if (!sf) continue;
    const calls = [];
    const visit = (node) => {
      if (node.kind === SyntaxKind.CallExpression) calls.push(node);
      node.forEachChild(visit);
    };
    sf.forEachChild(visit);
    callSites += calls.length;
    const at = calls.map((c) =>
      c.expression.kind === SyntaxKind.PropertyAccessExpression ? c.expression.name : c.expression,
    );
    const symbols = at.length === 0 ? [] : project.checker.getSymbolAtLocation(at);
    symbols.forEach((symbol, i) => {
      if (!symbol) return;
      const resolved = symbol.flags & 2097152 ? project.checker.getAliasedSymbol(symbol) : symbol;
      const decl = resolved.declarations.find((d) => declKinds.has(d.kind));
      if (!decl) return;
      const declKey = relLower(decl.path);
      if (declKey.startsWith("../") || !targetFiles.has(declKey)) return;
      const line = sf.getLineAndCharacterOfPosition(calls[i].getStart(sf)).line + 1;
      callees.push({ file: fileKey, line, key: `${declKey}:${resolved.name.toLowerCase()}` });
    });
  }
  const workMs = elapsed(t0);
  api.close();
  writeResult(out, {
    workMs,
    phases: { openMs, resolveMs: workMs - openMs },
    callSites,
    programFiles,
    callees,
  });
}

// The floor every node child stands on: node + the tsx loader + the src modules the oxc child
// imports (listSourceFiles drags ts-morph in with it), doing no work.
async function childFloor(_target, out) {
  await import(SRC("extract/project.ts"));
  await import(SRC("query/clusters.ts"));
  await import(SRC("collapse/tokens.ts"));
  writeResult(out, { workMs: 0 });
}

async function runChild(argv) {
  const [engine, target, out, tsconfig] = argv;
  if (engine === "floor") return childFloor(target, out);
  if (engine === "tsmorph-cheap") return childTsMorphCheap(target, out);
  if (engine === "tsmorph-edge") return childTsMorphEdge(target, out);
  if (engine === "oxc") return childOxc(target, out);
  if (engine === "tsgo-callees") return childTsgoCallees(target, out, tsconfig);
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

function nodeChild(flavour, engine, target, tmp, extra = []) {
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
    ...extra,
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
// files, so the checkers have a program to check. The ts-morph edge loader has no such seam.
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
  const tsgoPkg = path.dirname(
    fileURLToPath(import.meta.resolve("@typescript/native-preview/package.json")),
  );
  const { default: getExePath } = await import(
    pathToFileURL(path.join(tsgoPkg, "lib", "getExePath.js")).href
  );
  const tscPkg = path.dirname(fileURLToPath(import.meta.resolve("typescript/package.json")));
  return {
    tsgo: getExePath(),
    tsgoVersion: JSON.parse(fs.readFileSync(path.join(tsgoPkg, "package.json"), "utf8")).version,
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

function setDiff(baseline, candidate) {
  const b = new Set(baseline);
  const c = new Set(candidate);
  let matching = 0;
  for (const x of c) if (b.has(x)) matching++;
  return { matching, missing: b.size - matching, extra: c.size - matching };
}

const edgeKeys = (edges) => edges.map((e) => `${e.from}\t${e.to}`);

// A ClusterReport names every file of a scattered cluster and of a split directory; a file of
// a single-directory cluster in an unsplit directory is not named. Parity is compared over the
// files both reports name, label-free: a file moved if its set of co-members changed.
function membership(report) {
  const of = new Map();
  for (const c of report.scatteredClusters) {
    for (const d of c.dirs) for (const f of d.files) of.set(f, c.id);
  }
  for (const d of report.splitDirectories) {
    for (const c of d.clusters) for (const f of c.files) of.set(f, c.clusterId);
  }
  return of;
}

function clusterParity(baseline, candidate) {
  const strip = (r) => JSON.stringify(r);
  const a = membership(baseline);
  const b = membership(candidate);
  const common = [...a.keys()].filter((f) => b.has(f));
  const peers = (m, f) =>
    common
      .filter((g) => m.get(g) === m.get(f))
      .sort()
      .join("|");
  const moved = common.filter((f) => peers(a, f) !== peers(b, f)).length;
  return {
    identical: strip(baseline) === strip(candidate),
    clusters: `${baseline.clusterCount} vs ${candidate.clusterCount}`,
    modularity: `${baseline.modularity} vs ${candidate.modularity}`,
    compared: common.length,
    moved,
  };
}

function tokenParity(baseline, candidate) {
  const byKey = new Map(candidate.map((t) => [t.key, t.tokens.join(" ")]));
  let matching = 0;
  let differing = 0;
  let missing = 0;
  for (const t of baseline) {
    const other = byKey.get(t.key);
    if (other === undefined) missing++;
    else if (other === t.tokens.join(" ")) matching++;
    else differing++;
  }
  const baseKeys = new Set(baseline.map((t) => t.key));
  const extra = candidate.filter((t) => !baseKeys.has(t.key)).length;
  return { functions: baseline.length, matching, differing, missing, extra };
}

// Compared over the caller files both programs hold: `loadEdgeProject` adds every visible
// source file to the tsconfig's program, while tsgo opens the tsconfig's own file set (which
// may exclude tests and examples). ts-morph records calls inside discovered functions only, so
// tsgo's call sites are kept when they fall inside one of ts-morph's function spans.
function calleeParity(edge, tsgo) {
  const spans = new Map();
  for (const [file, start, end] of edge.spans) {
    const list = spans.get(file) ?? [];
    list.push([start, end]);
    spans.set(file, list);
  }
  const shared = new Set(tsgo.programFiles);
  const inFunction = (c) => (spans.get(c.file) ?? []).some(([s, e]) => c.line >= s && c.line <= e);
  const tsgoKeys = tsgo.callees.filter(inFunction).map((c) => `${c.file}:${c.line}->${c.key}`);
  const baseline = edge.callees.filter((k) => shared.has(k.slice(0, k.indexOf(":"))));
  return {
    ...setDiff(baseline, tsgoKeys),
    outsideTsconfig: new Set(edge.callees).size - new Set(baseline).size,
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

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--child") return runChild(args.slice(1));
  const { values: opts, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
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
    cheap: () => nodeChild(flavour, "tsmorph-cheap", target, tmp),
    edge: () => nodeChild(flavour, "tsmorph-edge", target, tmp),
    oxc: () => nodeChild(flavour, "oxc", target, tmp),
    tsgoCheck: () => checkRun(flavour, bin.tsgo, ["-p", tsconfig, ...tsgoArgs]),
    tscCheck: () => checkRun(flavour, process.execPath, [bin.tsc, "-p", tsconfig]),
    tsgoCallees: () => nodeChild(flavour, "tsgo-callees", target, tmp, [tsconfig]),
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
  const { floor, cheap, edge, oxc, tsgoCheck, tscCheck, tsgoCallees } = Object.fromEntries(
    Object.entries(samples).map(([k, v]) => [k, pick(v)]),
  );
  const codegraph = samples.codegraph ? pick(samples.codegraph) : null;

  const edgeOk = !edge.error;
  const oxcOk = !oxc.error;
  const edges = edgeOk && oxcOk ? setDiff(edgeKeys(edge.edges), edgeKeys(oxc.edges)) : null;
  const clusters =
    edgeOk && oxcOk ? clusterParity(edge.clustersImportOnly, oxc.clustersImportOnly) : null;
  const checkerDrop = edgeOk ? clusterParity(edge.clusters, edge.clustersImportOnly) : null;
  const tokens = edgeOk && oxcOk ? tokenParity(edge.tokens, oxc.tokens) : null;
  const callees = edgeOk && !tsgoCallees.error ? calleeParity(edge, tsgoCallees) : null;

  const noBaseline = "no ts-morph edge baseline on this target";
  const oxcParity = edges
    ? `edges ${edges.matching} match / ${edges.missing} missing / ${edges.extra} extra; ` +
      `clusters (imports only) ${clusters.identical ? "identical" : `${clusters.moved} of ${clusters.compared} named files moved`}, ${clusters.clusters}; ` +
      `name tokens ${tokens.matching}/${tokens.functions} match, ${tokens.differing} differ, ${tokens.missing} missing, ${tokens.extra} extra`
    : noBaseline;
  const lines = [
    `### Target \`${label}\``,
    "",
    `${cheap.files ?? "?"} files parsed by ts-morph cheap; ${oxc.files ?? "?"} by oxc` +
      `${synthesized ? "; checkers ran against a synthesized tsconfig (the target has none)" : ""}. ` +
      `Median of ${runs} run(s); load average at start: ${load}.`,
    "",
    "| Engine | Wall (process) | Peak RSS | Parity |",
    "|---|---|---|---|",
    row("harness floor (node + tsx + imports, no work)", floor, "subtract from every node row"),
    row("ts-morph cheap (`loadCheapProject` + `assembleGraph`)", cheap, "baseline (syntax)"),
    row(
      "ts-morph edge (`loadEdgeProject` + `assembleGraphWithEdges` + clusters)",
      edge,
      edgeOk
        ? `baseline; ${new Set(edgeKeys(edge.edges)).size} distinct resolved module edges; call edges ${checkerDrop.identical ? "do not change" : `move ${checkerDrop.moved} of ${checkerDrop.compared} named files in`} the cluster partition`
        : "",
    ),
    row("oxc (`oxc-parser` + `oxc-resolver`: import graph, clusters, name tokens)", oxc, oxcParity),
    row(
      `tsgo full check (\`tsgo --noEmit\`)`,
      tsgoCheck,
      `${tsgoCheck.diagnostics ?? "?"} diagnostics (cost proxy, no parity)`,
    ),
    row(
      `tsc full check (\`tsc --noEmit\`, TypeScript ${bin.tscVersion})`,
      tscCheck,
      `${tscCheck.diagnostics ?? "?"} diagnostics`,
    ),
    row(
      "tsgo callee resolution (`unstable/sync` API)",
      tsgoCallees,
      callees
        ? `callee edges vs \`resolveCallees\`: ${callees.matching} match / ${callees.missing} missing / ${callees.extra} extra over the files tsgo's tsconfig holds; ${callees.outsideTsconfig} ts-morph callee edges sit in files it excludes`
        : `${tsgoCallees.callSites ?? "?"} call sites resolved; ${noBaseline}`,
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
  const phases = {
    cheap: cheap.phases,
    edge: edge.phases,
    oxc: oxc.phases,
    tsgoCallees: tsgoCallees.phases,
  };
  lines.push("", `Phases of the last run (ms): \`${JSON.stringify(phases)}\``);
  process.stdout.write(`${lines.join("\n").replaceAll(repoRoot, "<repo>")}\n`);

  const jsonOut = opts.json;
  if (jsonOut) {
    const strip = ({
      stdout,
      stderr,
      edges: e,
      tokens: t,
      callees: c,
      spans,
      clusters: cl,
      clustersImportOnly,
      ...rest
    }) => rest;
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
            cheap: strip(cheap),
            edge: strip(edge),
            oxc: strip(oxc),
            tsgoCheck: strip(tsgoCheck),
            tscCheck: strip(tscCheck),
            tsgoCallees: strip(tsgoCallees),
            codegraph: codegraph && strip(codegraph),
          },
          parity: { edges, clusters, checkerDrop, tokens, callees },
        },
        null,
        2,
      ),
    );
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

await main();
