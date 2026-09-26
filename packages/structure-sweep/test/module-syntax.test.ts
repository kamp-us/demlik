import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  readModule,
  specifierResolver,
  staticDependencies,
} from "../src/module-syntax.js";
import { gitIn, repo, withSubmodule, write } from "./helpers.js";

const specifiers = (list: readonly { specifier: string }[]) =>
  list.map((s) => s.specifier);

describe("readModule", () => {
  it("reads a multi-line import whose bindings hold a comment with a quote", () => {
    const text = [
      "import {",
      "  alpha, // don't inline",
      '  beta, // say "no"',
      '} from "./x";',
      "export const gamma = alpha + beta;",
    ].join("\n");
    const syntax = readModule("src/a.ts", text);
    expect(syntax.parsed).toBe(true);
    expect(specifiers(syntax.imports)).toEqual(["./x"]);
    const [statement] = syntax.imports;
    expect(text.slice(statement?.start, statement?.end)).toBe(
      text.split("\nexport")[0],
    );
  });

  it("reads exported names in any script, every declarator, and a named default", () => {
    const syntax = readModule(
      "src/a.ts",
      [
        "export class ÖdemeServisi {}",
        "export const kullanıcıAdı = 1, ikinci = 2;",
        "export function 函数() {}",
        "export default function varsayılan() {}",
        "const local = 1;",
        "export { local as dışa };",
        "export default local;",
      ].join("\n"),
    );
    expect(syntax.exports).toEqual([
      "ÖdemeServisi",
      "kullanıcıAdı",
      "ikinci",
      "函数",
      "varsayılan",
      "dışa",
    ]);
  });

  it("reads every re-export form as a re-export, and none of their names as exports", () => {
    const syntax = readModule(
      "src/index.ts",
      [
        'export * from "./a";',
        'export * as ns from "./ns";',
        'export { b } from "./b";',
        'export type { T } from "./t";',
        'export type * from "./types";',
      ].join("\n"),
    );
    expect(specifiers(syntax.reExports)).toEqual([
      "./a",
      "./ns",
      "./b",
      "./t",
      "./types",
    ]);
    expect(syntax.imports).toEqual([]);
    expect(syntax.exports).toEqual([]);
  });

  it("counts imports and re-exports as the static dependencies, in source order", () => {
    const syntax = readModule(
      "src/a.ts",
      [
        'import "./side";',
        'export * from "./barrel";',
        'import type { T } from "./t";',
      ].join("\n"),
    );
    expect(staticDependencies(syntax)).toEqual(["./side", "./barrel", "./t"]);
  });

  it("finds a dynamic import as a specifier site, not an import", () => {
    const text = [
      'const lazy = () => import("./lazy");',
      "const computed = (name: string) => import(name);",
      'const legacy = require("./legacy");',
      'import eq = require("./equals");',
      'type Shape = typeof import("./shape");',
    ].join("\n");
    const syntax = readModule("src/a.ts", text);
    expect(syntax.imports).toEqual([]);
    expect(syntax.reExports).toEqual([]);
    expect(specifiers(syntax.sites)).toEqual([
      "./lazy",
      "./legacy",
      "./equals",
      "./shape",
    ]);
    for (const site of syntax.sites)
      expect(text.slice(site.start, site.end)).toBe(`"${site.specifier}"`);
  });

  it("gives every site's span in UTF-16 code units, quotes included, past non-ASCII text", () => {
    const text = [
      "// ödeme → 支払い",
      "import { a } from './a';",
      'export { b } from "./b";',
    ].join("\n");
    const syntax = readModule("src/a.ts", text);
    expect(syntax.sites.map((s) => text.slice(s.start, s.end))).toEqual([
      "'./a'",
      '"./b"',
    ]);
  });

  it("reads a comment or string that only looks like an import as neither", () => {
    const syntax = readModule(
      "src/a.ts",
      [
        '// import { a } from "./commented";',
        'const text = `import b from "./templated";`;',
        'export const note = "export const fake = 1";',
      ].join("\n"),
    );
    expect(syntax.imports).toEqual([]);
    expect(syntax.sites).toEqual([]);
    expect(syntax.exports).toEqual(["note"]);
  });

  it("parses .tsx as TSX", () => {
    const syntax = readModule(
      "src/view.tsx",
      'import { Row } from "./row";\nexport const View = () => <Row />;',
    );
    expect(syntax.parsed).toBe(true);
    expect(syntax.exports).toEqual(["View"]);
  });

  it("says when the file does not parse", () => {
    expect(readModule("src/a.ts", "export const = ;").parsed).toBe(false);
  });
});

describe("specifierResolver", () => {
  const root = () =>
    repo({
      "tsconfig.json": JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "@app/*": ["src/*"] } },
      }),
      "src/tax/rate.ts": "export const rate = 1;",
      "src/billing/invoice.ts": "export const invoice = 1;",
      "node_modules/zod/package.json": '{ "name": "zod", "main": "index.js" }',
      "node_modules/zod/index.js": "module.exports = {};",
    });

  it("resolves a tsconfig paths alias to the repo file it names", () => {
    const resolve = specifierResolver(root(), "src", "HEAD");
    expect(resolve("src/billing/invoice.ts", "@app/tax/rate")).toEqual({
      kind: "repo",
      path: "src/tax/rate.ts",
    });
    expect(resolve("src/billing/invoice.ts", "../tax/rate")).toEqual({
      kind: "repo",
      path: "src/tax/rate.ts",
    });
  });

  it("reads an installed package or a builtin as external, and anything unresolved as unknown", () => {
    const resolve = specifierResolver(root(), "src", "HEAD");
    expect(resolve("src/billing/invoice.ts", "zod")).toEqual({
      kind: "external",
    });
    expect(resolve("src/billing/invoice.ts", "node:path")).toEqual({
      kind: "external",
    });
    expect(resolve("src/billing/invoice.ts", "@app/missing")).toEqual({
      kind: "unknown",
    });
    expect(resolve("src/billing/invoice.ts", "not-installed")).toEqual({
      kind: "unknown",
    });
  });
});

describe("specifierResolver answers repo only for a file in the tree --ref names", () => {
  it("reads an ignored file a paths fallback list reaches first as unknown, never as that file", () => {
    const root = repo({
      ".gitignore": "gen/\n",
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: { "@app/*": ["gen/*", "src/*"] },
        },
      }),
      "src/tax/rate.ts": "export const rate = 1;",
      "src/billing/invoice.ts": "export const invoice = 1;",
    });
    write(root, { "gen/tax/rate.ts": "export const rate = 2;" });
    expect(gitIn(root, "status", "--porcelain")).toBe("");
    const resolve = specifierResolver(root, "src", "HEAD");
    expect(resolve("src/billing/invoice.ts", "@app/tax/rate")).toEqual({
      kind: "unknown",
    });
  });

  it("reads an untracked file as unknown", () => {
    const root = repo({
      "tsconfig.json": JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "@app/*": ["src/*"] } },
      }),
      "src/billing/invoice.ts": "export const invoice = 1;",
    });
    write(root, { "src/tax/rate.ts": "export const rate = 1;" });
    const resolve = specifierResolver(root, "src", "HEAD");
    expect(resolve("src/billing/invoice.ts", "@app/tax/rate")).toEqual({
      kind: "unknown",
    });
  });

  it("reads an alias into a submodule as unknown, at its recorded commit and after it drifts", () => {
    const { root, drift } = withSubmodule(
      {
        "tsconfig.json": JSON.stringify({
          compilerOptions: {
            baseUrl: ".",
            paths: { "@vendor/*": ["vendor/rates/*"] },
          },
        }),
        "src/billing/invoice.ts": "export const invoice = 1;",
      },
      "vendor/rates",
      { "rate.ts": "export const rate = 1;" },
    );
    const at = () =>
      specifierResolver(
        root,
        "src",
        "HEAD",
      )("src/billing/invoice.ts", "@vendor/rate");
    expect(at()).toEqual({ kind: "unknown" });
    drift();
    expect(gitIn(root, "diff", "--name-status", "HEAD")).toBe(
      "M\tvendor/rates\n",
    );
    expect(at()).toEqual({ kind: "unknown" });
  });

  it("reads a workspace import into ignored build output as unknown, without refusing", () => {
    const root = repo({
      ".gitignore": "node_modules/\ndist/\n",
      "packages/lib/package.json": JSON.stringify({
        name: "@ws/lib",
        exports: {
          ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
        },
      }),
      "packages/lib/src/index.ts": "export const lib = 1;",
      "packages/app/tsconfig.json": JSON.stringify({
        compilerOptions: { module: "nodenext" },
      }),
      "packages/app/src/main.ts": 'import { lib } from "@ws/lib";',
    });
    write(root, {
      "packages/lib/dist/index.d.ts": "export declare const lib: number;",
      "packages/lib/dist/index.js": "export const lib = 1;",
    });
    mkdirSync(join(root, "packages/app/node_modules/@ws"), { recursive: true });
    symlinkSync(
      "../../../lib",
      join(root, "packages/app/node_modules/@ws/lib"),
    );
    expect(gitIn(root, "status", "--porcelain")).toBe("");
    const resolve = specifierResolver(root, "packages/app", "HEAD");
    expect(resolve("packages/app/src/main.ts", "@ws/lib")).toEqual({
      kind: "unknown",
    });
  });
});
