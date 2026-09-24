import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  discoverPackageRoots,
  listSourceFiles,
  loadCheapProject,
  loadEdgeProject,
} from "./project.js";
import { findWranglerConfigs } from "./wrangler-config.js";

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

describe("file discovery respects .gitignore", () => {
  let tmpRoot: string;
  const relFiles = (files: { getFilePath(): string }[]): string[] =>
    files.map((sf) => path.relative(tmpRoot, sf.getFilePath()).split(path.sep).join("/"));

  beforeAll(() => {
    tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "code-graph-gitignore-")));
    execFileSync("git", ["init", "-q"], { cwd: tmpRoot });
    const files: Record<string, string> = {
      ".gitignore": "opensrc\n.git-worktrees/\n",
      "tsconfig.json": JSON.stringify({ include: ["**/*.ts"] }),
      "src/kept.ts": "export function kept(): number {\n  return 1;\n}\n",
      "opensrc/repos/leak.ts": "export function leak(): number {\n  return 2;\n}\n",
      "svc/wrangler.toml": 'name = "svc"\n',
      ".git-worktrees/lane/svc/wrangler.toml": 'name = "svc"\n',
    };
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(tmpRoot, rel)), { recursive: true });
      fs.writeFileSync(path.join(tmpRoot, rel), content);
    }
  });

  afterAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("loadCheapProject skips gitignored source files", () => {
    expect(relFiles(loadCheapProject(tmpRoot).sourceFiles)).toEqual(["src/kept.ts"]);
  });

  it("loadEdgeProject skips gitignored source files even when the tsconfig includes them", () => {
    expect(relFiles(loadEdgeProject(tmpRoot, "package", tmpRoot).sourceFiles)).toEqual([
      "src/kept.ts",
    ]);
  });

  it("findWranglerConfigs skips configs under gitignored directories", () => {
    expect(findWranglerConfigs(tmpRoot)).toEqual([path.join(tmpRoot, "svc/wrangler.toml")]);
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
