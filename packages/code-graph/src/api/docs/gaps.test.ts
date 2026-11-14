import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readApiDocFacts } from "../../api.js";
import { DOCS_SHAPE, removePackage, runDocsCli, writeFiles } from "./docs-package.fixture.js";

// A read that could not see everything says so (SPEC §13.10): a declaration the read never found
// must not be missing from the count without a sign.
const TSCONFIG = `${JSON.stringify({
  compilerOptions: {
    target: "ES2022",
    module: "ESNext",
    moduleResolution: "Bundler",
    strict: true,
    types: [],
  },
  include: ["src"],
})}\n`;

const FINE =
  "/**\n * Stays fine.\n *\n * @stability stable\n * @category constants\n */\nexport const fine = 1;\n";

const BROKEN: Readonly<Record<string, string>> = {
  "package.json": '{ "name": "@demo/gaps" }\n',
  "tsconfig.json": TSCONFIG,
  "map.json": '{ ".": { "entry": "src/index.ts" } }\n',
  "src/index.ts": [
    'export * from "./nope";',
    'export { ghost } from "./missing";',
    'export * from "./broken";',
    'import { gone } from "./gone";',
    "export { gone };",
    FINE,
  ].join("\n"),
  "src/broken.ts": "export function (\nexport const after = 1;\n",
};

let root: string;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "code-graph-docs-gaps-")));
  writeFiles(root, BROKEN);
});
afterEach(() => removePackage(root));

const MAP = { ".": { entry: "src/index.ts" } };
const WARNING = "code-graph: warning: ";
const UNRESOLVED = (specifier: string, file = "src/index.ts"): string =>
  `${WARNING}${file} names "${specifier}", which the read could not resolve; a name behind it is not judged`;
const NO_DECLARATION = (name: string): string =>
  `${WARNING}. publishes "${name}", which the read found no declaration for; it is not judged`;

describe(
  "code-graph --api-docs on a package the read cannot see all of",
  { timeout: 120_000 },
  () => {
    it("warns once per gap on stderr, in the stated order, and still prints what it judged and exits 0", () => {
      const run = runDocsCli([
        root,
        "--api",
        path.join(root, "map.json"),
        "--api-docs",
        DOCS_SHAPE,
      ]);
      const warnings = run.stderr.trimEnd().split("\n");
      expect(warnings).toHaveLength(5);
      expect(warnings.slice(0, 2)).toEqual([UNRESOLVED("./missing"), UNRESOLVED("./nope")]);
      expect(warnings[2]).toMatch(
        /^code-graph: warning: src\/broken\.ts has \d+ syntax error\(s\); a declaration in it may not be judged$/,
      );
      expect(warnings.slice(3)).toEqual([NO_DECLARATION("ghost"), NO_DECLARATION("gone")]);
      expect(run.stderr).not.toContain(root);
      expect(run.stdout).toBe("api docs: 1 export judged, 0 with a finding\n");
      expect(run.code).toBe(0);
    });

    it("carries the same gaps in --json and returns them from the reader", () => {
      const map = JSON.parse(BROKEN["map.json"] as string);
      const { facts, gaps } = readApiDocFacts(root, map);
      expect(facts.map(({ name }) => name)).toEqual(["fine"]);
      expect(gaps.map((gap) => gap.kind)).toEqual([
        "unresolved-specifier",
        "unresolved-specifier",
        "syntax-error",
        "no-declaration",
        "no-declaration",
      ]);
      expect(gaps[0]).toEqual({
        kind: "unresolved-specifier",
        file: "src/index.ts",
        specifier: "./missing",
      });
      expect(gaps[4]).toEqual({ kind: "no-declaration", subpath: ".", name: "gone" });
      const run = runDocsCli([
        root,
        "--api",
        path.join(root, "map.json"),
        "--api-docs",
        DOCS_SHAPE,
        "--json",
      ]);
      expect(JSON.parse(run.stdout).gaps).toEqual(JSON.parse(JSON.stringify(gaps)));
    });

    it("reads a clean package with no gap", () => {
      writeFiles(root, { "src/index.ts": FINE });
      fs.rmSync(path.join(root, "src/broken.ts"));
      expect(readApiDocFacts(root, { ".": { entry: "src/index.ts" } }).gaps).toEqual([]);
    });

    it("takes an import it cannot resolve as no gap, since an import hides no name", () => {
      fs.rmSync(path.join(root, "src/broken.ts"));
      writeFiles(root, {
        "src/index.ts": `import type { Z } from "not-installed";\n${FINE}${FINE.replace("fine = 1", "uses: Z | 1 = 1")}`,
      });
      const { facts, gaps } = readApiDocFacts(root, MAP);
      expect(gaps).toEqual([]);
      expect(facts.map(({ name }) => name).sort()).toEqual(["fine", "uses"]);
    });

    it("takes a broken file and a missing module in a dependency as no gap", () => {
      fs.rmSync(path.join(root, "src/broken.ts"));
      writeFiles(root, {
        "node_modules/bad/package.json": '{ "name": "bad", "types": "index.d.ts" }\n',
        "node_modules/bad/index.d.ts":
          'export declare function (;\nexport declare const ok: number;\nexport * from "./peer-not-installed";\n',
        "src/index.ts": `export * from "bad";\nexport * as Bad from "bad";\n${FINE}`,
      });
      const { facts, gaps } = readApiDocFacts(root, MAP);
      expect(gaps).toEqual([]);
      expect(facts.map(({ name }) => name)).toEqual(["fine"]);
    });

    it("keeps a gap in a file the shape skips, since a re-export there can lead out of it", () => {
      fs.rmSync(path.join(root, "src/broken.ts"));
      writeFiles(root, {
        "src/internal/index.ts": 'export * from "./nope";\n',
        "src/index.ts": `export * from "./internal/index";\n${FINE}`,
      });
      const run = runDocsCli([
        root,
        "--api",
        path.join(root, "map.json"),
        "--api-docs",
        DOCS_SHAPE,
      ]);
      expect(run.stderr).toBe(`${UNRESOLVED("./nope", "src/internal/index.ts")}\n`);
      expect(run.stdout).toBe("api docs: 1 export judged, 0 with a finding\n");
    });

    it("takes a name a dependency exports with nothing behind it as no gap", () => {
      fs.rmSync(path.join(root, "src/broken.ts"));
      writeFiles(root, {
        "node_modules/dep/package.json": '{ "name": "dep", "types": "index.d.ts" }\n',
        "node_modules/dep/index.d.ts":
          'import type { Opt } from "optional-peer";\nexport type { Opt };\nexport { Opt2 } from "optional-peer-2";\n',
        "src/index.ts": `export * from "dep";\n${FINE}`,
      });
      const { facts, gaps } = readApiDocFacts(root, MAP);
      expect(gaps).toEqual([]);
      expect(facts.map(({ name }) => name)).toEqual(["fine"]);
    });

    it("reads a class merged with a namespace with no gap, and only the namespace's members", () => {
      fs.rmSync(path.join(root, "src/broken.ts"));
      writeFiles(root, {
        "src/index.ts": [
          FINE.replace(
            "export const fine = 1;",
            "export class Svc {\n  static create(): Svc {\n    return new Svc();\n  }\n  static version = 1;\n}",
          ),
          "export namespace Svc {",
          FINE.replace("export const fine = 1;", "export type Opts = { readonly on: boolean };"),
          "}",
          "",
        ].join("\n"),
      });
      const { facts, gaps } = readApiDocFacts(root, MAP);
      expect(gaps).toEqual([]);
      expect(facts.map(({ name }) => name).sort()).toEqual(["Svc", "Svc.Opts"]);
      expect(facts.find(({ name }) => name === "Svc.Opts")?.reachedBy).toEqual([
        { subpath: ".", name: "Svc.Opts" },
      ]);
    });

    it("judges a package that itself sits under a node_modules folder", () => {
      const vendored = path.join(root, "node_modules/vendored");
      writeFiles(vendored, {
        "package.json": '{ "name": "vendored" }\n',
        "tsconfig.json": TSCONFIG,
        "src/index.ts": FINE,
      });
      const { facts, gaps } = readApiDocFacts(vendored, MAP);
      expect(gaps).toEqual([]);
      expect(facts.map(({ file, name }) => `${file} ${name}`)).toEqual(["src/index.ts fine"]);
    });

    it("judges an augmented name where it is declared, whatever the augmenting file is called", () => {
      fs.rmSync(path.join(root, "src/broken.ts"));
      writeFiles(root, {
        "src/aaa-augment.ts":
          'declare module "./core" {\n  interface Options {\n    readonly b: number;\n  }\n}\nexport {};\n',
        "src/core.ts": FINE.replace(
          "export const fine = 1;",
          "export interface Options {\n  readonly a: number;\n}",
        ),
        "src/index.ts": 'import "./aaa-augment";\nexport * from "./core";\n',
      });
      const { facts, gaps } = readApiDocFacts(root, MAP);
      expect(gaps).toEqual([]);
      expect(facts.map(({ file, line, name }) => `${file}:${line} ${name}`)).toEqual([
        "src/core.ts:7 Options",
      ]);
      expect(facts[0]?.text).toContain("Stays fine.");
    });

    it("leaves a dependency's name out when an own file augments it", () => {
      fs.rmSync(path.join(root, "src/broken.ts"));
      writeFiles(root, {
        "node_modules/dep/package.json": '{ "name": "dep", "types": "index.d.ts" }\n',
        "node_modules/dep/index.d.ts": "export interface Foo {\n  a: number;\n}\n",
        "aaa/ext.ts":
          'declare module "dep" {\n  interface Foo {\n    b: number;\n  }\n}\nexport {};\n',
        "src/index.ts": `import "../aaa/ext";\nexport type { Foo } from "dep";\nexport * as Dep from "dep";\n${FINE}`,
        "tsconfig.json": TSCONFIG.replace('"include":["src"]', '"include":["src","aaa"]'),
      });
      const { facts, gaps } = readApiDocFacts(root, MAP);
      expect(gaps).toEqual([]);
      expect(facts.map(({ name }) => name)).toEqual(["fine"]);
    });
  },
);
