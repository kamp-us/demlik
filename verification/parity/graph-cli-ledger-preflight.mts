import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  type Input,
  InputSchema,
  KINDS,
  reference,
} from "./ledger-preflight-reference.mjs";

const binary = process.argv[2];
assert.ok(binary);
assert.ok(process.argv.length <= 4);
assert.equal(process.version, "v22.21.1");
assert.equal(process.versions.v8, "12.4.254.21-node.33");
const repo = fileURLToPath(new URL("../..", import.meta.url));
const loader = createRequire(import.meta.url).resolve("tsx");
const directory = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "demlik-cli-ledger-pairs-")),
);
type Case = {
  id: string;
  setup?: (cwd: string) => void;
  input: (cwd: string) => Input;
  profile?: "full-cli-process" | "prepared-component";
  rawArgv?: boolean;
  badStderr?: boolean;
  fifo?: boolean;
};
const cases: Case[] = [];
function add(row: Case) {
  assert.ok(!cases.some((item) => item.id === row.id), row.id);
  cases.push(row);
}
function write(cwd: string, file: string, body: string | Buffer) {
  const target = path.join(cwd, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, body);
}
function project(cwd: string) {
  write(cwd, "pnpm-workspace.yaml", "packages: []\n");
  write(
    cwd,
    "packages/app/package.json",
    '{"name":"fixture-app","private":true}',
  );
  for (let n = 0; n < 3; n++)
    write(
      cwd,
      `packages/app/src/f${n}.ts`,
      `export function f${n}(){return ${n};}`,
    );
  write(
    cwd,
    "packages/app/ports.ts",
    "export type A={};export type ADriven={};",
  );
  write(cwd, "packages/app/application/app.ts", "export function createA(){}");
}
const app = (cwd: string) => path.join(cwd, "packages/app");
for (const [id, root, setup] of [
  ["workspace", (cwd: string) => app(cwd), project],
  [
    "fallback",
    (cwd: string) => path.join(cwd, "plain"),
    (cwd: string) => write(cwd, "plain/source.ts", ""),
  ],
  [
    "closest",
    (cwd: string) => app(cwd),
    (cwd: string) => {
      project(cwd);
      write(cwd, "packages/app/pnpm-workspace.yaml", "");
    },
  ],
  [
    "directory-marker",
    (cwd: string) => app(cwd),
    (cwd: string) => {
      project(cwd);
      fs.mkdirSync(path.join(cwd, "packages/app/pnpm-workspace.yaml"));
    },
  ],
  ["trailing", (cwd: string) => `${app(cwd)}///`, project],
  ["dots", (cwd: string) => `${app(cwd)}/./src/.`, project],
  ["relative", () => "packages/app/src", project],
  [
    "raw-fallback",
    (cwd: string) => `${cwd}/raw\uD800`,
    (cwd: string) => write(cwd, "raw�/source.ts", ""),
  ],
  [
    "raw-marker",
    (cwd: string) => `${cwd}/raw\uD800`,
    (cwd: string) => write(cwd, "raw�/pnpm-workspace.yaml", ""),
  ],
  [
    "raw-parent",
    (cwd: string) => `${cwd}/raw\uD800`,
    (cwd: string) => {
      write(cwd, "raw�/source.ts", "");
      write(cwd, "pnpm-workspace.yaml", "");
    },
  ],
] as const)
  add({
    id: `root.${id}`,
    setup,
    input: (cwd) => ({ action: "root", root: root(cwd) }),
  });

const rawHigh = String.fromCharCode(0xd800),
  rawLow = String.fromCharCode(0xdfff);
const jsonTexts = [
  "null",
  "1e400",
  "-0",
  "{}[]",
  "\uFEFF{}",
  '"𐀀"',
  '"\\ud800\\udc00"',
  `{"${rawHigh}":"${rawLow}"}`,
  `"${rawHigh}${rawHigh}${String.fromCharCode(0xdc00)}"`,
  `{}${rawHigh}`,
  `"\\${rawHigh}"`,
];
for (let slashes = 0; slashes <= 8; slashes++) {
  jsonTexts.push(`"${"\\".repeat(slashes)}${rawHigh}"`);
  jsonTexts.push(`{"x":"a${"\\".repeat(slashes)}"${rawLow}"}`);
}
for (let unit = 0; unit < 32; unit++)
  jsonTexts.push(`"before${String.fromCharCode(unit)}after"`);
for (const [index, text] of jsonTexts.entries())
  add({ id: `json.context-${index}`, input: () => ({ action: "json", text }) });
const uEntry = {
  scope: "packages/app",
  kind: "dead" as const,
  id: "src/a.ts:unused",
  reason: "kept",
};
const sEntry = {
  rule: "big-file" as const,
  target: "packages/app/a.ts",
  value: 401,
  reason: "kept",
};
const uTexts = [
  "",
  "{bad",
  "null",
  "false",
  "1",
  '"x"',
  "[]",
  "{}",
  '{"entries":null}',
  '{"entries":{}}',
  JSON.stringify({ entries: [] }),
  JSON.stringify({ entries: [uEntry] }),
];
for (const key of ["scope", "kind", "id", "reason"]) {
  for (const value of [
    undefined,
    null,
    false,
    0,
    "",
    [],
    {},
    " \u00A0\uFEFF ",
    "\u0085",
    rawHigh,
  ]) {
    uTexts.push(JSON.stringify({ entries: [{ ...uEntry, [key]: value }] }));
  }
}
uTexts.push(
  JSON.stringify({ entries: [uEntry, uEntry] }),
  JSON.stringify({
    entries: [uEntry, { ...uEntry, kind: "only-called-from-tests" }],
  }),
  '{"entries":[],"__proto__":null}',
  '{"entries":[],"constructor":null}',
  JSON.stringify({ entries: [{ ...uEntry, extra: 1 }], "0": "unknown" }),
  `{"entries":[],"extra":${"[".repeat(200)}0${"]".repeat(200)}}`,
  `{"entries":[{"scope":"${rawHigh}","kind":"dead","id":"${rawLow}","reason":"kept"}]}`,
);
for (const [index, text] of uTexts.entries())
  add({
    id: `unreachable.schema-${index}`,
    input: () => ({ action: "unreachable-parse", text }),
  });
const sTexts = [
  "",
  "{bad",
  "null",
  "false",
  "1",
  '"x"',
  "[]",
  "{}",
  '{"gated":null}',
  '{"entries":null}',
  '{"gated":["big-file"]}',
  JSON.stringify({ entries: [sEntry] }),
];
for (const value of [
  undefined,
  null,
  false,
  0,
  "",
  [],
  {},
  [null, ["x", null], {}],
  { toString: null },
  { toString: "x" },
  { constructor: null },
  { __proto__: null },
  rawHigh,
]) {
  sTexts.push(JSON.stringify({ gated: [value] }));
  sTexts.push(JSON.stringify({ entries: [{ ...sEntry, rule: value }] }));
}
for (const key of ["target", "value", "reason"]) {
  for (const value of [
    undefined,
    null,
    false,
    0,
    "",
    [],
    {},
    -1,
    1.5,
    9007199254740991,
    9007199254740992,
    " \u00A0\uFEFF ",
    "\u0085",
    rawLow,
  ])
    sTexts.push(JSON.stringify({ entries: [{ ...sEntry, [key]: value }] }));
}
sTexts.push(
  '{"entries":[{"rule":"big-file","target":"a","value":-0,"reason":"kept"}]}',
  '{"entries":[{"rule":"big-file","target":"a","value":1e400,"reason":"kept"}]}',
  '{"gated":["bad",{"toString":null}]}',
  '{"gated":null,"entries":[{"rule":{"toString":0}}]}',
  JSON.stringify({
    gated: ["big-file", "big-file"],
    entries: [sEntry, sEntry],
  }),
  '{"__proto__":null}',
  `{"extra":${"[".repeat(200)}0${"]".repeat(200)}}`,
);
sTexts.push(JSON.stringify({ entries: [sEntry, sEntry] }));
for (const [index, text] of sTexts.entries())
  add({
    id: `smell.schema-${index}`,
    input: () => ({ action: "smell-parse", text }),
  });
for (const kind of KINDS)
  add({
    id: `edges.${kind}`,
    input: () => ({ action: "needs-edges", gated: [kind] }),
  });
add({ id: "edges.none", input: () => ({ action: "needs-edges", gated: [] }) });
for (const [index, entries] of [
  [uEntry, { ...uEntry, reason: "second" }, { ...uEntry, scope: "other" }],
  [
    { ...uEntry, scope: rawHigh, id: 'a"\\\n' },
    { ...uEntry, kind: "only-called-from-tests" as const },
  ],
  [{ ...uEntry, scope: "", id: "", reason: "" }],
].entries())
  add({
    id: `unreachable.first-wins-${index}`,
    input: () => ({ action: "unreachable-of", entries }),
  });
for (const [index, entries] of [
  [
    sEntry,
    { ...sEntry, value: 999, reason: "second" },
    { ...sEntry, target: rawHigh },
  ],
  [
    { ...sEntry, value: "-0" as const },
    { ...sEntry, target: "nan", value: "NaN" as const },
    { ...sEntry, target: "infinite", value: "Infinity" as const },
  ],
  [{ ...sEntry, target: "", value: -1, reason: "" }],
].entries())
  add({
    id: `smell.first-wins-${index}`,
    input: () => ({
      action: "smell-of",
      gated: ["long-function", "big-file", "big-file"],
      entries,
    }),
  });
add({
  id: "unreachable.locale-constructor",
  input: () => ({
    action: "unreachable-of",
    entries: ["z", "ä", "a"].map((scope) => ({ ...uEntry, scope })),
  }),
});
add({
  id: "smell.locale-constructor",
  input: () => ({
    action: "smell-of",
    gated: ["big-file"],
    entries: ["z", "ä", "a"].map((target) => ({ ...sEntry, target })),
  }),
});
for (const domain of ["unreachable", "smell"] as const) {
  for (const [kind, setup, file] of [
    ["absent", () => {}, () => "missing"],
    [
      "directory",
      (cwd: string) => fs.mkdirSync(path.join(cwd, "ledger")),
      () => "ledger",
    ],
    [
      "malformed",
      (cwd: string) => write(cwd, "ledger", "{bad"),
      () => "ledger",
    ],
    [
      "bom",
      (cwd: string) => write(cwd, "ledger", '\uFEFF{"entries":[]}'),
      () => "ledger",
    ],
    [
      "invalid-utf8",
      (cwd: string) =>
        write(
          cwd,
          "ledger",
          Buffer.concat([
            Buffer.from('{"entries":[],"'),
            Buffer.from([0xff]),
            Buffer.from('":1}'),
          ]),
        ),
      () => "ledger",
    ],
    [
      "broken-link",
      (cwd: string) => fs.symlinkSync("missing", path.join(cwd, "ledger")),
      () => "ledger",
    ],
  ] as const)
    add({
      id: `${domain}.read-${kind}`,
      setup,
      input: (cwd) => ({
        action: domain === "unreachable" ? "unreachable-read" : "smell-read",
        file: path.join(cwd, file()),
      }),
    });
}
for (let bits = 0; bits < 32; bits++)
  for (const [reasonId, reason] of [
    ["missing", undefined],
    ["blank", " \uFEFF\u00A0"],
    ["kept", "\u00A0 kept \uFEFF"],
  ] as const) {
    add({
      id: `unreachable.mode-${bits}-${reasonId}`,
      setup: project,
      input: (cwd) => ({
        action: "prepare-unreachable",
        root: app(cwd),
        repoRoot: cwd,
        opts: {
          unreachable: !!(bits & 1),
          ci: !!(bits & 2),
          acceptDead: !!(bits & 4),
          deadOnly: !!(bits & 8),
          boundaries: !!(bits & 16),
          ...(reason === undefined ? {} : { reason }),
        },
      }),
    });
  }
for (const other of [
  "none",
  "unreachable",
  "boundaries",
  "comments",
  "collapse",
  "layers",
] as const)
  for (let bits = 0; bits < 4; bits++)
    for (const [reasonId, reason] of [
      ["missing", undefined],
      ["blank", "\uFEFF"],
      ["kept", "\u0085"],
    ] as const) {
      add({
        id: `smell.mode-${other}-${bits}-${reasonId}`,
        setup: project,
        input: (cwd) => ({
          action: "prepare-smell",
          root: app(cwd),
          repoRoot: cwd,
          opts: {
            ci: !!(bits & 1),
            acceptSmells: !!(bits & 2),
            ...(other === "none" ? {} : { [other]: true }),
            ...(reason === undefined ? {} : { reason }),
          },
        }),
      });
    }
for (const domain of ["unreachable", "smell"] as const)
  for (const fileType of [
    "malformed",
    "directory",
    "valid",
    "duplicate",
    "raw",
  ] as const) {
    add({
      id: `${domain}.prepare-${fileType}`,
      setup: (cwd) => {
        project(cwd);
        const name = `${domain}-ledger.json`;
        if (fileType === "directory") fs.mkdirSync(path.join(cwd, name));
        else
          write(
            cwd,
            name,
            fileType === "malformed"
              ? "{bad"
              : domain === "unreachable"
                ? JSON.stringify({
                    entries: [
                      uEntry,
                      ...(fileType === "duplicate" ? [uEntry] : []),
                    ],
                  })
                : fileType === "raw"
                  ? '{"gated":[{"toString":null}]}'
                  : JSON.stringify({
                      gated: ["big-file"],
                      entries: [
                        sEntry,
                        ...(fileType === "duplicate" ? [sEntry] : []),
                      ],
                    }),
          );
      },
      input: (cwd) =>
        domain === "unreachable"
          ? {
              action: "prepare-unreachable",
              root: app(cwd),
              repoRoot: cwd,
              opts: { unreachable: true, ci: true },
            }
          : {
              action: "prepare-smell",
              root: app(cwd),
              repoRoot: cwd,
              opts: { ci: true },
            },
    });
  }
function cli(
  id: string,
  flags: string[],
  options: {
    ledger?: "unreachable-bad" | "smell-bad" | "syntax" | "edges";
    prepared?: boolean;
    fifo?: boolean;
    badStderr?: boolean;
  } = {},
) {
  add({
    id: `cli.${id}`,
    profile: options.prepared ? "prepared-component" : "full-cli-process",
    fifo: options.fifo,
    badStderr: options.badStderr,
    setup: (cwd) => {
      project(cwd);
      if (options.fifo) {
        for (const name of ["unreachable-ledger.json", "smell-ledger.json"]) {
          const made = spawnSync("/usr/bin/mkfifo", [path.join(cwd, name)], {
            encoding: "utf8",
          });
          assert.equal(made.status, 0, made.stderr);
        }
      } else if (options.ledger === "unreachable-bad") {
        write(cwd, "unreachable-ledger.json", "{bad");
        write(cwd, "smell-ledger.json", "{bad");
      } else if (options.ledger === "smell-bad")
        write(cwd, "smell-ledger.json", "{bad");
      else if (options.ledger === "syntax" || options.ledger === "edges")
        write(
          cwd,
          "smell-ledger.json",
          JSON.stringify({
            gated: [options.ledger === "syntax" ? "big-file" : "high-fan-in"],
          }),
        );
    },
    input: (cwd) => ({ action: "frontdoor", argv: [app(cwd), ...flags] }),
  });
}
cli("accept-dead-first", ["--layers", "--accept-dead", "--accept-smells"], {
  fifo: true,
});
cli("dead-only-first", ["--layers", "--dead-only"], { fifo: true });
cli(
  "unreachable-invalid",
  ["--layers", "--unreachable", "--ci", "--layer-rules=missing"],
  { ledger: "unreachable-bad" },
);
cli("smell-invalid", ["--ci", "--out=must-not-exist"], { ledger: "smell-bad" });
cli("smell-conflict", ["--layers", "--accept-smells", "--reason=kept"], {
  fifo: true,
});
cli(
  "hexagon-before-ledgers",
  ["--hexagon", "--layers", "--accept-dead", "--accept-smells"],
  { fifo: true },
);
cli("refusal-stderr-bad", ["--accept-dead"], { badStderr: true, fifo: true });
cli("layers-continue", ["--layers", "--ci", "--layer-rules=missing"], {
  prepared: true,
  ledger: "smell-bad",
});
cli("ci-fallback", ["--ci"], { prepared: true });
cli("syntax-ready", ["--ci", "--json", "--out=must-not-exist"], {
  prepared: true,
  ledger: "syntax",
});
cli("edges-ready", ["--ci", "--deep"], { prepared: true, ledger: "edges" });
cli(
  "all-options-carried",
  [
    "--graph",
    "--data",
    "--headers",
    "--kinds",
    "--unreachable",
    "--unguarded",
    "--clusters",
    "--interface-width",
    "--cross-runtime",
    "--edges",
    "--html",
    "--cycles",
    "--find=x",
    "--blast=x",
    "--plan",
    "--by=complexity",
    "--hotspots",
    "--hotspots-days=12",
    "--hotspots-limit=3",
  ],
  { prepared: true },
);

add({
  id: "cli.config-values-carried",
  profile: "prepared-component",
  setup: (cwd) => {
    project(cwd);
    write(cwd, "thresholds.json", '{"longFunctionLoc":100,"highFanIn":5}');
    write(cwd, "kinds.json", '{"entryNames":{"custom":["^mine$"]}}');
    write(cwd, "collapse.json", '{"minLoc":12,"shapeLocRatio":0.7}');
  },
  input: (cwd) => ({
    action: "frontdoor",
    argv: [
      app(cwd),
      "--graph",
      "--thresholds=thresholds.json",
      "--node-kinds=kinds.json",
      "--entry-preset=nextjs",
      "--collapse-config=collapse.json",
    ],
  }),
});
add({
  id: "cli.raw-root-ready",
  profile: "prepared-component",
  setup: (cwd) => {
    write(cwd, "raw�/pnpm-workspace.yaml", "packages: []\n");
    for (let n = 0; n < 3; n++)
      write(cwd, `raw�/src/f${n}.ts`, `export const f${n}=${n};`);
  },
  input: (cwd) => ({
    action: "frontdoor",
    argv: [`${cwd}/raw\uD800`, "--graph"],
  }),
});
function files(cwd: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const walk = (base: string, rel: string) => {
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      const name = rel ? `${rel}/${entry.name}` : entry.name;
      const full = path.join(base, entry.name);
      if (entry.isSymbolicLink()) out[name] = { link: fs.readlinkSync(full) };
      else if (entry.isDirectory()) walk(full, name);
      else if (entry.isFile())
        out[name] = fs.readFileSync(full).toString("hex");
      else out[name] = { special: true };
    }
  };
  walk(cwd, "");
  return out;
}
function normalized(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}
const traceSchema = z.object({
  output: z.unknown(),
  details: z.unknown(),
  code: z.number(),
  observedCalls: z.array(z.string()),
});
const selected = process.env.DEMLIK_LEDGER_CASES?.split(",");
const chosen = selected
  ? cases.filter((row) => selected.includes(row.id))
  : cases;
if (selected)
  assert.equal(
    chosen.length,
    new Set(selected).size,
    "every selected case must exist",
  );
const results: Record<string, unknown>[] = [],
  failures: { id: string; message: string }[] = [];
try {
  for (const row of chosen) {
    const cwd = path.join(directory, row.id, "cwd");
    fs.mkdirSync(cwd, { recursive: true });
    row.setup?.(cwd);
    const before = files(cwd);
    const input = InputSchema.parse(row.input(cwd));
    const sourceTrace = path.join(directory, row.id, "source.jsonl");
    const ioTrace = path.join(directory, row.id, "source-io.jsonl");
    const nativeTrace = path.join(directory, row.id, "native.json");
    let expected: unknown,
      sourceDetails: unknown = null,
      sourceProcess: unknown = null;
    const qualifications: string[] = [];
    const previous = process.cwd();
    process.chdir(cwd);
    try {
      if (row.profile === "full-cli-process") {
        assert.equal(input.action, "frontdoor");
        const front = z.object({ argv: z.array(z.string()) }).parse(input);
        const request = path.join(directory, row.id, "source-request.json");
        fs.writeFileSync(
          request,
          JSON.stringify({ trace: sourceTrace, input, rawArgv: row.rawArgv }),
        );
        const fd = row.badStderr
          ? fs.openSync(path.join(directory, row.id, "bad-stderr"), "w")
          : undefined;
        if (fd !== undefined) fs.closeSync(fd);
        const readonly = row.badStderr
          ? fs.openSync(path.join(directory, row.id, "bad-stderr"), "r")
          : undefined;
        const child = spawnSync(
          process.execPath,
          [
            "--import",
            loader,
            path.join(
              repo,
              "verification/parity/cli-ledger-preflight-source.mts",
            ),
            ...front.argv,
          ],
          {
            cwd,
            env: {
              ...process.env,
              DEMLIK_FRONTDOOR_REQUEST: request,
              DEMLIK_PREFLIGHT_FIXTURE: cwd,
              DEMLIK_PREFLIGHT_IO: ioTrace,
            },
            encoding: "utf8",
            timeout: 10000,
            maxBuffer: 16 * 1024 * 1024,
            stdio: ["pipe", "pipe", readonly ?? "pipe"],
          },
        );
        if (readonly !== undefined) fs.closeSync(readonly);
        const events = fs.existsSync(sourceTrace)
          ? fs
              .readFileSync(sourceTrace, "utf8")
              .trim()
              .split("\n")
              .filter(Boolean)
              .map((line) => JSON.parse(line))
          : [];
        sourceProcess = {
          status: child.status,
          signal: child.signal,
          stdout: child.stdout ?? "",
          stderr: child.stderr ?? "",
          events,
          io: fs.existsSync(ioTrace)
            ? fs
                .readFileSync(ioTrace, "utf8")
                .trim()
                .split("\n")
                .filter(Boolean)
                .map((line) => JSON.parse(line))
            : [],
          error: child.error?.message,
        };
        expected = sourceProcess;
      } else {
        const result = reference(input);
        expected = normalized(result.output);
        sourceDetails = normalized(result.details);
        if (row.profile === "prepared-component")
          qualifications.push("prepared-component");
      }
    } finally {
      process.chdir(previous);
    }
    assert.deepEqual(
      files(cwd),
      before,
      `${row.id}: Source wrote fixture files`,
    );
    const readonly = row.badStderr
      ? fs.openSync(path.join(directory, row.id, "bad-stderr"), "r")
      : undefined;
    const native = spawnSync(binary, {
      cwd,
      input: JSON.stringify({ trace: nativeTrace, input }),
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["pipe", "pipe", readonly ?? "pipe"],
    });
    if (readonly !== undefined) fs.closeSync(readonly);
    const actual = fs.existsSync(nativeTrace)
      ? traceSchema.parse(JSON.parse(fs.readFileSync(nativeTrace, "utf8")))
      : null;
    let passed = false;
    try {
      assert.ok(
        actual,
        `native did not return trace: ${native.error?.message ?? native.stderr}`,
      );
      assert.ok(
        !native.error,
        `native blocked/refused: ${native.error?.message}`,
      );
      assert.deepEqual(files(cwd), before, "native wrote fixture files");
      if (row.profile === "full-cli-process") {
        const source = z
          .object({
            status: z.number().nullable(),
            signal: z.unknown(),
            stdout: z.string(),
            stderr: z.string(),
            events: z.array(z.record(z.string(), z.unknown())),
            io: z.array(z.record(z.string(), z.unknown())),
          })
          .parse(expected);
        assert.equal(native.status, source.status);
        assert.equal(native.signal, null);
        assert.equal(native.stdout ?? "", source.stdout);
        if (row.badStderr) {
          qualifications.push("stdio-runtime-notification");
          const output = z
            .object({
              io: z.object({
                stored: z.number().nullable(),
                requested: z.number().nullable(),
                pending: z.array(
                  z.object({
                    stream: z.string(),
                    cause: z.object({ code: z.number().nullable() }),
                  }),
                ),
              }),
            })
            .parse(actual.output);
          assert.equal(output.io.requested, 2);
          assert.equal(output.io.pending[0]?.stream, "stderr");
          assert.equal(output.io.pending[0]?.cause.code, 9);
          assert.ok(source.events.some((event) => event.event === "uncaught"));
        } else assert.equal(native.stderr ?? "", source.stderr);
        assert.ok(!source.io.some((event) => event.op === "write"));
        if (row.fifo)
          assert.equal(
            source.io.length,
            row.id.includes("hexagon") ? 2 : 0,
            "inactive ledgers must not be read",
          );
      } else if (row.profile === "prepared-component") {
        const output = z.record(z.string(), z.unknown()).parse(actual.output);
        assert.equal(output.sameBox, true);
        const { sameBox: _, ...rest } = output;
        assert.deepEqual(rest, expected);
        assert.equal(native.stdout, "");
        assert.equal(native.stderr, "");
      } else {
        assert.deepEqual(actual.output, expected);
        if (sourceDetails !== null)
          assert.deepEqual(actual.details, sourceDetails);
        const conversion = z
          .object({
            value: z.null(),
            thrown: z.object({
              name: z.literal("TypeError"),
              message: z.string(),
            }),
          })
          .safeParse(expected);
        if (
          conversion.success &&
          (input.action === "smell-parse" ||
            input.action === "smell-read" ||
            input.action === "prepare-smell")
        ) {
          const body =
            input.action === "smell-parse"
              ? input.text
              : fs.readFileSync(
                  input.action === "smell-read"
                    ? input.file
                    : path.join(input.repoRoot, "smell-ledger.json"),
                  "utf8",
                );
          let offending: unknown = JSON.parse(body);
          const cause = z
            .object({
              input: z.unknown(),
              path: z.array(
                z.union([z.string(), z.number().int().nonnegative()]),
              ),
            })
            .parse(actual.details);
          for (const part of cause.path)
            offending =
              typeof part === "number"
                ? z.array(z.unknown()).parse(offending)[part]
                : z.record(z.string(), z.unknown()).parse(offending)[part];
          assert.deepEqual(cause.input, offending);
          assert.throws(() => String(offending), TypeError);
        }
        if (row.id.endsWith("directory")) {
          const cause = z
            .object({ code: z.number(), message: z.string(), kind: z.string() })
            .parse(actual.details);
          assert.equal(cause.code, 21);
          assert.ok(cause.message.length);
          assert.equal(cause.kind, "IsADirectory");
        }
        assert.equal(native.status, 0);
        assert.equal(native.stdout, "");
        assert.equal(native.stderr, "");
      }
      assert.ok(actual.observedCalls.length > 0);
      passed = true;
    } catch (error) {
      failures.push({ id: row.id, message: String(error) });
    }
    results.push({
      id: row.id,
      input,
      passed,
      qualifications,
      profile: row.profile ?? "public-helper",
      source: expected,
      sourceDetails,
      native: {
        status: native.status,
        signal: native.signal,
        stdout: native.stdout ?? "",
        stderr: native.stderr ?? "",
        error: native.error?.message,
        trace: actual,
      },
    });
  }
  let rejectedInvalidInputs = 0;
  for (const [id, request] of [
    ["malformed", "{"],
    [
      "extra-outer",
      JSON.stringify({
        trace: "unused",
        input: { action: "root", root: "/" },
        extra: true,
      }),
    ],
    [
      "unknown-action",
      JSON.stringify({ trace: "unused", input: { action: "unknown" } }),
    ],
    [
      "wrong-root",
      JSON.stringify({ trace: "unused", input: { action: "root", root: 7 } }),
    ],
    [
      "extra-input",
      JSON.stringify({
        trace: "unused",
        input: { action: "root", root: "/", extra: true },
      }),
    ],
    [
      "wrong-option",
      JSON.stringify({
        trace: "unused",
        input: {
          action: "prepare-unreachable",
          root: "/",
          repoRoot: "/",
          opts: { ci: "true" },
        },
      }),
    ],
    [
      "missing-argv",
      JSON.stringify({ trace: "unused", input: { action: "frontdoor" } }),
    ],
  ] as const) {
    const run = spawnSync(binary, { input: request, encoding: "utf8" });
    const passed = run.status !== 0 && (run.stderr ?? "").length > 0;
    if (passed) rejectedInvalidInputs++;
    else
      failures.push({
        id: `invalid.${id}`,
        message: "invalid protocol input accepted",
      });
    results.push({
      id: `invalid.${id}`,
      passed,
      protocol: true,
      status: run.status,
      stderr: run.stderr,
    });
  }
  const passing = results
    .slice(0, chosen.length)
    .filter((row) => row.passed === true);
  const evidence = (qualified: boolean) =>
    Object.fromEntries(
      passing
        .filter(
          (row) =>
            z.array(z.string()).parse(row.qualifications).length > 0 ===
            qualified,
        )
        .map((row) => [
          row.id,
          z.object({ trace: traceSchema }).parse(row.native).trace
            .observedCalls,
        ]),
    );
  const hash = (p: string) =>
    createHash("sha256").update(fs.readFileSync(p)).digest("hex");
  const report = {
    passed: passing.length,
    attempted: chosen.length,
    unqualifiedPairs: passing.filter(
      (row) => z.array(z.string()).parse(row.qualifications).length === 0,
    ).length,
    qualifiedPairs: passing.filter(
      (row) => z.array(z.string()).parse(row.qualifications).length > 0,
    ).length,
    rejectedInvalidInputs,
    profiles: Object.fromEntries(
      ["public-helper", "full-cli-process", "prepared-component"].map(
        (profile) => [
          profile,
          {
            passed: passing.filter((row) => row.profile === profile).length,
            exact: passing.filter(
              (row) =>
                row.profile === profile &&
                z.array(z.string()).parse(row.qualifications).length === 0,
            ).length,
          },
        ],
      ),
    ),
    driverSha256: hash(binary),
    reference: {
      node: process.version,
      v8: process.versions.v8,
      sourceHashes: Object.fromEntries(
        [
          "index.ts",
          "extract/project.ts",
          "unreachable/ledger.ts",
          "unreachable/gate.ts",
          "smells/ledger.ts",
          "smells/gate.ts",
          "smells/rules.ts",
        ].map((file) => [
          file,
          hash(path.join(repo, "packages/code-graph/src", file)),
        ]),
      ),
    },
    nativeEvidence: evidence(false),
    qualifiedNativeEvidence: evidence(true),
    failures,
    cases: results,
  };
  if (process.argv[3])
    fs.writeFileSync(process.argv[3], `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    JSON.stringify({
      passed: report.passed,
      attempted: report.attempted,
      unqualifiedPairs: report.unqualifiedPairs,
      qualifiedPairs: report.qualifiedPairs,
      rejectedInvalidInputs,
      failures,
    }),
  );
  assert.deepEqual(failures, []);
  assert.equal(rejectedInvalidInputs, 7);
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
