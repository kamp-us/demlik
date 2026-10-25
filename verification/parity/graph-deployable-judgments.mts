import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  bindingOwnerIssue,
  bindingSitesOf,
  bindingViolations,
} from "../../packages/code-graph/src/boundaries/deployables/bindings.js";
import {
  deployableCensus,
  deployableCensusLines,
} from "../../packages/code-graph/src/boundaries/deployables/census.js";
import {
  isWorkerMain,
  readDeployables,
  workerOf,
} from "../../packages/code-graph/src/boundaries/deployables/deployables.js";
import { judgeDeployables } from "../../packages/code-graph/src/boundaries/deployables/judge.js";
import { BoundaryRulesSchema } from "../../packages/code-graph/src/boundaries/rules.js";
import { loadBindingCatalog } from "../../packages/code-graph/src/extract/wrangler-config.js";
import { importLiterals } from "../../packages/code-graph/src/syntax/imports.js";
import { sourceUnit } from "../../packages/code-graph/src/test-helpers/source-unit.js";

const binary = process.argv[2];
assert.ok(binary, "provide the compiled deployables driver");
assert.equal(process.version, "v22.21.1");
assert.equal(process.versions.v8, "12.4.254.21-node.33");
const strings = z.array(z.string());
const fileSchema = z
  .object({
    scope: z.string(),
    file: z.string(),
    from: z.string(),
    source: z.string(),
    driven: z.boolean(),
    isMain: z.boolean().optional(),
    owners: z.array(z.tuple([z.string(), strings])),
    ownerFiles: strings,
  })
  .strict();
const inputSchema = z
  .object({
    repoRoot: z.string(),
    rules: z.unknown(),
    listing: strings.optional(),
    catalogFiles: strings.optional(),
    files: z.array(fileSchema),
  })
  .strict();
type Input = z.infer<typeof inputSchema>;
type File = z.infer<typeof fileSchema>;
const directory = fs.mkdtempSync(
  path.join(tmpdir(), "demlik-deployable-judgments-"),
);
try {
  const repo = path.join(directory, "repo");
  const manifests: Record<string, unknown> = {
    "services/a/wrangler.jsonc": {
      name: "a",
      main: "src/main.ts",
      services: [
        { binding: "API", service: "b" },
        { binding: "OUT", service: "outside" },
      ],
      durable_objects: { bindings: [{ name: "ROOM", class_name: "Room" }] },
      workflows: [{ binding: "FLOW", class_name: "Run" }],
      d1_databases: [
        { binding: "DB" },
        { binding: "10" },
        { binding: "2" },
        { binding: "toString" },
        { binding: "constructor" },
      ],
      kv_namespaces: [{ binding: "KV" }],
      r2_buckets: [{ binding: "R2" }],
      queues: { producers: [{ binding: "QUEUE" }] },
    },
    "services/b/wrangler.json": {
      name: "b",
      main: "src/main.ts",
      services: [{ binding: "API", service: "a" }],
      d1_databases: [{ binding: "DB" }],
    },
    "services/a/nested/wrangler.json": {
      name: "nested",
      d1_databases: [{ binding: "NEST" }],
    },
    "services/�/wrangler.json": {
      name: "replacement",
      d1_databases: [{ binding: "DB" }],
    },
    "wrangler.json": { name: "root", d1_databases: [{ binding: "ROOT" }] },
  };
  const catalogFiles = Object.keys(manifests).filter(
    (file) => file !== "wrangler.json",
  );
  for (const [file, value] of Object.entries(manifests)) {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    fs.writeFileSync(
      path.join(repo, file),
      `// shared fixture\n${JSON.stringify(value)}`,
    );
  }
  for (const dir of [
    "",
    "services/a",
    "services/b",
    "services/a/nested",
    "packages/util",
  ]) {
    fs.mkdirSync(path.join(repo, dir), { recursive: true });
    fs.writeFileSync(
      path.join(repo, dir, "package.json"),
      JSON.stringify({ name: dir || "root" }),
    );
  }
  fs.mkdirSync(path.join(repo, "broken"));
  fs.writeFileSync(path.join(repo, "broken/wrangler.json"), "{");
  const source =
    "import type {B} from '../../b/src/a'; import {C} from '../../b/src/b'; env.DB.prepare('select 1'); env.API.fetch('/'); env.ROOM.get('key'); env.FLOW.create(); env.KV.get('key'); env.R2.get('key'); env.QUEUE.send(1);";
  const file = (scope: string, rel: string, patch: Partial<File> = {}): File =>
    fileSchema.parse({
      scope,
      file: rel,
      from: `${scope}/${rel}`,
      source,
      driven: false,
      owners: [],
      ownerFiles: [rel],
      ...patch,
    });
  const baseFiles = [
    file("services/a", "src/main.ts"),
    file("services/a", "src/application/read.ts"),
    file("services/a", "src/driven/db.ts", { driven: true }),
    file("services/b", "src/main.ts"),
    file("services/a/nested", "src/a.ts", {
      source: "env.DB.prepare('x'); env.NEST.prepare('x');",
    }),
    file("unknown", "src/a.ts"),
  ];
  const allKinds = [
    "binding-outside-driven-adapter",
    "worker-call-cycle",
    "relative-import-crosses-workspace",
  ];
  const cases: {
    id: string;
    operation: "code_graph.deployable-judgment";
    input: Input;
  }[] = [];
  const add = (id: string, patch: Partial<Input> = {}) =>
    cases.push({
      id,
      operation: "code_graph.deployable-judgment",
      input: inputSchema.parse({
        repoRoot: repo,
        rules: { acrossDeployables: allKinds },
        catalogFiles,
        files: baseFiles,
        ...patch,
      }),
    });
  add("deployables.all-kinds-main-and-nested");
  for (let mask = 0; mask < 8; mask++)
    add(`deployables.flag-set-${mask}`, {
      rules: {
        acrossDeployables: allKinds.filter((_, index) => mask & (1 << index)),
      },
    });
  add("deployables.kind-order-and-duplicates", {
    rules: {
      acrossDeployables: [allKinds[2], allKinds[0], allKinds[2], allKinds[1]],
    },
  });
  add("deployables.no-kinds-missing-repo", {
    repoRoot: path.join(directory, "missing"),
    rules: {},
  });
  for (const kinds of [
    allKinds,
    [allKinds[0]],
    [allKinds[1]],
    [allKinds[2]],
    [],
  ])
    add(`deployables.broken-config-${JSON.stringify(kinds)}`, {
      rules: { acrossDeployables: kinds },
      catalogFiles: [...catalogFiles, "broken/wrangler.json"],
    });
  add("deployables.empty-workspace-listing", { listing: [] });
  add("deployables.reverse-workspace-listing", {
    listing: [
      "packages/util/package.json",
      "services/b/package.json",
      "services/a/package.json",
      "package.json",
    ],
  });
  add("deployables.empty-catalog", { catalogFiles: [] });
  add("deployables.root-worker-fallback", {
    catalogFiles: [...catalogFiles, "wrangler.json"],
    files: [
      file("unknown", "a.ts", { source: "env.ROOT.get('key');" }),
      file("services/a", "src/a.ts"),
    ],
  });
  add("deployables.raw-file-does-not-match-replacement-dir", {
    files: [
      file("services/\ud800", "a.ts", { source: "env.DB.prepare('x');" }),
      file("services/�", "a.ts", { source: "env.DB.prepare('x');" }),
    ],
  });
  add("deployables.main-fact-override", {
    files: [
      file("services/a", "src/driven/db.ts", {
        isMain: true,
        owners: [["DB", ["elsewhere.ts"]]],
      }),
    ],
  });
  for (const [id, driven, owners] of [
    ["unlisted", true, []],
    ["listed", true, [["DB", ["src/driven/db.ts"]]]],
    ["narrowed", true, [["DB", ["src/other.ts"]]]],
    [
      "owner-does-not-exempt-application",
      false,
      [["DB", ["src/driven/db.ts"]]],
    ],
    ["unknown-file", true, [["DB", ["missing.ts"]]]],
    ["no-worker", true, [["DB", ["src/driven/db.ts"]]]],
    ["undeclared-binding", true, [["UNKNOWN", ["src/driven/db.ts"]]]],
    ["workflow-not-judged", true, [["FLOW", ["src/driven/db.ts"]]]],
  ] as const)
    add(`deployables.owner-${id}`, {
      files: [
        file(
          id === "no-worker" ? "outside" : "services/a",
          "src/driven/db.ts",
          {
            source: "env.DB.prepare('x'); env.DB.prepare('again');",
            driven,
            owners: owners.map(([binding, paths]) => [binding, [...paths]]),
          },
        ),
      ],
    });
  add("deployables.owner-root-scope-path", {
    catalogFiles: [...catalogFiles, "wrangler.json"],
    files: [
      file(".", "services/a/src/a.ts", {
        from: "services/a/src/a.ts",
        source: "env.DB.prepare('x');",
        owners: [["DB", ["services/a/src/a.ts"]]],
        ownerFiles: ["services/a/src/a.ts"],
      }),
    ],
  });
  for (const [index, source] of [
    "const db=env.DB; db.prepare('x'); db.prepare('y');",
    "const {DB:db,KV}=env; db.prepare('x'); KV.get('a');",
    "const first=env.DB; const second=first; second.prepare('x');",
    "function f(env:Unknown){env.DB.prepare('x');} env.DB.prepare('x');",
    "this.env.DB.prepare('x'); c.env.KV.get('a');",
    "env['10'].prepare('x'); env['2'].prepare('x'); env['10'].prepare('again');",
    "env.toString.prepare('x');",
    "env.constructor.prepare('x');",
    "env.FLOW.create(); env.UNKNOWN.get('x');",
    "import type {B} from '../../b/src/a'; import type {C} from '../../b/src/b';",
    "import {B} from '../../b/src/a'; import type {C} from '../../b/src/b';",
    "import {U} from '../../../packages/util'; import {V} from '../../../packages/util/missing';",
    "env.DB.prepare('x');\n\nenv.KV.get('a');\nenv.DB.prepare('y');",
  ].entries())
    for (const driven of [false, true])
      add(`deployables.syntax-${index}-${driven}`, {
        files: [file("services/a", "src/driven/db.ts", { source, driven })],
      });
  add("deployables.owned-prototype-bindings", {
    files: [
      file("services/a", "src/driven/db.ts", {
        source: "env.toString.prepare('x'); env.constructor.prepare('x');",
        driven: true,
        owners: [
          ["toString", ["src/driven/db.ts"]],
          ["constructor", ["src/driven/db.ts"]],
        ],
      }),
    ],
  });
  add("deployables.no-files-census", { files: [] });
  assert.equal(new Set(cases.map((item) => item.id)).size, cases.length);
  const checked = (run: () => unknown) => {
    try {
      return run();
    } catch (error) {
      assert.ok(error instanceof Error);
      return { thrown: { name: error.name, message: error.message } };
    }
  };
  const expected = cases.map(({ id, input }) => {
    const catalog = loadBindingCatalog(
      input.repoRoot,
      input.catalogFiles === undefined
        ? undefined
        : { root: input.repoRoot, files: input.catalogFiles },
    );
    const result = readDeployables(
      BoundaryRulesSchema.parse(input.rules),
      input.repoRoot,
      input.listing === undefined
        ? undefined
        : { root: input.repoRoot, files: input.listing },
      catalog,
    );
    if (result.kind === "refused") return { id, ok: true, output: result };
    const deployables = result.deployables;
    const rows: { file: string; line: number; binding: string }[] = [];
    const files = input.files.map((item) => {
      const syntax = sourceUnit(item.source, item.from).syntax;
      const sites = bindingSitesOf(deployables, item.from, syntax),
        isMain = isWorkerMain(deployables, item.from),
        owners = Object.fromEntries(item.owners);
      const facts = {
        scope: item.scope,
        file: item.file,
        from: item.from,
        importEdges: importLiterals(syntax).map(
          ({ specifier, kind, typeOnly }) => ({
            specifier,
            kind,
            typeOnly,
            target: null,
          }),
        ),
        bindingSites: sites,
        driven: item.driven,
        isMain: item.isMain ?? isMain,
        owners,
      };
      rows.push(...sites.map((site) => ({ file: item.from, ...site })));
      return {
        worker: workerOf(deployables, item.from),
        isMain,
        sites,
        direct: checked(() => bindingViolations(facts)),
        judged: checked(() => judgeDeployables(deployables, facts)),
        ownerIssue: bindingOwnerIssue(
          item.scope,
          owners,
          new Set(item.ownerFiles),
          deployables,
        ),
      };
    });
    const census = deployableCensus(deployables, rows);
    return {
      id,
      ok: true,
      output: {
        kind: "read",
        kinds: [...deployables.kinds],
        catalog: deployables.catalog,
        graph: deployables.graph,
        workspaces: [...deployables.workspaces],
        judged: [...deployables.judged].map(([manifest, bindings]) => [
          manifest,
          [...bindings],
        ]),
        files,
        census,
        lines: census === null ? null : deployableCensusLines(census),
      },
    };
  });
  const invalid = [
    "not-json",
    JSON.stringify({ id: "unknown", operation: "other", input: {} }),
    JSON.stringify({
      id: "missing-judgment",
      operation: "code_graph.deployable-judgment",
      input: {},
    }),
  ];
  const run = spawnSync(binary, [], {
    input: `${[...cases.map((item) => JSON.stringify(item)), ...invalid].join("\n")}\n`,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 30000,
  });
  assert.equal(run.status, 0, run.stderr);
  const response = z.object({
    id: z.string().nullable(),
    ok: z.boolean(),
    output: z.unknown().optional(),
    error: z.string().optional(),
    diagnostic: z.string().optional(),
    observedCalls: strings,
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
  const report = {
    reference: { node: process.version, v8: process.versions.v8 },
    passed: cases.length - failures.length,
    attempted: cases.length,
    failures,
    rejectedInvalidInputs: invalid.length,
    cases: answers,
    qualifications: [
      "Deployable reads/judgments consume real shared worker manifests and OXC binding sites. The scope-wide boundary analyzer, shape rules and full gate remain separate.",
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
