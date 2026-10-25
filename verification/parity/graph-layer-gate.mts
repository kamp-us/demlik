import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { resolveLayerRules } from "../../packages/code-graph/src/config.js";
import { runLayerGate } from "../../packages/code-graph/src/layers/gate.js";
import { renderLayers } from "../../packages/code-graph/src/layers/render.js";
import { allowed, report } from "./layer-shapes.mjs";

const binary = z.string().min(1).parse(process.argv[2]);
assert.equal(process.version, "v22.21.1");
assert.equal(process.versions.v8, "12.4.254.21-node.33");
const requestSchema = z.discriminatedUnion("operation", [
  z
    .object({
      id: z.string(),
      operation: z.literal("code_graph.layer_config"),
      input: z.object({ file: z.string().optional() }).strict(),
    })
    .strict(),
  z
    .object({
      id: z.string(),
      operation: z.literal("code_graph.layer_render"),
      input: z
        .object({
          report,
          allowed: z.array(allowed),
          json: z.boolean(),
          pretty: z.boolean(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      id: z.string(),
      operation: z.literal("code_graph.layer_gate"),
      input: z
        .object({
          rootAbsolute: z.string(),
          repoRoot: z.string(),
          layerRulesFile: z.string().optional(),
          json: z.boolean(),
          pretty: z.boolean(),
        })
        .strict(),
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
        message: z.string(),
        ioKind: z.string().optional(),
      })
      .strict()
      .optional(),
    observedCalls: z.array(z.string()),
  })
  .strict();
function ioKind(error: unknown) {
  const { code } = z.object({ code: z.string().optional() }).parse(error);
  return (
    (
      {
        ENOENT: "not-found",
        ENOTDIR: "not-a-directory",
        EACCES: "permission-denied",
        EPERM: "permission-denied",
        EINVAL: "invalid-input",
        ERR_INVALID_ARG_VALUE: "invalid-input",
      } as Record<string, string>
    )[code ?? ""] ?? "other-io"
  );
}
function reference(item: Request) {
  try {
    switch (item.operation) {
      case "code_graph.layer_config": {
        const reports: string[] = [];
        return {
          ok: true,
          output: {
            rules: resolveLayerRules(item.input.file, (message) =>
              reports.push(message),
            ),
            reports,
          },
        };
      }
      case "code_graph.layer_render":
        return {
          ok: true,
          output: renderLayers(
            item.input.report,
            item.input.allowed,
            item.input.json,
            item.input.pretty,
          ),
        };
      case "code_graph.layer_gate": {
        const emitted: string[] = [],
          reports: string[] = [];
        const exitCode = runLayerGate({
          ...item.input,
          layerRulesFile: item.input.layerRulesFile,
          emit: (payload) => emitted.push(payload),
          report: (message) => reports.push(message),
        });
        return { ok: true, output: { exitCode, emitted, reports } };
      }
    }
  } catch (error) {
    return {
      ok: false,
      error: {
        kind: "io-error",
        ioKind: ioKind(error),
        message: String(error),
      },
    };
  }
}
function call(item: Request) {
  const child = spawnSync(binary, [], {
    input: `${JSON.stringify(item)}\n`,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stderr, "");
  const answer = responseSchema.parse(JSON.parse(child.stdout));
  assert.equal(answer.id, item.id);
  assert.ok(answer.observedCalls.length, item.id);
  const owner = {
    "code_graph.layer_config": "resolve_layer_rules",
    "code_graph.layer_render": "render_layers",
    "code_graph.layer_gate": "run_layer_gate",
  }[item.operation];
  assert.ok(answer.observedCalls.includes(owner), item.id);
  return answer;
}
const scratch = fs.mkdtempSync(
  path.join(os.tmpdir(), "demlik-layer-gate-parity-"),
);
type Scenario = { request: Request; prepare?: () => void };
const cases: Scenario[] = [];
function add(
  id: string,
  operation: Request["operation"],
  input: unknown,
  prepare?: () => void,
) {
  cases.push({
    request: requestSchema.parse({ id, operation, input }),
    prepare,
  });
}
function write(file: string, bytes: string | Buffer) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
}
try {
  const root = path.join(scratch, "repo");
  fs.mkdirSync(root);
  write(path.join(root, "src/service.ts"), "export type Service=unknown;");
  write(
    path.join(root, "src/domain/rule.ts"),
    "// first\nimport type { Service } from '../service.js';\nexport const x=1;",
  );
  const stack = [
    { name: "service", paths: ["src"] },
    { name: "domain", paths: ["src/domain"] },
  ];
  const allowance = {
    from: "src/domain/rule.ts",
    to: "src/service.ts",
    sites: 1,
    reason: "pass it in",
  };
  const configs: Record<string, string | Buffer> = {
    valid: JSON.stringify({ layers: stack }),
    pass: JSON.stringify({ layers: stack, allowed: [allowance] }),
    miscounted: JSON.stringify({
      layers: stack,
      allowed: [{ ...allowance, sites: 2 }],
    }),
    stale: JSON.stringify({
      layers: stack,
      allowed: [{ ...allowance, from: "closed", to: "closed" }],
    }),
    duplicateAllowed: JSON.stringify({
      layers: stack,
      allowed: [
        { ...allowance, sites: 2 },
        { ...allowance, sites: 1 },
      ],
    }),
    empty: "",
    whitespace: " \n\t",
    malformed: "{",
    null: "null",
    array: "[]",
    scalar: '"text"',
    defaults: "{}",
    allowedOnly: '{"allowed":[]}',
    explicitEmpty: '{"layers":[]}',
    oneLayer: JSON.stringify({ layers: [stack[0]] }),
    duplicateName: JSON.stringify({
      layers: [stack[0], { ...stack[1], name: "service" }],
    }),
    duplicatePath: JSON.stringify({
      layers: [stack[0], { name: "domain", paths: ["src"] }],
    }),
    duplicateOwnPath: JSON.stringify({
      layers: [{ ...stack[0], paths: ["src", "src"] }, stack[1]],
    }),
    invalidPath: JSON.stringify({
      layers: [{ name: "service", paths: [""] }, stack[1]],
    }),
    invalidReason: JSON.stringify({
      layers: stack,
      allowed: [{ ...allowance, reason: "" }],
    }),
    zeroSites: JSON.stringify({
      layers: stack,
      allowed: [{ ...allowance, sites: 0 }],
    }),
    fractionSites: JSON.stringify({
      layers: stack,
      allowed: [{ ...allowance, sites: 1.5 }],
    }),
    extraTop: JSON.stringify({ layers: stack, ignored: true }),
    extraNested: JSON.stringify({
      layers: [{ ...stack[0], ignored: true }, stack[1]],
    }),
    unknownRawKey: `{"layers":[{"name":"service","paths":["src"],"raw\\ud800":1},{"name":"domain","paths":["src/domain"]}]}`,
    bom: Buffer.from(`\ufeff${JSON.stringify({ layers: stack })}`),
    comments: `// not JSON\n${JSON.stringify({ layers: stack })}`,
    trailingComma: '{"layers":[],}',
    overflow: `{"layers":${JSON.stringify(stack)},"allowed":[{"from":"a","to":"b","sites":1e400,"reason":"why"}]}`,
    nan: `{"layers":${JSON.stringify(stack)},"allowed":[{"from":"a","to":"b","sites":NaN,"reason":"why"}]}`,
    invalidUtf8Name: Buffer.concat([
      Buffer.from('{"layers":[{"name":"'),
      Buffer.from([0xff]),
      Buffer.from(
        '","paths":["src"]},{"name":"domain","paths":["src/domain"]}]}',
      ),
    ]),
    invalidUtf8Outside: Buffer.concat([
      Buffer.from('{"layers":'),
      Buffer.from([0xff]),
      Buffer.from("}"),
    ]),
    invalidUtf8Key: Buffer.concat([
      Buffer.from('{"layers":'),
      Buffer.from(JSON.stringify(stack)),
      Buffer.from(',"'),
      Buffer.from([0xc0, 0xaf]),
      Buffer.from('":1}'),
    ]),
    shortUtf8: Buffer.concat([
      Buffer.from('{"layers":[{"name":"'),
      Buffer.from([0xe2, 0x82]),
      Buffer.from(
        '","paths":["src"]},{"name":"domain","paths":["src/domain"]}]}',
      ),
    ]),
    utf16: JSON.stringify({
      layers: [
        { name: "service\ud800", paths: ["src"] },
        { name: "domain\udfff", paths: ["src/domain"] },
      ],
      allowed: [{ ...allowance, reason: "why\ud800" }],
    }),
    proto: JSON.stringify({
      layers: stack,
      ...JSON.parse('{"__proto__":{},"constructor":null}'),
    }),
    trailingSlash: JSON.stringify({
      layers: [{ name: "service", paths: ["src/"] }, stack[1]],
    }),
  };
  const files = new Map<string, string>();
  for (const [name, contents] of Object.entries(configs)) {
    const file = path.join(scratch, `config-${name}.json`);
    write(file, contents);
    files.set(name, file);
    add(`config-${name}`, "code_graph.layer_config", { file });
    for (const json of [false, true])
      for (const pretty of [false, true])
        add(`gate-${name}-${json}-${pretty}`, "code_graph.layer_gate", {
          rootAbsolute: root,
          repoRoot: root,
          layerRulesFile: file,
          json,
          pretty,
        });
  }
  add("config-no-file", "code_graph.layer_config", {});
  for (const [name, file] of [
    ["missing", path.join(scratch, "missing.json")],
    ["directory", root],
    ["not-a-directory", path.join(root, "src/service.ts/no.json")],
    ["nul", path.join(scratch, "bad\0.json")],
    ["quotes", path.join(scratch, 'bad"name.json')],
  ] as const) {
    add(`config-${name}`, "code_graph.layer_config", { file });
    add(`gate-${name}`, "code_graph.layer_gate", {
      rootAbsolute: root,
      repoRoot: root,
      layerRulesFile: file,
      json: true,
      pretty: true,
    });
  }
  for (const [name, file] of [
    ["raw-path", path.join(scratch, "raw-\ud800.json")],
    ["raw-issue", path.join(scratch, "raw-issue-\udfff.json")],
  ] as const) {
    write(file, name === "raw-path" ? "{" : JSON.stringify({ layers: [] }));
    add(`config-${name}`, "code_graph.layer_config", { file });
    add(`gate-${name}`, "code_graph.layer_gate", {
      rootAbsolute: root,
      repoRoot: root,
      layerRulesFile: file,
      json: false,
      pretty: false,
    });
  }
  for (const json of [false, true])
    for (const pretty of [false, true])
      add(`gate-no-file-${json}-${pretty}`, "code_graph.layer_gate", {
        rootAbsolute: root,
        repoRoot: root,
        json,
        pretty,
      });
  const empty = path.join(scratch, "empty");
  fs.mkdirSync(empty);
  write(path.join(empty, "invalid.ts"), "export const broken = ;");
  add("gate-only-parse-failures", "code_graph.layer_gate", {
    rootAbsolute: empty,
    repoRoot: empty,
    layerRulesFile: files.get("valid"),
    json: true,
    pretty: false,
  });
  const unresolved = path.join(scratch, "unresolved");
  write(
    path.join(unresolved, "src/domain/rule.ts"),
    "import missing from './missing.js';\nexport const x=missing;",
  );
  add(
    "gate-unresolved-is-observed-without-new-exit-policy",
    "code_graph.layer_gate",
    {
      rootAbsolute: unresolved,
      repoRoot: unresolved,
      layerRulesFile: files.get("valid"),
      json: false,
      pretty: false,
    },
  );
  const tie = path.join(scratch, "tie");
  write(path.join(tie, "src/billing-plumbing.ts"), "export const value=1;");
  const tieFile = path.join(scratch, "tie-rules.json");
  write(
    tieFile,
    JSON.stringify({
      layers: [
        { name: "plumbing", paths: ["**/*-plumbing.ts"] },
        { name: "billing", paths: ["**/billing-p*.ts"] },
      ],
    }),
  );
  for (const json of [false, true])
    for (const pretty of [false, true])
      add(`gate-tie-${json}-${pretty}`, "code_graph.layer_gate", {
        rootAbsolute: tie,
        repoRoot: tie,
        layerRulesFile: tieFile,
        json,
        pretty,
      });
  const badRoot = path.join(scratch, "not-created");
  add("no-stack-refusal-precedes-root-io", "code_graph.layer_gate", {
    rootAbsolute: badRoot,
    repoRoot: badRoot,
    json: true,
    pretty: true,
  });
  add("invalid-config-refusal-precedes-root-io", "code_graph.layer_gate", {
    rootAbsolute: badRoot,
    repoRoot: badRoot,
    layerRulesFile: files.get("malformed"),
    json: true,
    pretty: true,
  });
  add("valid-config-keeps-missing-root-error", "code_graph.layer_gate", {
    rootAbsolute: badRoot,
    repoRoot: badRoot,
    layerRulesFile: files.get("valid"),
    json: true,
    pretty: true,
  });
  const mutable = path.join(scratch, "mutable.json");
  add(
    "fresh-read-between-calls-valid",
    "code_graph.layer_config",
    { file: mutable },
    () => write(mutable, configs.valid),
  );
  add(
    "fresh-read-between-calls-refused",
    "code_graph.layer_config",
    { file: mutable },
    () => write(mutable, "{"),
  );
  const makeEdge = (
    from: string,
    to: string,
    line: number,
    typeOnly = false,
  ) => ({
    from,
    to,
    fromLine: line,
    fromLayer: "domain",
    toLine: 1,
    toLayer: "service",
    specifier: '../target"\ud800',
    typeOnly,
  });
  const a = makeEdge("a", "target", 3),
    b = makeEdge("b", "other", 4, true),
    raw = makeEdge("raw\ud800", "to\udfff", 9, true);
  const makeReport = (violations: (typeof a)[], unresolved: string[] = []) => ({
    layers: ["service\ud800", "domain"],
    filesScanned: 5,
    census: {
      down: 2,
      sideways: 1,
      up: violations.length,
      unlayered: 1,
      external: 2,
      unresolved: unresolved.length,
    },
    violations,
    unresolved,
  });
  const allow = (from: string, to: string, sites: number, reason = "why") => ({
    from,
    to,
    sites,
    reason,
  });
  const renderCases = [
    { name: "empty", report: makeReport([]), allowed: [] },
    { name: "undeclared", report: makeReport([a, b]), allowed: [] },
    {
      name: "pass",
      report: makeReport([a, b]),
      allowed: [allow("a", "target", 1), allow("b", "other", 1)],
    },
    {
      name: "mixed",
      report: makeReport(
        [a, a, b, raw],
        ["source:2 ./gone", "raw\ud800:3 missing"],
      ),
      allowed: [
        allow("a", "target", 1),
        allow("closed", "stale", 2, "reason\ud800"),
      ],
    },
    {
      name: "shrunk",
      report: makeReport([a]),
      allowed: [allow("a", "target", 2)],
    },
    {
      name: "grew",
      report: makeReport([a, a]),
      allowed: [allow("a", "target", 1)],
    },
    {
      name: "duplicate",
      report: makeReport([a]),
      allowed: [
        allow("a", "target", 2, "first"),
        allow("a", "target", 1, "last"),
      ],
    },
    {
      name: "duplicate-stale",
      report: makeReport([]),
      allowed: [
        allow("closed", "stale", 1, "first"),
        allow("closed", "stale", 2, "last"),
      ],
    },
    {
      name: "raw-pass",
      report: makeReport([raw]),
      allowed: [allow(raw.from, raw.to, 1)],
    },
    {
      name: "large-counts",
      report: {
        ...makeReport([a]),
        filesScanned: 9007199254740991,
        census: {
          down: 9007199254740991,
          sideways: 0,
          up: 1,
          unlayered: 0,
          external: 0,
          unresolved: 0,
        },
      },
      allowed: [allow("a", "target", 9007199254740991)],
    },
  ];
  for (const item of renderCases)
    for (const json of [false, true])
      for (const pretty of [false, true])
        add(
          `render-${item.name}-${json}-${pretty}`,
          "code_graph.layer_render",
          { report: item.report, allowed: item.allowed, json, pretty },
        );
  const answers: z.infer<typeof responseSchema>[] = [];
  let failures = 0;
  for (const item of cases) {
    item.prepare?.();
    const source = reference(item.request);
    item.prepare?.();
    const answer = call(item.request);
    try {
      assert.equal(answer.ok, source.ok, item.request.id);
      if (source.ok)
        assert.deepEqual(answer.output, source.output, item.request.id);
      else {
        assert.equal(answer.error?.kind, source.error?.kind);
        assert.equal(answer.error?.ioKind, source.error?.ioKind);
        assert.ok(answer.error?.message);
      }
    } catch (error) {
      failures++;
      console.error(`${item.request.id}: ${String(error)}`);
    }
    answers.push(answer);
  }
  const byId = (id: string) =>
    answers[cases.findIndex((item) => item.request.id === id)];
  const gateOutput = z.object({
    exitCode: z.number(),
    emitted: z.array(z.string()),
    reports: z.array(z.string()),
  });
  assert.equal(
    gateOutput.parse(byId("gate-pass-true-true").output).exitCode,
    0,
  );
  assert.equal(
    gateOutput.parse(byId("gate-valid-false-false").output).exitCode,
    1,
  );
  assert.equal(gateOutput.parse(byId("gate-tie-true-true").output).exitCode, 2);
  assert.equal(
    gateOutput.parse(
      byId("gate-unresolved-is-observed-without-new-exit-policy").output,
    ).exitCode,
    0,
  );
  assert.ok(
    gateOutput
      .parse(byId("gate-unresolved-is-observed-without-new-exit-policy").output)
      .emitted[0].includes("UNRESOLVED"),
  );
  assert.equal(gateOutput.parse(byId("gate-bom-true-true").output).exitCode, 2);
  const invalid = [
    "not json",
    JSON.stringify({ id: "unsupported", operation: "ignored", input: {} }),
    JSON.stringify({
      id: "null-file",
      operation: "code_graph.layer_config",
      input: { file: null },
    }),
    JSON.stringify({
      id: "wrong-file",
      operation: "code_graph.layer_config",
      input: { file: 4 },
    }),
    JSON.stringify({
      id: "extra-config",
      operation: "code_graph.layer_config",
      input: { ignored: true },
    }),
    JSON.stringify({
      id: "null-gate-file",
      operation: "code_graph.layer_gate",
      input: {
        rootAbsolute: root,
        repoRoot: root,
        layerRulesFile: null,
        json: true,
        pretty: false,
      },
    }),
    JSON.stringify({
      id: "wrong-flag",
      operation: "code_graph.layer_gate",
      input: { rootAbsolute: root, repoRoot: root, json: "yes", pretty: false },
    }),
    JSON.stringify({
      id: "missing-root",
      operation: "code_graph.layer_gate",
      input: { json: true, pretty: false },
    }),
    JSON.stringify({
      id: "missing-report",
      operation: "code_graph.layer_render",
      input: { allowed: [], json: true, pretty: false },
    }),
  ];
  const bad = spawnSync(binary, [], {
    input: `${invalid.join("\n")}\n`,
    encoding: "utf8",
  });
  assert.equal(bad.status, 0, bad.stderr);
  assert.equal(bad.stderr, "");
  const rejected = bad.stdout
    .trim()
    .split("\n")
    .map((line) => responseSchema.parse(JSON.parse(line)));
  assert.equal(rejected.length, invalid.length);
  for (const answer of rejected) {
    assert.equal(answer.ok, false);
    assert.equal(answer.error?.kind, "driver-error");
    assert.ok(answer.error.message);
    assert.deepEqual(answer.observedCalls, []);
  }
  const evidence = {
    passed: cases.length - failures,
    failures,
    rejectedInvalidInputs: invalid.length,
    reference: {
      node: process.version,
      v8: process.versions.v8,
      profile:
        "shared actual config bytes/files and typed reports; source-owned strings/JSON/exit/refusal order exact; thrown IO kind plus nonempty native diagnostic",
    },
    configCases: cases.filter(
      (item) => item.request.operation === "code_graph.layer_config",
    ).length,
    renderCases: cases.filter(
      (item) => item.request.operation === "code_graph.layer_render",
    ).length,
    gateCases: cases.filter(
      (item) => item.request.operation === "code_graph.layer_gate",
    ).length,
    nativeApis: [
      ...new Set(answers.flatMap((answer) => answer.observedCalls)),
    ].sort(),
    cases: [...answers, ...rejected],
  };
  if (process.argv[3])
    fs.writeFileSync(process.argv[3], `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify({ ...evidence, cases: undefined }, null, 2));
  assert.equal(failures, 0, "source/native layer gate mismatches");
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
