import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  type WorkerGraph,
  workerCycles,
  workerGraph,
} from "../../packages/code-graph/src/boundaries/deployables/cycles.js";
import {
  crossWorkspaceImports,
  workspaceAt,
} from "../../packages/code-graph/src/boundaries/deployables/workspaces.js";
import { loadBindingCatalog } from "../../packages/code-graph/src/extract/wrangler-config.js";
import type { ImportEdge } from "../../packages/code-graph/src/schema.js";

const binary = process.argv[2];
assert.ok(binary, "provide the compiled deployables driver");
assert.equal(process.version, "v22.21.1");
assert.equal(process.versions.v8, "12.4.254.21-node.33");
type Case =
  | {
      id: string;
      operation: "code_graph.workspaces";
      input: {
        roots: string[];
        targets: string[];
        scope: string;
        from: string;
        edges: ImportEdge[];
      };
    }
  | { id: string; operation: "code_graph.worker-cycles"; input: WorkerGraph }
  | {
      id: string;
      operation: "code_graph.worker-graph";
      input: { repoRoot: string; listing?: string[] };
    };
const cases: Case[] = [];
const directory = fs.mkdtempSync(
  path.join(tmpdir(), "demlik-deployable-paths-"),
);
try {
  const targets = [
    "",
    ".",
    "..",
    "../outside",
    "services/api",
    "services/api/src/x.ts",
    "services/apix/a.ts",
    "packages/shared",
    "packages/shared/sub",
    "packages/\ud800/src/x.ts",
    "/services/api/a",
    "//services/api/a",
    "services/api/../web",
  ];
  const specifiers = [
    "../web/a",
    "../web/b",
    "../web",
    "../web/",
    "../../packages/shared",
    "../../packages/shared/no-such-file",
    "../../../outside",
    "../../../outside/inside",
    "@shop/shared",
    "node:fs",
    "/absolute",
    ".",
    "..",
    ".\\..\\web\\a",
    "..\\web\\b",
    "../\ud800/a",
    "./child",
    ".../no-path",
  ];
  const edges = specifiers.map(
    (specifier, index): ImportEdge => ({
      specifier,
      kind: index % 3 === 0 ? "export-from" : "static",
      typeOnly: index % 2 === 0,
      target: null,
    }),
  );
  const froms = [
    "services/api/index.ts",
    "services/api/src/index.ts",
    "index.ts",
    "a",
    "",
    "/index.ts",
    "//index.ts",
    "//services/api/index.ts",
    "services/api/",
    "services/\ud800/index.ts",
    "../outside/index.ts",
    "services/api/deep/../../index.ts",
  ];
  const rootSets = [
    [],
    ["services/api", "services/web", "packages/shared", "services/\ud800"],
    [".", "services/api", "services/web", "packages/shared"],
    ["", ".", "/", "//", "services/api", "services/api/src"],
  ];
  for (const [index, from] of froms.entries())
    for (const [r, roots] of rootSets.entries())
      cases.push({
        id: `workspace-path-${index}-${r}`,
        operation: "code_graph.workspaces",
        input: { roots, targets, scope: r % 2 ? "." : "scope", from, edges },
      });
  const graph = (
    id: string,
    workers: string[],
    edges: [string, string, string][],
  ) =>
    cases.push({
      id,
      operation: "code_graph.worker-cycles",
      input: {
        workers,
        edges: edges.map(([from, binding, to]) => ({ from, binding, to })),
        unresolved: 0,
      },
    });
  graph("worker-cycles.empty", [], []);
  graph("worker-cycles.self-binding-is-not-cycle", ["a"], [["a", "SELF", "a"]]);
  graph(
    "worker-cycles.ring-with-chord",
    ["c", "b", "a"],
    [
      ["a", "B", "b"],
      ["b", "C", "c"],
      ["c", "A", "a"],
      ["a", "C", "c"],
    ],
  );
  graph(
    "worker-cycles.two-components",
    ["z", "y", "b", "a"],
    [
      ["a", "B", "b"],
      ["b", "A", "a"],
      ["y", "Z", "z"],
      ["z", "Y", "y"],
    ],
  );
  graph(
    "worker-cycles.duplicates-and-unknown",
    ["a", "b", "a"],
    [
      ["a", "B", "b"],
      ["b", "A", "a"],
      ["a", "B", "b"],
      ["unknown", "A", "a"],
      ["a", "EXT", "outside"],
    ],
  );
  graph(
    "worker-cycles.raw-utf16",
    ["\ud800", "😀", "á", "A"],
    [
      ["\ud800", "RAW\udc00", "😀"],
      ["😀", "A", "\ud800"],
      ["A", "ACCENT", "á"],
      ["á", "ASCII", "A"],
    ],
  );
  graph(
    "worker-cycles.prototype-and-numeric",
    ["__proto__", "constructor", "2", "10"],
    [
      ["__proto__", "A", "constructor"],
      ["constructor", "B", "__proto__"],
      ["2", "A", "10"],
      ["10", "B", "2"],
    ],
  );
  for (let seed = 0; seed < 16; seed++) {
    const workers = Array.from(
      { length: 7 },
      (_, i) => `worker${(i + seed) % 7}`,
    );
    const edges: [string, string, string][] = [];
    workers.forEach((from, i) => {
      if ((seed + i) % 3 !== 0)
        edges.push([from, `NEXT${i}`, workers[(i + 1) % 7]]);
      if ((seed + i) % 4 === 0)
        edges.push([from, `JUMP${i}`, workers[(i + 3) % 7]]);
    });
    graph(`worker-cycles.generated-${seed}`, workers, edges);
  }
  for (let seed = 0; seed < 12; seed++) {
    const repo = path.join(directory, `repo${seed}`);
    const listing: string[] = [];
    for (let index = 0; index < 6; index++) {
      const file = `worker${index}/wrangler.jsonc`;
      listing.push(file);
      fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
      const services = [
        { binding: "NEXT", service: `worker${(index + 1) % 6}` },
        { binding: "SELF", service: `worker${index}` },
      ];
      if ((index + seed) % 3 === 0)
        services.push({ binding: "OUTSIDE", service: "outside" });
      if ((index + seed) % 4 === 0)
        services.push({
          binding: "CHORD",
          service: `worker${(index + 2) % 6}`,
        });
      fs.writeFileSync(
        path.join(repo, file),
        JSON.stringify({
          name: `worker${index}`,
          services,
          workflows: [
            { binding: "FLOW", class_name: "Run", script_name: "outside" },
          ],
          durable_objects: {
            bindings: [
              { name: "ROOM", class_name: "Room", script_name: "outside" },
            ],
          },
        }),
      );
    }
    fs.mkdirSync(path.join(repo, "broken"));
    fs.writeFileSync(path.join(repo, "broken/wrangler.json"), "{");
    listing.push("broken/wrangler.json");
    cases.push({
      id: `worker-graph.catalog-${seed}`,
      operation: "code_graph.worker-graph",
      input: {
        repoRoot: repo,
        ...(seed % 2 ? { listing: listing.reverse() } : {}),
      },
    });
  }
  const expected = cases.map((item) => {
    let output: unknown;
    if (item.operation === "code_graph.workspaces") {
      const { roots, scope, from, targets, edges } = item.input;
      const set = new Set(roots);
      output = {
        at: targets.map((target) => workspaceAt(set, target)),
        crossing: crossWorkspaceImports(set, scope, from, edges),
      };
    } else if (item.operation === "code_graph.worker-cycles")
      output = workerCycles(item.input);
    else {
      const { repoRoot, listing } = item.input;
      const catalog = loadBindingCatalog(
        repoRoot,
        listing ? { root: repoRoot, files: listing } : undefined,
      );
      const graph = workerGraph(catalog);
      output = { graph, cycles: workerCycles(graph) };
    }
    return { id: item.id, ok: true, output };
  });
  const invalid = [
    "not-json",
    JSON.stringify({ id: "unknown", operation: "unknown", input: {} }),
    JSON.stringify({
      id: "missing",
      operation: "code_graph.workspaces",
      input: {},
    }),
    JSON.stringify({
      id: "wrong-cycle",
      operation: "code_graph.worker-cycles",
      input: { workers: [], edges: [{ from: 1 }], unresolved: 0 },
    }),
  ];
  const run = spawnSync(binary, [], {
    input: `${[...cases.map((item) => JSON.stringify(item)), ...invalid].join("\n")}\n`,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: 30000,
  });
  assert.equal(run.status, 0, run.stderr);
  const response = z.object({
    id: z.string().nullable(),
    ok: z.boolean(),
    output: z.unknown().optional(),
    error: z.string().optional(),
    diagnostic: z.string().optional(),
    observedCalls: z.array(z.string()),
  });
  const answers = run.stdout
    .trim()
    .split("\n")
    .map((line) => response.parse(JSON.parse(line)));
  assert.equal(answers.length, cases.length + invalid.length);
  const failures: {
    id: string;
    message: string;
    reference: unknown;
    native: unknown;
  }[] = [];
  expected.forEach((reference, index) => {
    try {
      const { observedCalls: _calls, ...actual } = answers[index];
      assert.deepEqual(actual, reference, cases[index].id);
      assert.ok(answers[index].observedCalls.length);
    } catch (error) {
      failures.push({
        id: cases[index].id,
        message: error instanceof Error ? error.message : String(error),
        reference,
        native: answers[index],
      });
    }
  });
  for (const answer of answers.slice(cases.length)) {
    assert.equal(answer.ok, false);
    assert.equal(answer.error, "driver_error");
    assert.ok(answer.diagnostic);
    assert.deepEqual(answer.observedCalls, []);
  }
  const ring = expected.find(
    (item) => item.id === "worker-cycles.ring-with-chord",
  );
  assert.ok(ring);
  assert.deepEqual(ring.output, [
    {
      kind: "worker-call-cycle",
      from: "a, b, c",
      to: null,
      specifier: "a.B -> b; a.C -> c; b.C -> c; c.A -> a",
      typeOnly: false,
    },
  ]);
  const report = {
    reference: { node: process.version, v8: process.versions.v8 },
    passed: cases.length - failures.length,
    attempted: cases.length,
    failures,
    rejectedInvalidInputs: invalid.length,
    cases: answers,
    qualifications: [
      "Workspace crossings read lexical paths without file resolution. Worker graphs read real catalogs and reuse the existing SCC owner. Full deployable reads, binding judgments and scope integration remain separate.",
    ],
  };
  if (process.argv[3])
    fs.writeFileSync(process.argv[3], `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    JSON.stringify(
      {
        ...report,
        cases: undefined,
        failures: failures.map((failure) => ({ id: failure.id })),
      },
      null,
      2,
    ),
  );
  if (failures.length) process.exitCode = 1;
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
