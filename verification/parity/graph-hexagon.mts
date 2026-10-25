import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { defineProgram } from "../../packages/code-graph/src/cli.js";
import type { Hexagon } from "../../packages/code-graph/src/hexagon/read.js";
import {
  type HexagonInput,
  hexagonReference,
  type NumberInput,
  numeric,
} from "./hexagon-reference.mjs";

const binary = process.argv[2];
assert.ok(binary);
assert.ok(process.argv.length <= 4);
assert.equal(process.version, "v22.21.1");
assert.equal(process.versions.v8, "12.4.254.21-node.33");
const repo = fileURLToPath(new URL("../..", import.meta.url));
const loader = createRequire(import.meta.url).resolve("tsx");
const directory = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "demlik-hexagon-pairs-")),
);
type Stdio = "normal" | "stdout-bad" | "stderr-bad" | "stdout-closed";
type Case = {
  id: string;
  setup?: (cwd: string) => void;
  input: (cwd: string) => HexagonInput;
  stdio?: Stdio;
  rawArgv?: boolean;
  qualified?: "os-diagnostic" | "argument-diagnostic";
  prepared?: boolean;
  fixture?: string;
};
const cases: Case[] = [];
function add(row: Case) {
  assert.ok(!cases.some((item) => item.id === row.id), row.id);
  cases.push(row);
}
function write(root: string, file: string, text: string | Buffer) {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text);
}
function copied(cwd: string, fixture = "full") {
  fs.cpSync(
    path.join(repo, "packages/code-graph/test/hexagon", fixture),
    path.join(cwd, "feature"),
    { recursive: true },
  );
}
function sourceProject(
  cwd: string,
  ports: string,
  application: Record<string, string> = {
    "main.ts": "export function createA(){}",
  },
) {
  write(cwd, "feature/ports.ts", ports);
  for (const [file, text] of Object.entries(application))
    write(cwd, `feature/application/${file}`, text);
}
const root = (cwd: string) => path.join(cwd, "feature");
for (const fixture of ["full", "unbagged", "not-read"]) {
  add({
    id: `read.fixture-${fixture}`,
    setup: (cwd) => copied(cwd, fixture),
    input: (cwd) => ({ action: "read", root: root(cwd) }),
    fixture,
  });
  for (const [format, flags] of [
    ["text", []],
    ["json", ["--json"]],
    ["pretty", ["--json", "--pretty"]],
  ] as const)
    add({
      id: `cli.fixture-${fixture}-${format}`,
      setup: (cwd) => copied(cwd, fixture),
      input: (cwd) => ({
        action: "frontdoor",
        argv: [root(cwd), "--hexagon", ...flags],
      }),
      fixture,
    });
}
const portSources: Record<string, string | null> = {
  null: null,
  empty: "",
  malformed: "export type Broken =",
  ports:
    "export type ForReading=()=>string;export type ForWriting=Remote.Writing<string>;export type ForSaving=<T>(x:T)=>Promise<T>;",
  prefix:
    "export type For=()=>void;export type Fora=()=>void;export type ForÄ=()=>void;export type ForA=()=>void;export type ForAType=number;",
  generic:
    "export type ForA<T>=(x:T)=>T;export type ForB<T=string>=Remote.B<T>;export type B<T>={x:T};export type ForC=<T>(x:T)=>T;",
  properties:
    "export interface Bag{readonly read?:ForA;'quoted': () =>void;42:number};export type ForA=(x:string)=>void;",
  memberShapes:
    "export type Method={go?():void};export type Index={[key:string]:number};export type Call={():void};export type Construct={new():any};export type Computed={[Symbol.iterator]:()=>void};export type Missing={x};",
  bagShapes:
    "export type Mapped={[K in 'x']:number};export type Conditional=A extends B?C:D;export type Union=A|B;export type Intersection=A&B;export type Parens=(({x:number}));export type Alias=Bag;export interface Extend extends Bag{x:string}",
  memberReasonOrder:
    "export type A={x:number;x:number;[Symbol.iterator]:()=>void};export interface B<T> extends Other{x()};",
  duplicate:
    "export type ForA=()=>void;export type Bag={x:ForA;x?:ForA};export type Quote={x:ForA;'x':ForA};",
  merge:
    "interface A{x:number} export interface A{y:string}; export interface \\u0042{x:number};export interface B{y:number}",
  exportForms:
    "type Local={x:number};export {Local as Renamed};export {X as Y} from 'remote';export * from 'remote';export * as Remote from 'remote';export default interface Named{x:number};",
  unsupported:
    "export namespace N{export type A={}};declare module 'remote' {interface Bag{}};export const {one,two}={one:1,two:2};export function f(){};export import Alias=N;export as namespace Global;export=N;",
  directOnly:
    "type Private={x:number};namespace Internal{};class Local{};import type {ForA} from 'remote';export type Public={x:ForA};",
  exactUse:
    "export type ForA=()=>void;export type ForB=()=>number;export type ForC=()=>string;export type ForD=()=>boolean;export type Bag={a:ForA;b:(ForB);c:Promise<ForC>;d:Remote.ForD};",
  unreadBagConsumesNothing:
    "export type ForA=()=>void;export type Bag={a:ForA;bad()};",
  selfSignature: "export type ForA=ForA;export type Bag={a:ForA};",
  unicodeOrder:
    'export type ForA=()=>void;export type Bag={"\uE000":ForA;"𐀀":ForA;"raw\\ud800":ForA};',
  commentsAndLines:
    "\ufeff// before 😀\r\nexport\r\ninterface A<T>{x:T}\u2028export type ForA=/*before*/(x:string /*inside*/)=>void;\u2029export type Bag={x:ForA};",
  declarations:
    "export declare function createA():void;export declare const value:number;export enum E{a};export abstract class C{};export type T=string;",
};
for (const [id, text] of Object.entries(portSources))
  add({ id: `ports.${id}`, input: () => ({ action: "ports", text }) });
const functions: Record<string, string> = {
  declaration: "export function createA(){}",
  arrow: "export const createA=()=>({})",
  expression: "export const createA=function inner(){}",
  bindingName: "export const helper=function createA(){}",
  list: "function createA(){} export{createA};",
  alias: "function local(){}export{local as createA};",
  reexport: "export{createA}from'remote';",
  namespaceExport: "export * as createA from'remote';",
  namespace: "export namespace N{export function createA(){}}",
  default: "export default function createA(){}",
  let: "export let createA=()=>({})",
  wrapped: "export const createA=(()=>({}));",
  asCast: "export const createA=(()=>({})) as unknown",
  overload:
    "export function createA(x:string):void;export function createA(x:unknown){}",
  multiple:
    "export const createZ=()=>0,createA=function inside(){};export function helper(){}",
  lowercase:
    "export function createa(){};export function createÄ(){};export function createA(){}",
  destructure: "export const {createA}={createA:()=>0};",
};
for (const [id, text] of Object.entries(functions))
  add({
    id: `factory.${id}`,
    setup: (cwd) =>
      sourceProject(cwd, "export type A={};export type ADriven={};", {
        "factory.ts": text,
      }),
    input: (cwd) => ({ action: "read", root: root(cwd) }),
  });
const rankPorts =
  "export type A={};export type ADriven={};export type B={};export type BDriven={};";
add({
  id: "factory.filename-rank",
  setup: (cwd) =>
    sourceProject(cwd, rankPorts, {
      "a.ts": "export function createA(){}",
      "feature.ts": "export function createMissing(){}",
    }),
  input: (cwd) => ({ action: "read", root: root(cwd) }),
});
add({
  id: "factory.paired-bags-rank",
  setup: (cwd) =>
    sourceProject(cwd, rankPorts, {
      "a.ts": "export function createMissing(){}",
      "z.ts": "export function createB(){}",
    }),
  input: (cwd) => ({ action: "read", root: root(cwd) }),
});
add({
  id: "factory.file-and-name-rank",
  setup: (cwd) =>
    sourceProject(cwd, rankPorts, {
      "a.ts": "export function createB(){};export function createA(){}",
      "z.ts": "export function createA(){}",
    }),
  input: (cwd) => ({ action: "read", root: root(cwd) }),
});
add({
  id: "factory.file-rank-distinct-features",
  setup: (cwd) =>
    sourceProject(cwd, rankPorts, {
      "a.ts": "export function createB(){}",
      "z.ts": "export function createA(){}",
    }),
  input: (cwd) => ({ action: "read", root: root(cwd) }),
});
add({
  id: "factory.requires-both-bags",
  setup: (cwd) =>
    sourceProject(
      cwd,
      "export type A={};export type B={};export type BDriven={};",
      {
        "a.ts": "export function createA(){}",
        "z.ts": "export function createB(){}",
      },
    ),
  input: (cwd) => ({ action: "read", root: root(cwd) }),
});
function rawProject(cwd: string) {
  sourceProject(cwd, rankPorts, {
    "a.ts": "export function createA(){}",
    "raw�.ts": "export function createB(){}",
  });
  fs.renameSync(root(cwd), path.join(cwd, "raw�"));
  fs.symlinkSync("raw�", path.join(cwd, "raw-link�"), "dir");
}
for (const [id, suffix] of [
  ["raw", "raw\ud800"],
  ["replacement", "raw�"],
  ["raw-trailing", "raw\ud800/"],
  ["symlink", "raw-link\ud800"],
]) {
  add({
    id: `read.basename-${id}`,
    setup: rawProject,
    input: (cwd) => ({ action: "read", root: path.join(cwd, suffix) }),
  });
  add({
    id: `cli.basename-${id}`,
    setup: rawProject,
    input: (cwd) => ({
      action: "frontdoor",
      argv: [path.join(cwd, suffix), "--hexagon", "--json"],
    }),
    rawArgv: true,
  });
}
for (const [id, setup] of Object.entries<(cwd: string) => void>({
  missing: (cwd) => fs.mkdirSync(root(cwd)),
  malformedPorts: (cwd) => sourceProject(cwd, "export type Broken ="),
  malformedApplication: (cwd) =>
    sourceProject(cwd, "export type A={};", {
      "main.ts": "export const broken =",
    }),
  portsDirectory: (cwd) =>
    fs.mkdirSync(path.join(root(cwd), "ports.ts"), { recursive: true }),
  applicationFile: (cwd) => {
    sourceProject(cwd, "export type A={};", {});
    write(cwd, "feature/application", "");
  },
  adaptersFile: (cwd) => {
    sourceProject(cwd, "export type A={};", {});
    write(cwd, "feature/adapters", "");
  },
  missingPortsBeforeApplication: (cwd) => {
    fs.mkdirSync(root(cwd));
    write(cwd, "feature/application", "");
  },
  unreadableReverse: (cwd) => unreadableDirectories(cwd, ["z", "a"]),
  unreadableForward: (cwd) => unreadableDirectories(cwd, ["a", "z"]),
  unreadableUnicode: (cwd) => unreadableDirectories(cwd, ["𐀀", "\uE000"]),
  visibility: (cwd) => {
    sourceProject(cwd, "export type A={};", {
      "main.ts": "export function createA(){}",
      "nested/ignored.ts": "export function createB(){}",
      "component.tsx": "export const broken =",
      "excluded.d.ts": "export declare function createX():void",
      "excluded.gen.ts": "export function createY(){}",
      ".hidden.ts": "export function createZ(){}",
    });
    write(cwd, "feature/adapters/driving/invalid.ts", "export const broken =");
    write(cwd, "feature/adapters/driven/x.test.ts", "not valid");
    write(cwd, "feature/adapters/driven/dist/hidden.ts", "bad");
  },
  gitIgnore: (cwd) => {
    sourceProject(cwd, "export type A={};");
    assert.equal(
      spawnSync("git", ["init", "--quiet"], { cwd: root(cwd) }).status,
      0,
    );
    write(cwd, "feature/.gitignore", "application/ignored.ts\n");
    write(
      cwd,
      "feature/application/ignored.ts",
      "export function createIgnored(){}",
    );
  },
  unicodeFiles: (cwd) =>
    sourceProject(cwd, rankPorts, {
      "\uE000.ts": "export function createA(){}",
      "𐀀.ts": "export function createB(){}",
    }),
  bom: (cwd) =>
    sourceProject(
      cwd,
      "\ufeffexport type ForA=()=>void;\r\nexport type A={x:ForA};\r\nexport type ADriven={};",
      { "main.ts": "\ufeffexport const createA=()=>({});" },
    ),
  invalidUtf8: (cwd) => {
    sourceProject(cwd, "export type A={};");
    write(
      cwd,
      "feature/ports.ts",
      Buffer.from([
        0x2f,
        0x2f,
        0xff,
        0x0a,
        ...Buffer.from("export type A={};"),
      ]),
    );
  },
})) {
  add({
    id: `read.layout-${id}`,
    setup,
    input: (cwd) => ({ action: "read", root: root(cwd) }),
  });
  add({
    id: `cli.layout-${id}`,
    setup,
    input: (cwd) => ({
      action: "frontdoor",
      argv: [root(cwd), "--hexagon", "--json"],
    }),
  });
}
const emptyReport: Hexagon = {
  feature: null,
  commands: [],
  externalSystems: [],
  otherBags: [],
  unbaggedPorts: [],
  useCases: [],
  adapters: { driving: [], driven: [] },
  notRead: [],
};
for (const line of [
  1.5,
  "-0",
  1e21,
  NaN,
  Infinity,
  -Infinity,
  9007199254740992,
].map((value) =>
  Number.isNaN(value)
    ? "NaN"
    : value === Infinity
      ? "Infinity"
      : value === -Infinity
        ? "-Infinity"
        : value,
) as NumberInput[]) {
  for (const [format, json, pretty] of [
    ["text", false, false],
    ["json", true, false],
    ["pretty", true, true],
  ] as const)
    add({
      id: `render.line-${String(line)}-${format}`,
      input: () => ({
        action: "render",
        report: {
          ...structuredClone(emptyReport),
          notRead: [
            {
              file: "raw\ud800.ts",
              line: 1,
              name: "fact",
              reason: "why\nraw\udfff",
            },
          ],
        },
        line,
        json,
        pretty,
      }),
    });
}
add({
  id: "render.raw-data",
  input: () => ({
    action: "render",
    json: false,
    pretty: false,
    report: {
      ...structuredClone(emptyReport),
      feature: "raw\ud800",
      commands: [{ name: "x\udfff?", type: "A\ud800", signature: "raw\udfff" }],
      otherBags: [
        { name: "empty", members: [] },
        {
          name: "notEmpty",
          members: [{ name: "same", type: "same", signature: "same" }],
        },
      ],
      useCases: [
        { file: "empty.ts", functions: [] },
        { file: "full.ts", functions: ["raw\ud800", "two"] },
      ],
      adapters: { driving: ["raw\ud800.ts"], driven: [] },
    },
  }),
});
for (const emitMode of ["ok", "callback", "input"] as const)
  for (const reportMode of ["ok", "callback", "input"] as const)
    add({
      id: `run.callbacks-${emitMode}-${reportMode}`,
      setup: (cwd) => copied(cwd),
      input: (cwd) => ({
        action: "run",
        root: root(cwd),
        json: false,
        pretty: false,
        emitMode,
        reportMode,
        emitMessage: "raw\ud800 emit\nerror",
        reportMessage: "raw\udfff report\terror",
      }),
    });
for (const reportMode of ["ok", "callback", "input"] as const)
  add({
    id: `run.layout-${reportMode}`,
    setup: (cwd) => fs.mkdirSync(root(cwd)),
    input: (cwd) => ({
      action: "run",
      root: root(cwd),
      json: true,
      pretty: true,
      reportMode,
      reportMessage: "raw\ud800 report",
    }),
  });
const cli = (id: string, flags: string[], options: Partial<Case> = {}) =>
  add({
    id: `cli.${id}`,
    setup: (cwd) => copied(cwd),
    input: (cwd) => ({
      action: "frontdoor",
      argv: [root(cwd), "--hexagon", ...flags],
    }),
    ...options,
  });
cli("early-priority", [
  "--ci",
  "--accept-dead",
  "--accept-smells",
  "--layers",
  "--boundaries",
  "--comments",
  "--collapse",
  "--unreachable",
  "--unguarded",
  "--clusters",
  "--interface-width",
  "--cycles",
  "--kinds",
  "--cross-runtime",
  "--data",
  "--hotspots",
  "--edges",
  "--deep",
  "--by=complexity",
  "--graph",
]);
cli("config-before-hexagon", ["--thresholds=bad.json"], {
  setup: (cwd) => {
    copied(cwd);
    write(cwd, "bad.json", "{bad");
  },
});
cli("api-before-hexagon", ["--api=missing-map.json"]);
cli("prior-exit-preserved", [], {
  input: (cwd) => ({
    action: "frontdoor",
    argv: [root(cwd), "--hexagon"],
    initial: 7,
  }),
});
cli("out", ["--json", "--pretty", "--out=result.json"]);
cli("out-empty-name", ["--out="], { qualified: "os-diagnostic" });
cli("out-missing-parent", ["--out=missing/result"], {
  qualified: "os-diagnostic",
});
cli("out-directory", ["--out=out-directory"], {
  setup: (cwd) => {
    copied(cwd);
    fs.mkdirSync(path.join(cwd, "out-directory"));
  },
  qualified: "os-diagnostic",
});
cli("out-null", ["--out=raw\0\ud800"], {
  rawArgv: true,
  qualified: "argument-diagnostic",
});
cli("out-raw-name", ["--out=raw\ud800.txt"], { rawArgv: true });
cli("stdout-bad", [], { stdio: "stdout-bad" });
cli("stdout-closed", [], { stdio: "stdout-closed" });
cli("banner-stderr-bad", ["--out=result.txt"], { stdio: "stderr-bad" });
add({
  id: "cli.refusal-stderr-bad",
  setup: (cwd) => fs.mkdirSync(root(cwd)),
  input: (cwd) => ({ action: "frontdoor", argv: [root(cwd), "--hexagon"] }),
  stdio: "stderr-bad",
});
add({
  id: "continue.other-mode",
  setup: (cwd) => copied(cwd),
  input: (cwd) => ({
    action: "frontdoor",
    argv: [root(cwd), "--graph", "--data"],
  }),
  prepared: true,
});
const selected = process.env.DEMLIK_HEXAGON_CASES?.split(",");
if (selected) {
  assert.equal(new Set(selected).size, selected.length);
  for (const id of selected)
    assert.ok(
      cases.some((row) => row.id === id),
      id,
    );
}
const chosen = selected
  ? cases.filter((row) => selected.includes(row.id))
  : cases;
function files(cwd: string): Record<string, string> {
  const found: Record<string, string> = {};
  function walk(directory: string) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const full = path.join(directory, entry.name),
        key = path.relative(cwd, full);
      if (entry.isSymbolicLink())
        found[key] = `symlink:${fs.readlinkSync(full)}`;
      else if (entry.isDirectory()) {
        const mode = fs.statSync(full).mode & 0o777;
        if ((mode & 0o444) === 0) found[`directory:${key}`] = `mode:${mode}`;
        else walk(full);
      } else found[key] = fs.readFileSync(full).toString("hex");
    }
  }
  walk(cwd);
  return found;
}
async function child(
  executable: string,
  args: string[],
  input: string | undefined,
  cwd: string,
  mode: Stdio,
  env: NodeJS.ProcessEnv,
) {
  const descriptors: number[] = [];
  let stdout: number | "pipe" = "pipe",
    stderr: number | "pipe" = "pipe";
  if (mode === "stdout-bad" || mode === "stderr-bad") {
    const file = path.join(path.dirname(cwd), `${mode}.readonly`);
    fs.writeFileSync(file, "initial");
    const fd = fs.openSync(file, "r");
    descriptors.push(fd);
    if (mode === "stdout-bad") stdout = fd;
    else stderr = fd;
  }
  const process = spawn(executable, args, {
    cwd,
    env,
    stdio: ["pipe", stdout, stderr],
  });
  for (const fd of descriptors) fs.closeSync(fd);
  const out: Buffer[] = [],
    err: Buffer[] = [];
  process.stdout?.on("data", (part) => out.push(part));
  process.stderr?.on("data", (part) => err.push(part));
  if (mode === "stdout-closed") process.stdout?.destroy();
  process.stdin?.end(input);
  const end = await new Promise<{
    status: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    process.on("error", reject);
    process.on("close", (status, signal) => resolve({ status, signal }));
  });
  return {
    ...end,
    stdout: Buffer.concat(out).toString("hex"),
    stderr: Buffer.concat(err).toString("hex"),
  };
}
const results: Record<string, unknown>[] = [],
  failures: { id: string; message: string }[] = [];
try {
  for (const row of chosen) {
    const owner = path.join(directory, row.id);
    fs.mkdirSync(owner);
    const cwd = path.join(owner, "cwd");
    fs.mkdirSync(cwd);
    row.setup?.(cwd);
    const input = row.input(cwd),
      inputText = JSON.stringify(input),
      mode = row.stdio ?? "normal";
    const temporary = path.join(owner, "temp");
    fs.mkdirSync(temporary);
    const env = { ...process.env, TMPDIR: temporary };
    let source: unknown;
    let sourceDetails: unknown = null;
    if (input.action !== "frontdoor") {
      const before = process.cwd();
      process.chdir(cwd);
      try {
        source = hexagonReference(structuredClone(input));
        if (input.action === "render" && input.line !== undefined)
          sourceDetails = { negativeZero: Object.is(numeric(input.line), -0) };
      } finally {
        process.chdir(before);
      }
    } else if (row.prepared) {
      const before = process.cwd();
      process.chdir(cwd);
      try {
        const command = defineProgram().exitOverride();
        command.parse(input.argv, { from: "user" });
        const opts = command.opts();
        source = {
          kind: "continue",
          root: fs.realpathSync(path.resolve(command.processedArgs[0])),
          options: opts,
          given: Object.keys(opts).filter(
            (key) => command.getOptionValueSource(key) === "cli",
          ),
        };
      } finally {
        process.chdir(before);
      }
    } else {
      const trace = path.join(owner, "source.trace"),
        request = path.join(owner, "source.request");
      fs.writeFileSync(
        request,
        JSON.stringify({ trace, input, rawArgv: row.rawArgv }),
      );
      const run = await child(
        process.execPath,
        [
          "--import",
          loader,
          path.join(repo, "verification/parity/cli-frontdoor-source.mts"),
          ...(!row.rawArgv ? input.argv : []),
        ],
        undefined,
        cwd,
        mode,
        { ...env, DEMLIK_FRONTDOOR_REQUEST: request },
      );
      assert.ok(fs.existsSync(trace), JSON.stringify(run));
      source = {
        ...run,
        events: fs
          .readFileSync(trace, "utf8")
          .trimEnd()
          .split("\n")
          .map((line) => JSON.parse(line)),
        files: files(cwd),
        residues: fs.readdirSync(temporary),
      };
    }
    removeOwnedTree(cwd);
    fs.mkdirSync(cwd);
    row.setup?.(cwd);
    fs.rmSync(temporary, { recursive: true, force: true });
    fs.mkdirSync(temporary);
    const trace = path.join(owner, "native.trace");
    const native = await child(
      binary,
      [],
      JSON.stringify({ trace, input: JSON.parse(inputText) }),
      cwd,
      mode,
      env,
    );
    const qualifications: string[] = [];
    if (row.rawArgv) qualifications.push("typed-argv-source-injection");
    if (row.prepared) qualifications.push("prepared-component");
    if (row.qualified) qualifications.push(row.qualified);
    let observed: Record<string, unknown> | undefined,
      passed = false;
    try {
      assert.ok(fs.existsSync(trace), JSON.stringify(native));
      observed = z
        .record(z.string(), z.unknown())
        .parse(JSON.parse(fs.readFileSync(trace, "utf8")));
      assert.ok(z.array(z.string()).parse(observed.observedCalls).length);
      if (input.action !== "frontdoor") {
        assert.equal(native.status, 0);
        assert.equal(native.stdout, "");
        assert.equal(native.stderr, "");
        assert.deepEqual(observed.output, source);
        if (sourceDetails !== null)
          assert.deepEqual(observed.details, sourceDetails);
        if (input.action === "run") {
          const details = z
            .record(z.string(), z.unknown())
            .nullable()
            .parse(observed.details);
          const reportInvoked = z
            .object({ events: z.array(z.object({ kind: z.string() })) })
            .parse(source)
            .events.some((event) => event.kind === "report");
          if (
            reportInvoked &&
            input.reportMode !== undefined &&
            input.reportMode !== "ok"
          ) {
            assert.equal(
              z
                .object({
                  report: z.object({ causeMarker: z.literal("report") }),
                })
                .parse(details).report.causeMarker,
              "report",
            );
          }
          if (input.emitMode !== undefined && input.emitMode !== "ok") {
            const processing =
              details && "processing" in details ? details.processing : details;
            assert.equal(
              z
                .object({
                  kind: z.literal("emit"),
                  error: z.object({ causeMarker: z.literal("emit") }),
                })
                .parse(processing).error.causeMarker,
              "emit",
            );
          }
        }
        if (row.fixture && input.action === "read") {
          const expected = JSON.parse(
            fs.readFileSync(
              path.join(
                repo,
                "packages/code-graph/test/hexagon",
                row.fixture,
                "expected.json",
              ),
              "utf8",
            ),
          );
          assert.deepEqual(
            z.object({ value: z.unknown() }).parse(source).value,
            expected,
          );
        }
      } else if (row.prepared) {
        const output = z.record(z.string(), z.unknown()).parse(observed.output);
        const { io: _, ...actual } = output;
        assert.deepEqual(actual, source);
        assert.equal(native.stdout, "");
        assert.equal(native.stderr, "");
      } else {
        const expected = z
          .object({
            status: z.number().nullable(),
            signal: z.unknown(),
            stdout: z.string(),
            stderr: z.string(),
            events: z.array(z.record(z.string(), z.unknown())),
            files: z.record(z.string(), z.string()),
            residues: z.array(z.string()),
          })
          .parse(source);
        const output = z.record(z.string(), z.unknown()).parse(observed.output);
        const io = z
          .object({
            stored: z.number().nullable(),
            requested: z.number().nullable(),
            pending: z.array(
              z.object({
                stream: z.enum(["stdout", "stderr"]),
                osCode: z.number().nullable(),
              }),
            ),
          })
          .parse(output.io);
        assert.equal(native.status, expected.status);
        assert.equal(native.signal, null);
        assert.equal(native.stdout, expected.stdout);
        assert.deepEqual(files(cwd), expected.files);
        assert.deepEqual(
          fs
            .readdirSync(temporary)
            .filter((name) => name.startsWith("code-graph-api-")),
          expected.residues.filter((name) =>
            name.startsWith("code-graph-api-"),
          ),
        );
        const exit = expected.events.find((event) => event.event === "exit"),
          late = expected.events.find((event) => event.event === "uncaught");
        if (row.qualified) {
          assert.equal(output.kind, "hexagon");
          assert.equal(io.stored, 2);
          assert.equal(expected.status, 2);
          const error = z
            .object({
              kind: z.literal("emit"),
              error: z.record(z.string(), z.unknown()),
            })
            .parse(output.failure).error;
          const message = z.string().parse(error.message);
          assert.equal(
            Buffer.from(native.stderr, "hex").toString(),
            `code-graph: ${message}\n`,
          );
          const destination = input.argv
            .find((value) => value.startsWith("--out="))
            ?.slice(6);
          if (row.qualified === "argument-diagnostic") {
            assert.equal(error.name, "TypeError");
            assert.equal(error.code, "ERR_INVALID_ARG_VALUE");
            assert.equal(error.argument, destination);
            assert.equal(error.location, "path");
            assert.equal(error.causeKind, "InvalidInput");
            assert.ok(z.string().parse(error.cause).length);
            assert.match(message, /native argument diagnostic:/);
            assert.match(
              Buffer.from(expected.stderr, "hex").toString(),
              /^code-graph: The argument 'path'.*without null bytes/,
            );
          } else {
            assert.equal(error.name, "Error");
            assert.equal(error.path, destination);
            assert.equal(
              error.osCode,
              destination === "out-directory" ? 21 : 2,
            );
            assert.match(
              Buffer.from(expected.stderr, "hex").toString(),
              destination === "out-directory" ? /EISDIR/ : /ENOENT/,
            );
          }
        } else if (io.pending.length) {
          qualifications.push("stdio-runtime-notification");
          assert.ok(late);
          assert.equal(
            late.code,
            io.pending[0].osCode === 9 ? "EBADF" : "EPIPE",
          );
          assert.equal(late.stream, io.pending[0].stream);
          assert.equal(io.stored, late.exitCode ?? null);
          assert.equal(output.kind, "hexagon");
        } else {
          assert.equal(native.stderr, expected.stderr);
          assert.equal(io.stored, exit?.exitCode ?? null);
        }
        if (row.fixture) {
          const format = input.argv.includes("--json")
            ? input.argv.includes("--pretty")
              ? "pretty"
              : "json"
            : "text";
          const folder = path.join(
            repo,
            "packages/code-graph/test/hexagon",
            row.fixture,
          );
          const text =
            format === "text"
              ? fs.readFileSync(path.join(folder, "expected.txt"), "utf8")
              : format === "json"
                ? fs.readFileSync(path.join(folder, "expected.json"), "utf8")
                : `${JSON.stringify(
                    JSON.parse(
                      fs.readFileSync(
                        path.join(folder, "expected.json"),
                        "utf8",
                      ),
                    ),
                    null,
                    2,
                  )}\n`;
          assert.equal(Buffer.from(expected.stdout, "hex").toString(), text);
        }
      }
      passed = true;
    } catch (error) {
      failures.push({ id: row.id, message: String(error) });
    }
    results.push({
      id: row.id,
      input,
      passed,
      qualifications,
      profile: row.prepared
        ? "prepared-component"
        : input.action === "frontdoor"
          ? row.rawArgv
            ? "typed-argv-cli-process"
            : "full-cli-process"
          : "public-helper",
      source,
      sourceDetails,
      native: {
        ...native,
        trace: observed,
        files: files(cwd),
        residues: fs.readdirSync(temporary),
      },
    });
  }
  const invalid: [string, unknown, RegExp][] = [
    ["malformed-json", "{", /EOF/],
    ["unknown-action", { action: "missing" }, /unknown action/],
    ["wrong-root", { action: "read", root: 7 }, /JavaScript string/],
    ["wrong-text", { action: "ports", text: 7 }, /invalid type/],
    [
      "unknown-field",
      { action: "read", root: "unused", extra: 1 },
      /unknown field/,
    ],
    [
      "missing-report",
      { action: "render", json: true, pretty: false },
      /missing field/,
    ],
    [
      "wrong-line",
      {
        action: "render",
        report: {
          ...emptyReport,
          notRead: [{ file: "ports.ts", line: 1, name: "a", reason: "why" }],
        },
        json: false,
        pretty: false,
        line: "bad",
      },
      /untagged enum/,
    ],
    [
      "wrong-callback",
      {
        action: "run",
        root: "unused",
        json: false,
        pretty: false,
        emitMode: "bad",
      },
      /unknown variant/,
    ],
    ["wrong-argv", { action: "frontdoor", argv: "root" }, /invalid type/],
  ];
  for (const [id, input, diagnostic] of invalid) {
    const trace = path.join(directory, `invalid-${id}.trace`);
    const envelope =
      id === "malformed-json"
        ? String(input)
        : JSON.stringify({ trace, input });
    const native = await child(
      binary,
      [],
      envelope,
      directory,
      "normal",
      process.env,
    );
    let passed = false;
    try {
      assert.notEqual(native.status, 0);
      assert.equal(native.stdout, "");
      assert.equal(fs.existsSync(trace), false);
      assert.match(Buffer.from(native.stderr, "hex").toString(), diagnostic);
      passed = true;
    } catch (error) {
      failures.push({ id: `invalid.${id}`, message: String(error) });
    }
    results.push({
      id: `invalid.${id}`,
      valid: false,
      passed,
      input,
      native,
      observedCalls: [],
    });
  }
  const passing = results.filter(
    (row) => row.valid !== false && row.passed === true,
  );
  const evidence = (qualified: boolean) =>
    Object.fromEntries(
      passing
        .filter(
          (row) => (row.qualifications as string[]).length > 0 === qualified,
        )
        .map((row) => [
          row.id,
          (row.native as { trace: { observedCalls: string[] } }).trace
            .observedCalls,
        ]),
    );
  const report = {
    passed: passing.length,
    attempted: chosen.length,
    unqualifiedPairs: passing.filter(
      (row) => (row.qualifications as string[]).length === 0,
    ).length,
    qualifiedPairs: passing.filter(
      (row) => (row.qualifications as string[]).length > 0,
    ).length,
    rejectedInvalidInputs: results.filter(
      (row) => row.valid === false && row.passed === true,
    ).length,
    profiles: Object.fromEntries(
      [
        "public-helper",
        "full-cli-process",
        "typed-argv-cli-process",
        "prepared-component",
      ].map((profile) => {
        const rows = passing.filter((row) => row.profile === profile);
        return [
          profile,
          {
            passed: rows.length,
            exact: rows.filter(
              (row) => (row.qualifications as string[]).length === 0,
            ).length,
          },
        ];
      }),
    ),
    driverSha256: createHash("sha256")
      .update(fs.readFileSync(binary))
      .digest("hex"),
    reference: {
      node: process.version,
      v8: process.versions.v8,
      sourceHashes: Object.fromEntries(
        [
          "hexagon/ports.ts",
          "hexagon/read.ts",
          "hexagon/render.ts",
          "hexagon/cli.ts",
          "cli.ts",
          "index.ts",
        ].map((file) => [
          file,
          createHash("sha256")
            .update(
              fs.readFileSync(path.join(repo, "packages/code-graph/src", file)),
            )
            .digest("hex"),
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
      rejectedInvalidInputs: report.rejectedInvalidInputs,
      failures,
    }),
  );
  assert.deepEqual(failures, []);
} finally {
  removeOwnedTree(directory);
}
function unreadableDirectories(cwd: string, names: string[]) {
  sourceProject(cwd, "export type A={};", {});
  fs.mkdirSync(path.join(root(cwd), "adapters"));
  for (const name of names) {
    const directory = path.join(root(cwd), "adapters", name);
    fs.mkdirSync(directory);
    fs.chmodSync(directory, 0);
  }
}
function removeOwnedTree(directory: string) {
  function writable(directory: string) {
    fs.chmodSync(directory, 0o700);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }))
      if (entry.isDirectory() && !entry.isSymbolicLink())
        writable(path.join(directory, entry.name));
  }
  writable(directory);
  fs.rmSync(directory, { recursive: true, force: true });
}
