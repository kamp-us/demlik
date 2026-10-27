import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { findCollapseCandidates } from "../../packages/code-graph/src/collapse/candidates.js";
import {
  partialTwinLines,
  renderCollapse,
  shortCalleeName,
} from "../../packages/code-graph/src/collapse/render.js";
import { CollapseSettingsSchema } from "../../packages/code-graph/src/collapse/settings.js";
import {
  type FunctionNode,
  type Graph,
  ThresholdsSchema,
} from "../../packages/code-graph/src/schema.js";
import { renderCases, shortCases } from "./collapse-render-cases.mjs";
import type { Node } from "./collapse-report-cases.mjs";

const [binary, reportFile] = process.argv.slice(2);
assert.ok(binary && reportFile);
assert.equal(process.version, "v22.21.1");
assert.equal(process.versions.v8, "12.4.254.21-node.33");
const root = fileURLToPath(new URL("../..", import.meta.url)),
  temporary = fs.mkdtempSync(path.join(root, "target/parity/collapse-render-")),
  hash = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const selected = process.env.DEMLIK_COLLAPSE_RENDER_CASES?.split(",");
if (selected)
  assert.ok(
    selected.every((id) =>
      [...renderCases, ...shortCases].some((c) => c.id === id),
    ),
  );
const rendered = z.strictObject({
  id: z.string(),
  output: z.strictObject({
    text: z.string(),
    partialLines: z.array(z.string()),
    bBlockLines: z.array(z.number().int()),
    observedCalls: z.array(z.string()),
  }),
});
const shortened = z.strictObject({
  id: z.string(),
  output: z.strictObject({
    value: z.string(),
    observedCalls: z.array(z.string()),
  }),
});
function fromNode(n: Node): FunctionNode {
  return {
    id: n.id,
    name: n.name,
    file: n.file,
    startLine: n.startLine,
    endLine: n.endLine,
    loc: n.loc,
    complexity: n.complexity,
    nestingDepth: n.nestingDepth,
    kind: n.kind,
    isTest: n.isTest,
    isExported: true,
    commentLines: 0,
    edges: n.noEdges
      ? null
      : {
          calls: n.calls.map((c) => ({ ...c, declaration: null })),
          calledBy: n.callers.map((callerId) => ({ callerId, line: 1 })),
          callChainDepth: 0,
        },
    nodeKind: n.effect ? { kind: "effect", evidence: [] } : null,
    smells: [],
  };
}
function graph(functions: FunctionNode[], root: string, edges: boolean): Graph {
  return {
    root,
    provenance: edges
      ? { pass: "edges", scope: "package", tsConfig: "tsconfig.json" }
      : { pass: "cheap" },
    thresholds: ThresholdsSchema.parse({}),
    summary: {
      health: "healthy",
      fileCount: 0,
      functionCount: functions.length,
      smellCount: 0,
      highSeverityCount: 0,
      worstFile: null,
      worstFunction: null,
      topTargets: [],
      parseFailures: [],
    },
    crossRuntime: null,
    reachability: null,
    clusters: null,
    interfaceWidth: null,
    data: null,
    functions,
    declarations: [],
    modules: [],
    directories: [],
    smells: [],
    stats: {
      fileCount: 0,
      functionCount: functions.length,
      totalLoc: functions.reduce((n, f) => n + f.loc, 0),
      totalCommentLines: 0,
      smellCount: 0,
      parseFailures: [],
    },
  };
}
const cases: unknown[] = [],
  failures: { id: string; kind: string; message: string }[] = [],
  nativeEvidence: Record<string, string[]> = {};
let protocol = 0,
  guards = 0;
try {
  const git = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
  assert.ok(git);
  const bin = path.join(temporary, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, "git"),
    `#!/bin/sh\nprintf 'git\\n' >> "$DEMLIK_RENDER_GIT_TRACE"\nexec '${git}' "$@"\n`,
    { mode: 0o755 },
  );
  for (const c of renderCases) {
    if (selected && !selected.includes(c.id)) continue;
    const fixture = path.join(temporary, c.id);
    fs.mkdirSync(fixture);
    for (const pkg of c.packages ?? []) {
      fs.mkdirSync(path.join(fixture, pkg), { recursive: true });
      fs.writeFileSync(path.join(fixture, pkg, "package.json"), "{}");
    }
    const g = graph(c.nodes.map(fromNode), fixture, c.edges ?? true),
      settings = CollapseSettingsSchema.parse(c.settings ?? {}),
      sourceGit = path.join(temporary, `${c.id}.source-git`),
      nativeGit = path.join(temporary, `${c.id}.native-git`);
    fs.writeFileSync(sourceGit, "");
    fs.writeFileSync(nativeGit, "");
    const oldPath = process.env.PATH,
      oldTrace = process.env.DEMLIK_RENDER_GIT_TRACE;
    let expected: string;
    try {
      process.env.PATH = `${bin}:${oldPath}`;
      process.env.DEMLIK_RENDER_GIT_TRACE = sourceGit;
      expected = renderCollapse(
        g,
        fixture,
        settings,
        c.json ?? false,
        c.pretty ?? false,
      );
    } finally {
      process.env.PATH = oldPath;
      if (oldTrace === undefined) delete process.env.DEMLIK_RENDER_GIT_TRACE;
      else process.env.DEMLIK_RENDER_GIT_TRACE = oldTrace;
    }
    const report = findCollapseCandidates(g.functions, [], settings),
      expectedLines = partialTwinLines(report),
      expectedB = report.partialTwins.map((p) => p.bBlockLine);
    const input = {
      operation: "render",
      root: fixture,
      nodes: c.nodes,
      settings,
      edges: c.edges ?? true,
      json: c.json ?? false,
      pretty: c.pretty ?? false,
    };
    const run = spawnSync(binary, [], {
      input: `${JSON.stringify({ id: c.id, input })}\n`,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${oldPath}`,
        DEMLIK_RENDER_GIT_TRACE: nativeGit,
      },
      maxBuffer: 64 * 1024 * 1024,
    });
    let native: unknown;
    let failure: string | undefined;
    let kind = "protocol";
    try {
      assert.ifError(run.error);
      assert.equal(run.status, 0, run.stderr);
      native = rendered.parse(JSON.parse(run.stdout));
      const n = rendered.parse(native);
      assert.equal(n.id, c.id);
      assert.deepEqual(n.output.observedCalls, [
        "demlik_code_graph::collapse::render::render_collapse",
        "demlik_code_graph::collapse::render::partial_twin_lines",
      ]);
      kind = "semantic";
      assert.equal(n.output.text, expected);
      assert.deepEqual(n.output.partialLines, expectedLines);
      assert.deepEqual(n.output.bBlockLines, expectedB);
      assert.equal(
        fs.readFileSync(nativeGit, "utf8"),
        fs.readFileSync(sourceGit, "utf8"),
      );
      if (c.expectedB) assert.deepEqual(expectedB, c.expectedB);
      if (c.id === "clusters-limit-21")
        assert.equal((expected.match(/^\s+\d+\. rank=/gm) ?? []).length, 20);
      if (c.id === "partials-limit-21")
        assert.equal((expected.match(/^\s+\d+\. block=/gm) ?? []).length, 20);
      if (c.id === "json-not-human-truncated")
        assert.equal(JSON.parse(expected).clusters.length, 21);
      assert.ok(!expected.endsWith("\n"));
      nativeEvidence[c.id] = n.output.observedCalls;
    } catch (e) {
      failure = String(e);
      failures.push({ id: c.id, kind, message: failure });
    }
    cases.push({
      id: c.id,
      input,
      source: {
        text: expected,
        partialLines: expectedLines,
        bBlockLines: expectedB,
        gitCalls: fs.readFileSync(sourceGit, "utf8"),
      },
      native: native ?? {
        status: run.status,
        stdout: run.stdout,
        stderr: run.stderr,
      },
      passed: !failure,
      failure,
    });
  }
  for (const c of shortCases) {
    if (selected && !selected.includes(c.id)) continue;
    const expected = shortCalleeName(c.value),
      input = { operation: "short", value: c.value },
      run = spawnSync(binary, [], {
        input: `${JSON.stringify({ id: c.id, input })}\n`,
        encoding: "utf8",
      });
    let native: unknown;
    let failure: string | undefined;
    let kind = "protocol";
    try {
      assert.ifError(run.error);
      assert.equal(run.status, 0, run.stderr);
      const n = shortened.parse(JSON.parse(run.stdout));
      native = n;
      assert.equal(n.id, c.id);
      assert.deepEqual(n.output.observedCalls, [
        "demlik_code_graph::collapse::render::short_callee_name",
      ]);
      kind = "semantic";
      assert.equal(n.output.value, expected);
      nativeEvidence[c.id] = n.output.observedCalls;
    } catch (e) {
      failure = String(e);
      failures.push({ id: c.id, kind, message: failure });
    }
    cases.push({
      id: c.id,
      input,
      source: expected,
      native,
      passed: !failure,
      failure,
    });
  }
  for (const input of [
    "not JSON",
    "{}",
    JSON.stringify({ id: "bad", input: { operation: "short", value: 3 } }),
    JSON.stringify({
      id: "extra",
      input: { operation: "short", value: "x", extra: 1 },
    }),
  ]) {
    const r = spawnSync(binary, [], { input: `${input}\n`, encoding: "utf8" });
    assert.ifError(r.error);
    assert.notEqual(r.status, 0);
    assert.equal(r.stdout, "");
    assert.ok(r.stderr.length);
    protocol++;
  }
  const sample = cases.find(
    (c) =>
      typeof c === "object" &&
      c !== null &&
      "passed" in c &&
      c.passed &&
      "native" in c &&
      typeof c.native === "object" &&
      c.native !== null &&
      "output" in c.native,
  );
  if (sample && typeof sample === "object" && "native" in sample)
    for (const edit of [
      (r: Record<string, unknown>) => {
        r.id = "foreign";
      },
      (r: Record<string, unknown>) => {
        r.output = { ...(r.output as object), observedCalls: [] };
      },
    ]) {
      const bad = structuredClone(sample.native) as Record<string, unknown>;
      edit(bad);
      assert.throws(() => {
        const n = rendered.parse(bad);
        assert.equal(n.id, rendered.parse(sample.native).id);
        assert.deepEqual(
          n.output.observedCalls,
          rendered.parse(sample.native).output.observedCalls,
        );
      });
      guards++;
    }
  const sourceFiles = [
    "collapse/render.ts",
    "collapse/candidates.ts",
    "collapse/partial.ts",
    "extract/project.ts",
    "render/json.ts",
  ];
  const result = {
    scope:
      "Actual collapse renderer/partial lines/short name. Synthetic dense typed Graph envelopes carry canonical FunctionNode facts; real loader/compiler/CLI workflows are verified separately. No whole Graph validation, raw object/prototype or distribution claim.",
    reference: {
      node: process.version,
      v8: process.versions.v8,
      sourceHashes: Object.fromEntries(
        sourceFiles.map((p) => [
          p,
          hash(fs.readFileSync(path.join(root, "packages/code-graph/src", p))),
        ]),
      ),
    },
    binary: { path: binary, sha256: hash(fs.readFileSync(binary)) },
    passed: cases.length - failures.length,
    attempted: cases.length,
    unqualifiedPairs: cases.length - failures.length,
    qualifiedPairs: 0,
    rejectedInvalidInputs: protocol,
    responseGuards: guards,
    nativeEvidence,
    qualifiedNativeEvidence: {},
    failures,
    cases,
  };
  fs.writeFileSync(reportFile, `${JSON.stringify(result, null, 2)}\n`);
  console.log(
    JSON.stringify({
      passed: result.passed,
      attempted: result.attempted,
      protocol,
      guards,
      failures: failures.map((f) => ({
        ...f,
        message: f.message.slice(0, 300),
      })),
    }),
  );
  assert.deepEqual(failures, []);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
