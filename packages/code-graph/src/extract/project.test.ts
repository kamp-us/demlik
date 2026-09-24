import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { discoverPackageRoots, listSourceFiles, loadCheapProject } from "./project.js";

describe("loadCheapProject parse-failure detection (SPEC §11)", () => {
  let tmpRoot: string;

  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "code-graph-parsefail-"));
    fs.writeFileSync(path.join(tmpRoot, "broken.ts"), "export function f( {  // unclosed\n");
    fs.writeFileSync(
      path.join(tmpRoot, "good.ts"),
      "export function g(x: number): number {\n  return x + 1;\n}\n",
    );
  });

  afterAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("reports the broken file and not the good file", () => {
    const loaded = loadCheapProject(tmpRoot);

    expect(loaded.parseFailures).toContain("broken.ts");
    expect(loaded.parseFailures).not.toContain("good.ts");
    expect(loaded.sourceFiles.map((sf) => path.basename(sf.getFilePath()))).toContain("good.ts");
  });
});

describe("discoverPackageRoots (#2446)", () => {
  let tmpRoot: string;

  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "code-graph-pkgroots-"));
    for (const dir of ["packages/a/src", "packages/b", "packages/a/node_modules/dep"]) {
      fs.mkdirSync(path.join(tmpRoot, dir), { recursive: true });
    }
    fs.writeFileSync(path.join(tmpRoot, "packages/a/package.json"), "{}");
    fs.writeFileSync(path.join(tmpRoot, "packages/b/package.json"), "{}");
    fs.writeFileSync(path.join(tmpRoot, "packages/a/node_modules/dep/package.json"), "{}");
  });

  afterAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('finds each package dir + "", and prunes node_modules', () => {
    expect(discoverPackageRoots(tmpRoot)).toEqual(["", "packages/a", "packages/b"]);
  });

  it('returns just [""] for a scoped run with no nested package.json', () => {
    expect(discoverPackageRoots(path.join(tmpRoot, "packages/a/src"))).toEqual([""]);
  });
});

describe("listSourceFiles", () => {
  let tmpRoot: string;

  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "code-graph-sources-"));
    const files = [
      "src/a.ts",
      "src/b.tsx",
      "src/types.d.ts",
      "src/schema.gen.ts",
      "src/readme.md",
      "src/.hidden.ts",
      ".storybook/main.ts",
      "node_modules/dep/index.ts",
      "packages/x/node_modules/dep/index.ts",
      "packages/x/vendor/v.ts",
      "packages/x/dist/out.ts",
      "packages/x/.next/page.tsx",
      "packages/x/src/__generated__/q.ts",
      "packages/x/src/c.ts",
    ];
    for (const file of files) {
      fs.mkdirSync(path.dirname(path.join(tmpRoot, file)), { recursive: true });
      fs.writeFileSync(path.join(tmpRoot, file), "export {};\n");
    }
  });

  afterAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("lists .ts and .tsx sources, skipping declarations, generated files, dot entries and pruned directories", () => {
    const listed = listSourceFiles(tmpRoot)
      .map((file) => path.relative(tmpRoot, file))
      .sort();
    expect(listed).toEqual(["packages/x/src/c.ts", "src/a.ts", "src/b.tsx"]);
  });
});
