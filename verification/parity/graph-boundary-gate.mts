import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { runBoundaryGate } from "../../packages/code-graph/src/boundaries/gate.js";
import { resolveBoundaryRules } from "../../packages/code-graph/src/config.js";
import {
  SHAPE_FILES,
  SHAPE_RULES,
} from "../../packages/code-graph/src/test-helpers/shop-shape.js";

const binary = z.string().min(1).parse(process.argv[2]);
assert.equal(process.version, "v22.21.1");
assert.equal(process.versions.v8, "12.4.254.21-node.33");
const gateInput = z
  .object({
    rootAbsolute: z.string(),
    repoRoot: z.string(),
    boundaryRulesFile: z.string().optional(),
    ci: z.boolean(),
    writeCeilings: z.boolean(),
    acceptCrossings: z.boolean(),
    reason: z.string().optional(),
    migrateCeilings: z.boolean(),
    json: z.boolean(),
    pretty: z.boolean(),
  })
  .strict();
const requestSchema = z.discriminatedUnion("operation", [
  z
    .object({
      id: z.string(),
      operation: z.literal("code_graph.boundary_rule_config"),
      input: z.object({ file: z.string().optional() }).strict(),
    })
    .strict(),
  z
    .object({
      id: z.string(),
      operation: z.literal("code_graph.boundary_gate"),
      input: gateInput,
    })
    .strict(),
]);
type Request = z.infer<typeof requestSchema>;
const responseSchema = z
  .object({
    id: z.string().nullable(),
    ok: z.boolean(),
    output: z.unknown().optional(),
    error: z
      .object({
        kind: z.string(),
        name: z.string(),
        message: z.string(),
        ioKind: z.string().optional(),
      })
      .strict()
      .optional(),
    observedCalls: z.array(z.string()),
  })
  .strict();
type Answer = z.infer<typeof responseSchema>;
function ioKind(code: string): string {
  switch (code) {
    case "ENOENT":
      return "not-found";
    case "ENOTDIR":
      return "not-a-directory";
    case "EACCES":
    case "EPERM":
      return "permission-denied";
    case "EINVAL":
    case "ERR_INVALID_ARG_VALUE":
      return "invalid-input";
    default:
      return "other-io";
  }
}
function reference(item: Request) {
  try {
    const reports: string[] = [];
    if (item.operation === "code_graph.boundary_rule_config")
      return {
        ok: true,
        output: {
          rules: resolveBoundaryRules(item.input.file, (message) =>
            reports.push(message),
          ),
          reports,
        },
      };
    const emitted: string[] = [];
    const exitCode = runBoundaryGate({
      ...item.input,
      boundaryRulesFile: item.input.boundaryRulesFile,
      reason: item.input.reason,
      report: (message) => reports.push(message),
      emit: (payload) => emitted.push(payload),
    });
    return { ok: true, output: { exitCode, emitted, reports } };
  } catch (error) {
    assert.ok(error instanceof Error);
    const code = z.object({ code: z.string().optional() }).parse(error).code;
    return {
      ok: false,
      error: {
        kind: code ? "io-error" : "thrown",
        name: error.name,
        message: error.message,
        ...(code ? { ioKind: ioKind(code) } : {}),
      },
    };
  }
}
function native(item: Request): Answer {
  const child = spawnSync(binary, [], {
    input: `${JSON.stringify(item)}\n`,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stderr, "");
  const answer = responseSchema.parse(JSON.parse(child.stdout));
  assert.equal(answer.id, item.id);
  assert.ok(
    answer.observedCalls.includes(
      item.operation === "code_graph.boundary_gate"
        ? "run_boundary_gate"
        : "resolve_boundary_rules",
    ),
    item.id,
  );
  return answer;
}
function comparable(answer: ReturnType<typeof reference> | Answer) {
  if (answer.ok) return { ok: true, output: answer.output };
  const error = answer.error;
  assert.ok(error);
  return {
    ok: false,
    error: {
      ...error,
      ...(error.kind === "io-error"
        ? { message: "<backend IO diagnostic>" }
        : {}),
    },
  };
}
const scratch = fs.mkdtempSync(
  path.join(os.tmpdir(), "demlik-boundary-gate-parity-"),
);
const root = path.join(scratch, "repo"),
  rulesFile = path.join(root, "rules.json");
const ledger = "boundary-ledger.json",
  legacy = "boundary-ceilings.json";
type Files = Record<string, string | Buffer>;
type Action =
  | { run: Request }
  | { put: string; body: string | Buffer }
  | { remove: string }
  | { chmod: string; mode: number };
type Scenario = { id: string; files: Files; actions: Action[] };
const scenarios: Scenario[] = [];
function write(file: string, body: string | Buffer) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}
function gate(
  id: string,
  patch: Partial<z.infer<typeof gateInput>> = {},
): Request {
  return requestSchema.parse({
    id,
    operation: "code_graph.boundary_gate",
    input: {
      rootAbsolute: root,
      repoRoot: root,
      boundaryRulesFile: rulesFile,
      ci: false,
      writeCeilings: false,
      acceptCrossings: false,
      migrateCeilings: false,
      json: false,
      pretty: false,
      ...patch,
    },
  });
}
function config(id: string, file: string | undefined): Request {
  return requestSchema.parse({
    id,
    operation: "code_graph.boundary_rule_config",
    input: { file },
  });
}
const minimalRules = {
  features: { "services/other": ["billing"], "services/api": ["orders"] },
};
const minimalFiles: Files = {
  "package.json": "{}",
  "rules.json": JSON.stringify(minimalRules),
};
for (const [scope, feature] of [
  ["services/api", "orders"],
  ["services/other", "billing"],
]) {
  minimalFiles[`${scope}/package.json`] = "{}";
  minimalFiles[`${scope}/tsconfig.json`] =
    '{"compilerOptions":{"module":"esnext","moduleResolution":"bundler"},"include":["src/**/*.ts"]}';
  minimalFiles[`${scope}/src/${feature}/adapters/driven/store.ts`] =
    "export const read=()=>1;";
  minimalFiles[`${scope}/src/${feature}/application/run.ts`] =
    "import {read} from '../adapters/driven/store';export const run=()=>{fetch('/');return read();};";
}
function add(id: string, actions: Action[], files: Files = minimalFiles) {
  scenarios.push({ id, actions, files });
}
function single(id: string, request: Request, files: Files = minimalFiles) {
  add(id, [{ run: request }], files);
}
function snapshot() {
  const files: Record<string, { kind: string; body?: string; mode: number }> =
    {};
  function walk(directory: string) {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name),
        relative = path.relative(root, absolute),
        stat = fs.lstatSync(absolute);
      if (stat.isDirectory()) walk(absolute);
      else
        files[relative] = {
          kind: stat.isSymbolicLink() ? "symlink" : "file",
          body: stat.isSymbolicLink()
            ? fs.readlinkSync(absolute)
            : fs.readFileSync(absolute).toString("base64"),
          mode: stat.mode & 0o777,
        };
    }
  }
  walk(root);
  return files;
}
function prepare(files: Files) {
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root);
  for (const [file, body] of Object.entries(files))
    write(path.join(root, file), body);
}
function execute(scenario: Scenario, isNative: boolean) {
  prepare(scenario.files);
  const outputs: unknown[] = [],
    calls: string[] = [],
    backendDiagnostics: unknown[] = [];
  for (const action of scenario.actions) {
    if ("run" in action) {
      const answer = isNative ? native(action.run) : reference(action.run);
      if ("observedCalls" in answer) calls.push(...answer.observedCalls);
      if (!answer.ok && answer.error?.kind === "io-error")
        backendDiagnostics.push(answer.error);
      outputs.push({ answer: comparable(answer), files: snapshot() });
    } else {
      try {
        if ("put" in action) write(path.join(root, action.put), action.body);
        else if ("chmod" in action)
          fs.chmodSync(path.join(root, action.chmod), action.mode);
        else fs.rmSync(path.join(root, action.remove), { recursive: true });
        outputs.push({ fixtureAction: action, ok: true, files: snapshot() });
      } catch (error) {
        assert.ok(error instanceof Error);
        outputs.push({
          fixtureAction: action,
          error: { name: error.name, message: error.message },
          files: snapshot(),
        });
      }
    }
  }
  return { outputs, calls, backendDiagnostics };
}
try {
  single("config.no-file", config("defaults", undefined), {});
  single("config.missing", config("missing", path.join(root, "absent")), {});
  for (const [name, body] of Object.entries({
    empty: "",
    malformed: "{",
    bom: "\ufeff{}",
    null: "null",
    array: "[]",
    scalar: '"value"',
    defaults: "{}",
    valid: JSON.stringify(minimalRules),
    unknown: '{"extra":1}',
    badFeature: '{"features":{"services/api":[1]}}',
    duplicate:
      '{"features":{"services/api":["orders","orders"]},"libraries":{"missing":"unknown"}}',
    mixedLayout: '{"features":{"services/api":["orders","application"]}}',
    missingLibraryType: '{"libraries":{"packages/a":"missing"}}',
    invalidPattern: '{"testFiles":["{"]}',
    constructorNull:
      '{"features":{"x":[]},"bindingOwners":{"x":{"constructor":null}}}',
    rawPath: '{"features":{"\\ud800":[1]}}',
    invalidBytes: Buffer.from([
      123, 34, 102, 101, 97, 116, 117, 114, 101, 115, 34, 58, 123, 34, 255, 34,
      58, 91, 49, 93, 125, 125,
    ]),
  }))
    single(`config.${name}`, config(name, rulesFile), { "rules.json": body });
  for (let flags = 0; flags < 16; flags++)
    for (const reason of [undefined, " legacy "]) {
      const id = `flags.${flags}.${reason === undefined ? "absent" : "present"}`;
      single(
        id,
        gate(id, {
          ci: !!(flags & 1),
          writeCeilings: !!(flags & 2),
          acceptCrossings: !!(flags & 4),
          migrateCeilings: !!(flags & 8),
          reason,
        }),
        {},
      );
    }
  for (const reason of [
    "",
    " \t\r\n",
    "\ufeff\u2000",
    " \ufefflegacy \ud800\u2000",
    "\u0085",
    "\u200b",
  ]) {
    const id = `reason.${JSON.stringify(reason)}`;
    single(id, gate(id, { acceptCrossings: true, reason }));
  }
  for (const json of [false, true])
    for (const pretty of [false, true]) {
      const format = { json, pretty },
        suffix = `${json}.${pretty}`;
      for (const at of [
        ".",
        "services",
        "services/api",
        "services/api/src",
        "unrelated",
      ]) {
        const id = `report.${suffix}.${at}`;
        single(id, gate(id, { ...format, rootAbsolute: path.join(root, at) }));
      }
      single(
        `report.default-rules.${suffix}`,
        gate(`no-rules-${suffix}`, { ...format, boundaryRulesFile: undefined }),
      );
      add(`workflow.accept-prune.${suffix}`, [
        { run: gate("report", format) },
        { run: gate("ci-empty", { ...format, ci: true }) },
        {
          run: gate("accept", {
            ...format,
            acceptCrossings: true,
            reason: " \ufefflegacy \ud800\u2000",
          }),
        },
        { chmod: ledger, mode: 0o600 },
        { run: gate("ci-recorded", { ...format, ci: true }) },
        { run: gate("ci-repeat", { ...format, ci: true }) },
        {
          run: gate("accept-repeat", {
            ...format,
            acceptCrossings: true,
            reason: "unchanged",
          }),
        },
        {
          put: "services/api/src/orders/application/run.ts",
          body: "export const run=()=>1;",
        },
        {
          run: gate("narrow-prune", {
            ...format,
            ci: true,
            rootAbsolute: path.join(root, "services/api"),
          }),
        },
        {
          run: gate("narrow-repeat", {
            ...format,
            ci: true,
            rootAbsolute: path.join(root, "services/api"),
          }),
        },
        { run: gate("whole-after-prune", { ...format, ci: true }) },
      ]);
      add(
        `workflow.migrate.${suffix}`,
        [
          { run: gate("migration-required", { ...format, ci: true }) },
          {
            run: gate("refuse-unmeasured-other", {
              ...format,
              migrateCeilings: true,
              rootAbsolute: path.join(root, "services/api"),
            }),
          },
          { put: legacy, body: '{"default":1}' },
          {
            run: gate("migrate-all", {
              ...format,
              migrateCeilings: true,
              rootAbsolute: path.join(root, "services/api"),
            }),
          },
          {
            run: gate("already-migrated", { ...format, migrateCeilings: true }),
          },
          { run: gate("ci-migrated", { ...format, ci: true }) },
        ],
        {
          ...minimalFiles,
          [legacy]: '{"default":0,"scopes":{"services/api":10}}',
        },
      );
      single(
        `migrate.missing.${suffix}`,
        gate(`missing-${suffix}`, { ...format, migrateCeilings: true }),
      );
      single(
        `ledger.invalid.${suffix}`,
        gate(`invalid-ledger-${suffix}`, { ...format, ci: true }),
        { ...minimalFiles, [ledger]: '{"entries":[{}]}' },
      );
      single(
        `shape.actual-fourteen.${suffix}`,
        gate(`shop-${suffix}`, format),
        { ...SHAPE_FILES, "rules.json": JSON.stringify(SHAPE_RULES) },
      );
    }
  for (const [id, patch] of Object.entries({
    bindingOwner: {
      acrossDeployables: ["binding-outside-driven-adapter"],
      bindingOwners: { "services/api": { DB: ["src/missing.ts"] } },
    },
    unknownDriven: {
      readAllowance: {
        "services/api": { driven: ["src/orders/adapters/driven/missing.ts"] },
      },
    },
    unlistedPort: { features: { "services/api": ["orders"] } },
    invalidWorker: { acrossDeployables: ["binding-outside-driven-adapter"] },
    workerCycleOnly: { features: {}, acrossDeployables: ["worker-call-cycle"] },
  }))
    single(`refusal.${id}`, gate(id), {
      ...minimalFiles,
      "rules.json": JSON.stringify({ ...minimalRules, ...patch }),
      ...(id === "unlistedPort"
        ? { "services/api/src/driving-adapters/http.ts": "export{};" }
        : {}),
      ...(id === "invalidWorker"
        ? { "services/api/wrangler.jsonc": "{broken" }
        : id === "bindingOwner"
          ? {
              "services/api/wrangler.jsonc":
                '{"name":"api","d1_databases":[{"binding":"DB"}]}',
            }
          : {}),
    });
  for (const name of ["toString", "constructor", "__proto__"]) {
    const files = {
      ...minimalFiles,
      "rules.json": JSON.stringify({ libraryRoots: [name] }),
      [`${name}/tsconfig.json`]: '{"include":["src/**/*.ts"]}',
      [`${name}/src/driving-adapters/a.ts`]: "export{};",
    };
    single(
      `inherited.feature-folders.${name}`,
      gate(`inherited-${name}`),
      files,
    );
    single(
      `inherited.feature-folders.non-port.${name}`,
      gate(`inherited-non-port-${name}`),
      {
        ...minimalFiles,
        "rules.json": JSON.stringify({ libraryRoots: [name] }),
        [`${name}/tsconfig.json`]: '{"include":["src/**/*.ts"]}',
        [`${name}/src/lib/a.ts`]: "export{};",
      },
    );
  }
  single("refusal.raw-scope-root", gate("raw-scope-root"), {
    "rules.json": JSON.stringify({
      features: { "services/\ud800": ["orders"] },
    }),
    "services/\ufffd/src/orders/application/run.ts":
      "export const run=()=>fetch('/');",
  });
  single("config.directory", config("directory", rulesFile), {
    "rules.json/keep": "unchanged",
  });
  single("ledger.directory", gate("ledger-directory", { ci: true }), {
    ...minimalFiles,
    [`${ledger}/keep`]: "unchanged",
  });
  single(
    "migration.legacy-directory",
    gate("legacy-directory", { migrateCeilings: true }),
    { ...minimalFiles, [`${legacy}/keep`]: "unchanged" },
  );
  add("workflow.readonly-ledger", [
    { run: gate("seed", { acceptCrossings: true, reason: "legacy" }) },
    { chmod: ledger, mode: 0o444 },
    {
      put: "services/api/src/orders/application/run.ts",
      body: "export const run=()=>1;",
    },
    {
      run: gate("readonly-prune", {
        ci: true,
        rootAbsolute: path.join(root, "services/api"),
      }),
    },
    { chmod: ledger, mode: 0o644 },
    {
      run: gate("writable-prune", {
        ci: true,
        rootAbsolute: path.join(root, "services/api"),
      }),
    },
  ]);
  const workerFiles: Files = {
    "package.json": "{}",
    "rules.json": JSON.stringify({ acrossDeployables: ["worker-call-cycle"] }),
  };
  for (const [name, target] of [
    ["a", "b"],
    ["b", "a"],
  ]) {
    workerFiles[`services/${name}/package.json`] = "{}";
    workerFiles[`services/${name}/wrangler.jsonc`] = JSON.stringify({
      name,
      main: "src/main.ts",
      services: [
        { binding: "OTHER", service: target },
        ...(name === "a" ? [{ binding: "MISSING", service: "outside" }] : []),
      ],
    });
    workerFiles[`services/${name}/src/main.ts`] = "export const main=1;";
  }
  for (const json of [false, true])
    for (const pretty of [false, true])
      for (const at of [".", "services", "services/a"]) {
        const id = `workers.${json}.${pretty}.${at}`;
        single(
          id,
          gate(id, { json, pretty, rootAbsolute: path.join(root, at) }),
          workerFiles,
        );
      }
  assert.equal(new Set(scenarios.map((s) => s.id)).size, scenarios.length);
  const answers: unknown[] = [],
    failures: unknown[] = [],
    backendDiagnostics: unknown[] = [];
  let steps = 0;
  for (const scenario of scenarios) {
    const expected = execute(scenario, false),
      actual = execute(scenario, true);
    steps += actual.outputs.length;
    backendDiagnostics.push({
      id: scenario.id,
      reference: expected.backendDiagnostics,
      native: actual.backendDiagnostics,
    });
    try {
      assert.deepEqual(actual.outputs, expected.outputs);
    } catch (error) {
      failures.push({
        id: scenario.id,
        message: String(error),
        reference: expected.outputs,
        native: actual.outputs,
      });
    }
    answers.push({
      id: scenario.id,
      ok: true,
      output: actual.outputs,
      observedCalls: [...new Set(actual.calls)],
    });
  }
  const invalid = [
    {},
    { id: "unknown", operation: "nope", input: {} },
    { id: "missing", operation: "code_graph.boundary_gate", input: {} },
    {
      id: "null-file",
      operation: "code_graph.boundary_rule_config",
      input: { file: null },
    },
    {
      id: "extra",
      operation: "code_graph.boundary_rule_config",
      input: { extra: true },
    },
  ];
  for (const item of invalid) {
    assert.equal(requestSchema.safeParse(item).success, false);
    const child = spawnSync(binary, [], {
      input: `${JSON.stringify(item)}\n`,
      encoding: "utf8",
    });
    assert.equal(child.status, 0, child.stderr);
    const answer = responseSchema.parse(JSON.parse(child.stdout));
    assert.equal(answer.ok, false);
    assert.equal(answer.error?.kind, "driver-error");
    assert.equal(answer.observedCalls.length, 0);
    answers.push(answer);
  }
  const report = {
    reference:
      "frozen @demlik/code-graph boundary gate and source shop fixture",
    passed: scenarios.length - failures.length,
    attempted: scenarios.length,
    rejectedInvalidInputs: invalid.length,
    steps,
    failures,
    cases: answers,
    backendDiagnostics: backendDiagnostics.filter((item) =>
      JSON.stringify(item).includes("io-error"),
    ),
    qualifications: [
      "Exact domain reports, stdout, exit codes, file bytes and file permission bits are paired after every action. Native OS error wording is retained separately; IO categories are compared.",
    ],
  };
  if (process.argv[3])
    fs.writeFileSync(process.argv[3], `${JSON.stringify(report, null, 2)}\n`);
  assert.equal(failures.length, 0, JSON.stringify(failures.slice(0, 2)));
  console.log(
    JSON.stringify({
      passed: report.passed,
      steps,
      rejectedInvalidInputs: invalid.length,
    }),
  );
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
