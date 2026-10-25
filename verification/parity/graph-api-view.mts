import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { tsgoBinary } from "../../packages/code-graph/src/engine/tsgo.js";
import {
  type ApiViewInput,
  apiViewReference,
  apiViewSchema,
  COMMENT_PROBES,
} from "./api-view-reference.mjs";

const binary = process.argv[2];
assert.ok(binary, "provide compiled API view driver");
assert.ok(process.argv.length <= 4);
assert.equal(process.version, "v22.21.1");
assert.equal(process.versions.v8, "12.4.254.21-node.33");
const repository = fileURLToPath(new URL("../..", import.meta.url));
const manifest = createRequire(
  path.join(repository, "packages/code-graph/package.json"),
).resolve("@typescript/native-preview/package.json");
const directory = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "demlik-api-view-")),
);
const compilerTemp = path.join(directory, "compiler-temp");
fs.mkdirSync(compilerTemp);
const previousTemp = process.env.TMPDIR;
process.env.TMPDIR = compilerTemp;
type Case = {
  id: string;
  operation: "code_graph.api-view";
  input: ApiViewInput;
};
const cases: Case[] = [];
const add = (id: string, input: unknown) => {
  const row: Case = {
    id,
    operation: "code_graph.api-view",
    input: apiViewSchema.parse(input),
  };
  cases.push(row);
  return row;
};
const fixtures = new Map<string, Record<string, string>>();
const links: [string, string][] = [];
const config = (extra: object = {}) =>
  JSON.stringify({
    compilerOptions: {
      strict: true,
      target: "ESNext",
      module: "ESNext",
      types: [],
      ...extra,
    },
    include: ["src/**/*"],
  });
function project(label: string, files: Record<string, string>) {
  const root = path.join(directory, label);
  fixtures.set(root, files);
  return root;
}
function reset() {
  for (const [root, files] of fixtures) {
    fs.rmSync(root, { recursive: true, force: true });
    for (const [name, text] of Object.entries(files)) {
      const target = path.join(root, name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, text);
    }
  }
  for (const [link, target] of links) {
    fs.rmSync(link, { force: true, recursive: true });
    fs.symlinkSync(target, link);
  }
}
const read = (
  id: string,
  root: string,
  map: unknown = { ".": { entry: "src/index.ts", tier: "stable" } },
  extra: object = {},
) =>
  add(id, {
    action: "read",
    root,
    map,
    repoRoot: null,
    warn: "collect",
    ...extra,
  });
const part = (
  root: string,
  entry = "src/index.ts",
  subpath = ".",
  tier: string | null = "stable",
) => ({ subpath, entry, entryAbsolute: path.resolve(root, entry), tier });
const emit = (id: string, root: string, entry = "src/index.ts") =>
  add(id, {
    action: "emit",
    root,
    config: path.join(root, "tsconfig.json"),
    subpaths: [part(root, entry)],
  });
const emitted = (
  id: string,
  root: string,
  subpaths = [part(root)],
  extra: object = {},
) =>
  add(id, {
    action: "emitted",
    root,
    subpaths,
    repoRoot: null,
    warn: "collect",
    context: null,
    ...extra,
  });
try {
  for (const [i, text] of COMMENT_PROBES.entries())
    add(`text-retained-${i}`, { action: "text", text });
  for (const unit of [
    0, 9, 10, 11, 12, 13, 32, 0x85, 0xa0, 0x1680, 0x2000, 0x200b, 0x2028,
    0x2029, 0x202f, 0x205f, 0x3000, 0xfeff, 0xd800, 0xdfff, 0xfffd,
  ]) {
    const char = String.fromCharCode(unit);
    add(`text-unicode-${unit}`, {
      action: "text",
      text: `${char}// gone${char}\n type X = "${char}/*keep*/"; /* tail */${char}`,
    });
  }
  for (const [i, text] of [
    'type T = `a\u0024{{b:1}["b"]}c`; /* end */',
    'type T = `a\u0024{`nested\u0024{"/*kept*/"}`}z`; // end',
    "a/*x*/b//y\r\nc",
    "a\\u{61}/*x*/b",
    "/* all */",
    "",
    " \r\n\t ",
    "#! // kept\n/* gone */x",
    "<<<<<<< ours // kept\nx /* gone */\n=======\n y // kept\n>>>>>>> theirs /* kept */\nz/* gone */",
    "a\r b\r\n c\n",
    "type T = 'continued\\\r\n/*kept*/'; // end",
  ].entries())
    add(`text-crafted-${i}`, { action: "text", text });
  const descriptor = {
    temp: "/temp",
    out: "/emit/out",
    compiler: "raw\ud800",
    diagnostics: "NaN",
  };
  for (const [i, entry] of [
    "/package/src/a.ts",
    "/package/src/a.tsx",
    "/package/src/a.mts",
    "/package/src/a.cts",
    "/package/src/a.d.ts",
    "/package/src/a.js",
    "/package/src/a.ts\n",
    "/package/src/raw\ud800.ts",
    "/package/src/a.ts/",
    "/else/a.ts",
    "/package",
    "relative.ts",
  ].entries())
    add(`emitted-file-${i}`, {
      action: "file",
      emit: descriptor,
      root: "/package",
      entry,
    });
  const real = path.join(repository, "packages/code-graph/test/api/fixture");
  const realMap = JSON.parse(
    fs.readFileSync(path.join(real, "api-map.json"), "utf8"),
  );
  read("existing-four-entry-fixture", real, realMap);
  read("existing-four-entry-repeat", real, realMap);
  const all = project("all-kinds", {
    "tsconfig.json": config(),
    "src/index.ts": [
      "interface Private { readonly hidden: string }",
      "type Options = Private & { retries: number };",
      "declare const Brand: unique symbol;",
      "export interface PublicBase { readonly id: number }",
      "class LocalBase { readonly base = 1; }",
      "export class Derived extends LocalBase implements PublicBase { readonly id = 1; use(value: Options): Private { return value; } }",
      "export interface Branded { readonly [Brand]: Options }",
      "export type Imported = import('./helper').Hidden;",
      "export type Query = typeof Brand;",
      "export function over(n: string): string;",
      "export function over(n: number): number;",
      "export function over(n: string | number): string | number { return n; }",
      "export interface Merge { readonly value: Private }",
      "export namespace Merge { export type Item = Private; export const current = 1; }",
      "export enum Mode { One, Two }",
      "export const first = 1, second = 2;",
      "export default class DefaultClass { readonly x = 1; }",
      "export { named as renamed } from './helper';",
      "export * from './helper';",
      "export * as space from './helper';",
    ].join("\n"),
    "src/helper.ts":
      "export interface Hidden { readonly name: string }\nexport const named = 3;\n",
    "src/empty.ts": "export {};",
  });
  const allMap = {
    ".": { entry: "src/index.ts", tier: "opaque" },
    "./helper": { entry: "src/helper.ts" },
    "./empty": { entry: "src/empty.ts" },
  };
  read("every-declaration-kind-and-reference-shape", all, allMap);
  read("numeric-subpath-object-enumeration", all, {
    "2": { entry: "src/helper.ts" },
    "10": { entry: "src/index.ts" },
    "01": { entry: "src/empty.ts" },
    "raw\ud800": { entry: "src/helper.ts" },
  });
  emit("emit-every-declaration-kind", all);
  emitted("emitted-one-tree-multiple-subpaths", all, [
    part(all),
    part(all, "src/helper.ts", "./helper"),
    part(all, "src/empty.ts", "./empty", null),
  ]);
  const cycle = project("cycle", {
    "tsconfig.json": config(),
    "src/index.ts":
      "type A = { b: B }; interface B { a: A } export function api(a: A): B {return a.b;}",
  });
  read("private-reference-cycle", cycle);
  emit("emit-private-reference-cycle", cycle);
  const published = project("published", {
    "tsconfig.json": config(),
    "src/index.ts":
      "export interface P { q: Q }; interface Q { n: number }; export function api(p: P): Q {return p.q;}",
  });
  read("published-reference-is-not-inlined", published);
  const namespace = project("namespace", {
    "tsconfig.json": config(),
    "src/index.ts":
      "declare namespace Local { interface Private { x: number }; interface Other { p: Private }; } export function api(x: Local.Other): Local.Private {return x.p;} export namespace Public { export interface Kept {x: Local.Private} }",
  });
  read("private-namespace-reference-and-published-ancestor", namespace);
  const alias = project("aliases", {
    "tsconfig.json": config(),
    "src/index.ts":
      "export { over as a, over as b } from './fns'; export { default as renamedDefault } from './fns'; export type { T as RenamedType } from './fns';",
    "src/fns.ts":
      "type Private = {x: number}; export function over(x: Private): Private; export function over(x: Private) {return x;} export default function own(x: Private) {return x;} export type T = Private;",
  });
  read("aliases-keep-declared-text-and-fresh-facts", alias);
  const dependency = project("dependency", {
    "tsconfig.json": config({
      module: "NodeNext",
      moduleResolution: "NodeNext",
    }),
    "package.json": '{"type":"module"}',
    "src/index.ts":
      "export { external, type External } from 'dep'; import type {External} from 'dep'; export function own(x: External): External {return x;}",
    "node_modules/dep/package.json":
      '{"name":"dep","type":"module","exports":{"types":"./index.d.ts"}}',
    "node_modules/dep/index.d.ts":
      "interface DependencyPrivate { readonly x: number }\nexport interface External { readonly p: DependencyPrivate }\nexport declare function external(p: DependencyPrivate): External;\n",
  });
  read("dependency-alias-text-without-external-reference-walk", dependency);
  emit("emit-installs-real-dependency-link", dependency);
  const suffix = project("suffixes", {
    "tsconfig.json": config({
      module: "NodeNext",
      moduleResolution: "NodeNext",
    }),
    "src/index.mts": "export const esm = 1;",
    "src/index.cts": "export = class Cjs { readonly n = 2; };",
    "src/view.tsx": "export const fn = (n: number) => n;",
    "src/allowed.d.tsx": "export const allowed = 1;",
  });
  read("mts-cts-tsx-and-dtsx", suffix, {
    "./mts": { entry: "src/index.mts" },
    "./cts": { entry: "src/index.cts" },
    "./tsx": { entry: "src/view.tsx" },
    "./dtsx": { entry: "src/allowed.d.tsx" },
  });
  for (const entry of [
    "src/index.mts",
    "src/index.cts",
    "src/view.tsx",
    "src/allowed.d.tsx",
  ])
    emit(`emit-suffix-${entry}`, suffix, entry);
  const names = project("export-names", {
    "tsconfig.json": config(),
    "src/index.ts":
      'const local = 1; export { local as "__proto__", local as "constructor", local as "2", local as "1", local as "10", local as "raw\\ud800", local as "😀", local as "", local as "___lead" };',
  });
  read("producer-prototype-numeric-and-unicode-export-names", names);
  emitted("reader-prototype-is-a-separate-owned-fact", names);
  const importTypes = project("import-types", {
    "tsconfig.json": config(),
    "src/index.ts": [
      "export type Imported = import('./hidden').Hidden;",
      "export type Reexported = import('./relay').Renamed;",
      "export type Qualified = import('./hidden').Local.Nested;",
      "export type Value = typeof import('./hidden').value;",
      "export type Generic = import('./hidden').Box<string>;",
      "export type Unqualified = typeof import('./hidden');",
      "export type Unknown = import('./missing').Missing;",
    ].join("\n"),
    "src/hidden.ts": [
      "interface Private { readonly private: string }",
      "export interface Hidden { readonly p: Private }",
      "export namespace Local { export interface Nested { readonly hidden: Hidden } }",
      "export const value = { n: 1 };",
      "export interface Box<T> { value: T }",
    ].join("\n"),
    "src/relay.ts": "export { type Hidden as Renamed } from './hidden';",
    "src/published.ts":
      "export { type Hidden } from './hidden'; export type Imported = import('./hidden').Hidden;",
  });
  read("import-type-exported-private-qualified-reexported", importTypes);
  read("import-type-published-target-is-not-inlined", importTypes, {
    ".": { entry: "src/published.ts" },
  });
  read("import-types-across-separate-published-subpaths", importTypes, {
    ".": { entry: "src/index.ts" },
    "./hidden": { entry: "src/hidden.ts" },
    "./relay": { entry: "src/relay.ts" },
  });
  const shared = project("multi-vars", {
    "tsconfig.json": config(),
    "src/index.ts":
      "type P = {x:number}; export const a: P = {x:1}, b: P = {x:2}; export function f(): typeof a {return a;}",
  });
  read("whole-variable-statement-deduplication", shared);
  const deep = project("deep-references", {
    "tsconfig.json": config(),
    "src/index.ts": [
      ...Array.from(
        { length: 80 },
        (_, i) => `interface T${i} { next: T${(i + 1) % 80} }`,
      ),
      "export function api(x: T0): T40 { return x as unknown as T40; }",
    ].join("\n"),
  });
  read("eighty-private-references-terminate-and-stay-unique", deep);
  for (const [i, flags] of [
    {
      noEmit: true,
      noEmitOnError: true,
      declaration: false,
      declarationMap: true,
      incremental: true,
      composite: true,
    },
    { removeComments: true },
    { removeComments: false, emitBOM: true },
    { stripInternal: true },
  ].entries()) {
    const root = project(`flags-${i}`, {
      "tsconfig.json": config(flags),
      "src/index.ts":
        "/** docs */\nexport interface Public { /* inline */ readonly x: number; }\n/** @internal */ export const hidden = 1;\n",
    });
    read(`emit-flags-${i}`, root);
    emit(`emit-files-flags-${i}`, root);
  }
  const typeErrors = project("type-errors", {
    "tsconfig.json": config({ noEmitOnError: true }),
    "src/index.ts":
      "export const a: string = 1; export const b: boolean = 2; export function f(): number {return 'bad';}",
  });
  read("type-errors-still-publish", typeErrors);
  read("warning-callback-failure-cleans-temp", typeErrors, undefined, {
    warn: "fail",
  });
  read("default-warning-stderr", typeErrors, undefined, { warn: "default" });
  emitted("warning-context-is-raw-text", typeErrors, undefined, {
    context: " at raw\ud800 base",
  });
  emit("emit-diagnostic-count", typeErrors);
  const missing = project("missing-config", {
    "src/index.ts": "export const x = 1;",
  });
  read("missing-package-config-refusal", missing);
  emitted("raw-config-refusal", `${missing}/raw\ud800`, []);
  const invalid = project("invalid-config", {
    "tsconfig.json": "{\n broken",
    "src/index.ts": "export const x = 1;",
  });
  read("malformed-config-keeps-warning-and-refusal", invalid);
  emit("malformed-config-emit-refuses-missing-declaration", invalid);
  const excluded = project("excluded-entry", {
    "tsconfig.json": JSON.stringify({
      compilerOptions: { types: [] },
      files: ["included.ts"],
    }),
    "included.ts": "export const yes=1;",
    "src/index.ts": "export const excluded=1;",
  });
  read("excluded-entry-has-no-emitted-file", excluded);
  emitted("warning-failure-precedes-entry-check", invalid, undefined, {
    warn: "fail",
  });
  const syntax = project("syntax-errors", {
    "tsconfig.json": config(),
    "src/index.ts":
      "export const broken: = 1;\nexport function f( { return 1; }",
  });
  read("syntax-diagnostics-remain-observable", syntax);
  const acceptedErrors = project("accepted-large-diagnostics", {
    "tsconfig.json": config(),
    "src/index.ts": Array.from(
      { length: 8000 },
      (_, i) => `export const n${i}: string = 1;`,
    ).join("\n"),
  });
  read("eight-thousand-canonical-diagnostics-publish", acceptedErrors);
  emit("eight-thousand-canonical-diagnostics-emit", acceptedErrors);
  const longErrors = project("large-diagnostics", {
    "tsconfig.json": config(),
    "src/index.ts": Array.from(
      { length: 16000 },
      (_, i) => `export const n${i}: string = 1;`,
    ).join("\n"),
  });
  read("node-buffer-limit-refusal-and-temp-cleanup", longErrors);
  emit("node-buffer-limit-direct-emit", longErrors);
  const parent = project("parent-config", {
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        strict: true,
        target: "ESNext",
        module: "ESNext",
        types: [],
      },
      include: ["pkg/src/**/*"],
    }),
    "pkg/src/index.ts": "export const inherited=1;",
  });
  read("package-config-can-be-an-ancestor", path.join(parent, "pkg"));
  read(
    "package-scope-repo-option-is-passed-with-source-precedence",
    all,
    allMap,
    { repoRoot: path.join(directory, "missing-repo") },
  );
  const link = path.join(directory, "linked-package");
  links.push([link, alias]);
  read("realpath-symlink-package", link);
  const raw = project("raw�", {
    "tsconfig.json": config(),
    "src/index.ts": "export const raw=1;",
  });
  read("raw-root-encodes-only-at-filesystem", raw.replace("raw�", "raw\ud800"));
  read("ordinary-published-null-root-refuses-before-emit", `${all}\0`);
  read("ordinary-published-null-entry-refuses-before-emit", all, {
    ".": { entry: "src/index.ts\0" },
  });
  read("invalid-map-after-valid-package", all, {});
  read(
    "package-refusal-precedes-invalid-map",
    path.join(directory, "no-package"),
    {},
  );
  read("constructor-null-map-remains-a-typeerror", all, { constructor: null });
  for (const [i, root] of [
    all,
    `${all}/../all-kinds/`,
    path.join(all, "src/index.ts"),
    path.join(directory, "missing-\ud800"),
    raw.replace("raw�", "raw\udfff"),
  ].entries())
    add(`package-root-${i}`, { action: "package", root });
  const realpathRoot = project("realpath", {
    "raw�/ordinary/kept.ts": "export {};",
    "target/suffix�/kept.ts": "export {};",
  });
  const realpathRaw = path.join(realpathRoot, "raw\ud800");
  links.push(
    [path.join(realpathRaw, "relative-link"), "ordinary"],
    [
      path.join(realpathRaw, "absolute-link"),
      path.join(realpathRoot, "target"),
    ],
    [path.join(realpathRoot, "entry-link"), realpathRaw],
    [path.join(realpathRoot, "chain"), "entry-link"],
    [path.join(realpathRoot, "dangling"), "missing"],
    [path.join(realpathRoot, "broken-parent"), "missing/child"],
  );
  for (const [id, root] of [
    ["plain-high", realpathRaw],
    ["plain-low", realpathRaw.replace("\ud800", "\udfff")],
    ["literal-replacement", realpathRaw.replace("\ud800", "�")],
    ["raw-ancestor", path.join(realpathRaw, "ordinary")],
    ["raw-before-relative-link", path.join(realpathRaw, "relative-link")],
    ["raw-before-absolute-link", path.join(realpathRaw, "absolute-link")],
    [
      "raw-suffix-after-link",
      path.join(realpathRaw, "absolute-link", "suffix\ud800"),
    ],
    ["raw-in-symlink-target", path.join(realpathRoot, "entry-link")],
    ["chain-target", path.join(realpathRoot, "chain", "ordinary")],
    ["dangling", path.join(realpathRoot, "dangling")],
    ["broken-parent", path.join(realpathRoot, "broken-parent")],
  ] as const)
    add(`realpath-${id}`, { action: "package", root });
  emitted("empty-emitted-map-still-runs-the-source-program", all, []);
  const declarations = project("manual-emitted", {
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        strict: true,
        target: "ESNext",
        module: "ESNext",
        types: [],
      },
      files: [],
    }),
    "raw�/entry.d.ts":
      "interface Private { x: number; } export declare function api(x: Private): Private; export {};",
    "out/entry.d.ts":
      "/** top */\ninterface Private { x: number; }\nexport declare function api(x: Private): Private;\nexport declare const one: Private, two: Private;\nexport { api as alias };\n",
    "out/empty.d.ts": "declare const script: 1;",
    "out/ns.d.ts":
      "declare namespace N { interface Hidden {x: number} }\nexport declare const api: N.Hidden;\n",
    "out/merged.d.ts":
      "export interface Merge { x: P }\nexport declare namespace Merge { export const n: 1; }\ninterface P { next: P }\n",
    "out/source.d.ts":
      '\ufeff/** docs */\r\nexport declare const a: string, b: number; // tail\r\nexport declare function f(): `a\u0024{{b: 1}["b"]}c`;\r\n',
  });
  for (const file of [
    "entry.d.ts",
    "empty.d.ts",
    "ns.d.ts",
    "merged.d.ts",
    "source.d.ts",
    "missing.d.ts",
  ]) {
    add(`read-subpath-${file}`, {
      action: "program",
      config: path.join(declarations, "tsconfig.json"),
      out: path.join(declarations, "out"),
      entries: [
        [".", path.join(declarations, "out", file)],
        ["./again", path.join(declarations, "out", file)],
      ],
    });
  }
  add("unpublished-out-prefix-is-raw-not-lossy", {
    action: "program",
    config: path.join(declarations, "tsconfig.json"),
    out: `${declarations}/raw\ud800`,
    entries: [[".", path.join(declarations, "raw�/entry.d.ts")]],
  });
  add("declaration-text-variable-and-source-file-ranges", {
    action: "nodes",
    config: path.join(declarations, "tsconfig.json"),
    file: path.join(declarations, "out/source.d.ts"),
    select: [
      { kind: "SourceFile", nth: 0 },
      { kind: "VariableDeclaration", nth: 0 },
      { kind: "VariableDeclaration", nth: 1 },
      { kind: "FunctionDeclaration", nth: 0 },
    ],
  });
  const removeRoot = project("remove", {
    "file.txt": "owned",
    "dir/child.txt": "owned",
    "target/kept.txt": "kept",
    "parent.txt": "not a directory",
  });
  const removeLink = path.join(removeRoot, "link");
  links.push([removeLink, path.join(removeRoot, "target")]);
  for (const name of ["file.txt", "dir", "link", "missing"])
    add(`remove-${name}`, {
      action: "remove",
      temp: path.join(removeRoot, name),
      watch: [path.join(removeRoot, "target/kept.txt")],
    });
  reset();
  const diagnosticOutputProfiles = [];
  const compiler = await tsgoBinary();
  for (const [root, count] of [
    [acceptedErrors, 8000],
    [longErrors, 16000],
  ] as const) {
    const out = fs.mkdtempSync(path.join(compilerTemp, "observed-output-"));
    try {
      const args = [
        "-p",
        path.join(root, "tsconfig.json"),
        "--noEmit",
        "false",
        "--declaration",
        "--emitDeclarationOnly",
        "--declarationMap",
        "false",
        "--noEmitOnError",
        "false",
        "--incremental",
        "false",
        "--composite",
        "false",
        "--rootDir",
        root,
        "--outDir",
        out,
      ];
      const observed = spawnSync(compiler.path, args, {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      });
      assert.equal(observed.error, undefined);
      diagnosticOutputProfiles.push({
        rows: count,
        cwd: root,
        root,
        args,
        status: observed.status,
        stdoutBytes: Buffer.byteLength(observed.stdout),
        stderrBytes: Buffer.byteLength(observed.stderr),
      });
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  }
  const expected: unknown[] = [];
  let defaultStderr = "";
  for (const item of cases) {
    if (
      (item.input.action === "read" || item.input.action === "emitted") &&
      item.input.warn === "default"
    ) {
      const source = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          fileURLToPath(new URL("./api-view-reference.mts", import.meta.url)),
          "--single",
          JSON.stringify(item.input),
        ],
        { encoding: "utf8", maxBuffer: 128 * 1024 * 1024 },
      );
      assert.equal(source.status, 0, source.stderr);
      expected.push(JSON.parse(source.stdout));
      defaultStderr += source.stderr;
    } else
      expected.push(
        JSON.parse(JSON.stringify(await apiViewReference(item.input))),
      );
  }
  const at = (id: string) => expected[cases.findIndex((row) => row.id === id)];
  const existing = z
    .object({
      view: z.object({
        subpaths: z.record(
          z.string(),
          z.object({ names: z.record(z.string(), z.unknown()) }),
        ),
      }),
      tempClean: z.literal(true),
    })
    .parse(at("existing-four-entry-fixture"));
  assert.equal(Object.keys(existing.view.subpaths).length, 4);
  assert.equal(Object.keys(existing.view.subpaths["."].names).length, 4);
  assert.deepEqual(
    at("existing-four-entry-repeat"),
    at("existing-four-entry-fixture"),
  );
  const deepView = z
    .object({
      view: z.object({
        subpaths: z.object({
          ".": z.object({
            names: z.object({
              api: z.object({ references: z.record(z.string(), z.string()) }),
            }),
          }),
        }),
      }),
    })
    .parse(at("eighty-private-references-terminate-and-stay-unique"));
  assert.equal(
    Object.keys(deepView.view.subpaths["."].names.api.references).length,
    80,
  );
  const largeAccepted = z
    .object({
      view: z.object({
        subpaths: z.object({
          ".": z.object({ names: z.record(z.string(), z.unknown()) }),
        }),
      }),
      warnings: z.array(z.string()),
      tempClean: z.literal(true),
    })
    .parse(at("eight-thousand-canonical-diagnostics-publish"));
  assert.equal(
    Object.keys(largeAccepted.view.subpaths["."].names).length,
    8000,
  );
  assert.equal(largeAccepted.warnings.length, 1);
  assert.match(largeAccepted.warnings[0], /reported 1 diagnostic/);
  assert.equal(
    z
      .object({ diagnostics: z.number() })
      .parse(at("eight-thousand-canonical-diagnostics-emit")).diagnostics,
    1,
  );
  assert.ok(diagnosticOutputProfiles[0].stdoutBytes < 1024 * 1024);
  assert.ok(diagnosticOutputProfiles[1].stdoutBytes > 1024 * 1024);
  const importView = z
    .object({
      view: z.object({
        subpaths: z.object({
          ".": z.object({
            names: z.record(
              z.string(),
              z.object({ references: z.record(z.string(), z.string()) }),
            ),
          }),
        }),
      }),
    })
    .parse(at("import-type-exported-private-qualified-reexported"));
  assert.equal(
    Object.keys(importView.view.subpaths["."].names.Imported.references).length,
    2,
  );
  assert.ok(
    Object.hasOwn(
      importView.view.subpaths["."].names.Reexported.references,
      "src/hidden.d.ts#Hidden",
    ),
  );
  assert.ok(
    Object.hasOwn(
      importView.view.subpaths["."].names.Qualified.references,
      "src/hidden.d.ts#Nested",
    ),
  );
  assert.match(
    z
      .object({ thrown: z.object({ message: z.string() }) })
      .parse(at("node-buffer-limit-direct-emit")).thrown.message,
    / ENOBUFS$/,
  );
  assert.equal(
    z
      .object({ tempClean: z.boolean() })
      .parse(at("warning-callback-failure-cleans-temp")).tempClean,
    true,
  );
  const invalidInputs: unknown[] = [
    {
      id: "bad-operation",
      operation: "other",
      input: { action: "text", text: "x" },
    },
    {
      id: "bad-extra",
      operation: "code_graph.api-view",
      input: { action: "text", text: "x", extra: 1 },
    },
    {
      id: "bad-text",
      operation: "code_graph.api-view",
      input: { action: "text", text: null },
    },
    {
      id: "missing-map",
      operation: "code_graph.api-view",
      input: { action: "read", root: all, repoRoot: null, warn: "collect" },
    },
    {
      id: "bad-warn",
      operation: "code_graph.api-view",
      input: {
        action: "read",
        root: all,
        map: {},
        repoRoot: null,
        warn: "ignore",
      },
    },
    {
      id: "bad-subpath-field",
      operation: "code_graph.api-view",
      input: {
        action: "emitted",
        root: all,
        subpaths: [{ entry: "src/index.ts" }],
        repoRoot: null,
        warn: "collect",
        context: null,
      },
    },
    {
      id: "bad-node-kind",
      operation: "code_graph.api-view",
      input: {
        action: "nodes",
        config: path.join(declarations, "tsconfig.json"),
        file: path.join(declarations, "out/source.d.ts"),
        select: [{ kind: "FakeKind", nth: 0 }],
      },
    },
  ];
  reset();
  const requests = [...cases, ...invalidInputs];
  const run = spawnSync(binary, [manifest], {
    input: `${requests.map((item) => JSON.stringify(item)).join("\n")}\n`,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
    env: { ...process.env, TMPDIR: compilerTemp },
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stderr, defaultStderr);
  const reply = z.strictObject({
    id: z.string().nullable(),
    ok: z.boolean(),
    output: z.unknown().optional(),
    error: z.strictObject({ tag: z.string(), message: z.string() }).optional(),
    observedCalls: z.array(z.string()),
  });
  const answers = run.stdout
    .trimEnd()
    .split("\n")
    .map((line) => reply.parse(JSON.parse(line)));
  assert.equal(answers.length, requests.length);
  const failures = [];
  for (const [i, item] of cases.entries()) {
    try {
      assert.equal(answers[i].id, item.id);
      assert.equal(answers[i].ok, true, JSON.stringify(answers[i].error));
      assert.deepEqual(answers[i].output, expected[i]);
      assert.ok(answers[i].observedCalls.length);
    } catch (error) {
      failures.push({
        id: item.id,
        error: String(error),
        expected: expected[i],
        actual: answers[i],
      });
    }
  }
  for (const [i] of invalidInputs.entries()) {
    const answer = answers[cases.length + i];
    assert.equal(answer.ok, false);
    assert.equal(answer.error?.tag, "driver-error");
    assert.deepEqual(answer.observedCalls, []);
  }
  const declarationCleanupQualification = [];
  for (const [id, root, config] of [
    ["direct-null-root", `${all}\0`, path.join(all, "tsconfig.json")],
    ["direct-null-config", all, `${path.join(all, "tsconfig.json")}\0`],
  ] as const) {
    const input = apiViewSchema.parse({
      action: "emit",
      root,
      config,
      subpaths: [],
    });
    const before = fs.readdirSync(compilerTemp);
    const source = await apiViewReference(input);
    const created = fs
      .readdirSync(compilerTemp)
      .filter((name) => !before.includes(name));
    const run = spawnSync(binary, [manifest], {
      input: `${JSON.stringify({ id, operation: "code_graph.api-view", input })}\n`,
      encoding: "utf8",
      env: { ...process.env, TMPDIR: compilerTemp },
    });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stderr, "");
    const native = reply.parse(JSON.parse(run.stdout));
    assert.equal(native.ok, true);
    assert.ok(native.observedCalls.length);
    assert.equal(
      z.object({ tempClean: z.literal(false) }).parse(source).tempClean,
      false,
    );
    const refusal = z
      .object({
        tempClean: z.literal(true),
        thrown: z.object({
          name: z.literal("TypeError"),
          code: z.literal("ERR_INVALID_ARG_VALUE"),
          argument: z.string(),
          location: z.string(),
        }),
      })
      .parse(native.output);
    assert.equal(
      refusal.thrown.argument,
      id === "direct-null-root" ? root : config,
    );
    assert.equal(
      refusal.thrown.location,
      id === "direct-null-root" ? "args[15]" : "args[1]",
    );
    declarationCleanupQualification.push({
      id,
      input,
      strictCoverageExcluded: true,
      reason:
        "Native retains cleanup on all paths; Source direct emit leaks temp when spawnSync throws for NUL before its run.error cleanup branch. The ordinary published view refuses these values before emit.",
      source,
      sourceCreatedTemps: created,
      native,
    });
    for (const name of created)
      fs.rmSync(path.join(compilerTemp, name), {
        recursive: true,
        force: true,
      });
  }
  const sourceFiles = [
    "api/emit.ts",
    "api/view.ts",
    "api/read.ts",
    "api/text.ts",
  ];
  const report = {
    passed: cases.length - failures.length,
    attempted: cases.length,
    rejectedInvalidInputs: invalidInputs.length,
    reference: {
      node: process.version,
      v8: process.versions.v8,
      compiler: compiler.version,
      binary: compiler.path,
      sourceHashes: Object.fromEntries(
        sourceFiles.map((name) => [
          name,
          createHash("sha256")
            .update(
              fs.readFileSync(
                path.join(repository, "packages/code-graph/src", name),
              ),
            )
            .digest("hex"),
        ]),
      ),
      native:
        "actual native declaration CLI, TypeProgram/RPC/AST export/reference reader, text cleanup and file entry helpers",
    },
    caseCounts: Object.fromEntries(
      [...new Set(cases.map((item) => item.input.action))].map((action) => [
        action,
        cases.filter((item) => item.input.action === action).length,
      ]),
    ),
    defaultStderr,
    diagnosticOutputProfiles,
    declarationCleanupQualification,
    failures,
    cases: requests.map((item, i) => ({
      ...Object(item),
      expected: i < cases.length ? expected[i] : { rejected: true },
      ...answers[i],
    })),
  };
  if (process.argv[3])
    fs.writeFileSync(process.argv[3], `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(
    `${JSON.stringify({ passed: report.passed, attempted: report.attempted, rejectedInvalidInputs: invalidInputs.length, failures: failures.map((row) => row.id), caseCounts: report.caseCounts })}\n`,
  );
  assert.deepEqual(
    failures.map((row) => row.id),
    [],
  );
} finally {
  if (previousTemp === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = previousTemp;
  fs.rmSync(directory, { recursive: true, force: true });
}
