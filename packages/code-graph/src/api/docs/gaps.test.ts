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

const WARNING = "code-graph: warning: ";
const UNRESOLVED = (specifier: string): string =>
  `${WARNING}src/index.ts names "${specifier}", which the read could not resolve; a name behind it is not judged`;
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
      expect(warnings).toHaveLength(6);
      expect(warnings.slice(0, 3)).toEqual([
        UNRESOLVED("./gone"),
        UNRESOLVED("./missing"),
        UNRESOLVED("./nope"),
      ]);
      expect(warnings[3]).toMatch(
        /^code-graph: warning: src\/broken\.ts has \d+ syntax error\(s\); a declaration in it may not be judged$/,
      );
      expect(warnings.slice(4)).toEqual([NO_DECLARATION("ghost"), NO_DECLARATION("gone")]);
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
        "unresolved-specifier",
        "syntax-error",
        "no-declaration",
        "no-declaration",
      ]);
      expect(gaps[0]).toEqual({
        kind: "unresolved-specifier",
        file: "src/index.ts",
        specifier: "./gone",
      });
      expect(gaps[5]).toEqual({ kind: "no-declaration", subpath: ".", name: "gone" });
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
  },
);
