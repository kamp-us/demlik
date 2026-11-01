import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findRepoRoot } from "../extract/project.js";
import { git, runCli } from "../test-helpers/ratchet-repo.js";

let top: string;

function write(files: Readonly<Record<string, string>>): void {
  for (const [relative, text] of Object.entries(files)) {
    const file = path.join(top, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
}

const at = (...segments: string[]): string => path.join(top, ...segments);

function mkdir(...segments: string[]): string {
  const dir = at(...segments);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

beforeEach(() => {
  top = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "code-graph-repo-root-")));
});

afterEach(() => {
  fs.rmSync(top, { recursive: true, force: true });
});

describe("findRepoRoot", () => {
  it("answers the start folder when nothing above it marks a root", () => {
    expect(findRepoRoot(mkdir("a", "b"))).toBe(at("a", "b"));
  });

  it("answers the top of a single-package git repo", () => {
    git(top, "init", "-q");
    write({ "package.json": '{ "name": "single" }\n' });
    expect(findRepoRoot(mkdir("src", "deep"))).toBe(top);
  });

  it("answers the top of a linked git worktree, whose .git is a file", () => {
    const main = mkdir("main");
    git(main, "init", "-q");
    git(main, "commit", "-q", "--no-gpg-sign", "--allow-empty", "-m", "base");
    git(main, "worktree", "add", "-q", at("linked"));
    expect(fs.statSync(at("linked", ".git")).isFile()).toBe(true);
    expect(findRepoRoot(mkdir("linked", "src"))).toBe(at("linked"));
  });

  it("answers a yarn-style workspaces object and an npm-style array", () => {
    write({
      "yarn/package.json": '{ "workspaces": { "packages": ["packages/*"] } }\n',
      "npm/package.json": '{ "workspaces": ["packages/*"] }\n',
    });
    expect(findRepoRoot(mkdir("yarn", "packages", "a"))).toBe(at("yarn"));
    expect(findRepoRoot(mkdir("npm", "packages", "a"))).toBe(at("npm"));
  });

  it("prefers the nearest workspaces package.json to a .git further up or nearer", () => {
    git(top, "init", "-q");
    write({
      "sub/package.json": '{ "workspaces": ["packages/*"] }\n',
      "sub/packages/a/.git": "gitdir: /elsewhere\n",
      "sub/packages/a/package.json": '{ "name": "a" }\n',
    });
    expect(findRepoRoot(mkdir("sub", "packages", "a", "src"))).toBe(at("sub"));
  });

  it("does not count a package.json with no workspaces key", () => {
    write({ "outer/package.json": '{ "workspaces": [] }\n', "outer/a/package.json": "{}\n" });
    expect(findRepoRoot(mkdir("outer", "a", "src"))).toBe(at("outer"));
  });

  it("keeps a pnpm-workspace.yaml's answer over a nested workspaces package.json and .git", () => {
    write({
      "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
      "packages/nested/.git": "gitdir: /elsewhere\n",
      "packages/nested/package.json": '{ "workspaces": ["inner/*"] }\n',
    });
    expect(findRepoRoot(mkdir("packages", "nested", "inner", "x"))).toBe(top);
    expect(findRepoRoot(at("packages", "nested"))).toBe(top);
    expect(findRepoRoot(top)).toBe(top);
  });

  it.each([
    ["malformed JSON", "{ not json"],
    ["an empty file", ""],
    ["a JSON array", '["workspaces"]'],
    ["JSON null", "null"],
    ["a JSON string", '"workspaces"'],
  ])("skips a package.json holding %s and keeps walking", (_, text) => {
    write({ "outer/package.json": '{ "workspaces": ["*"] }\n', "outer/a/package.json": text });
    expect(findRepoRoot(mkdir("outer", "a", "src"))).toBe(at("outer"));
  });

  it("answers the start folder when the only package.json is malformed", () => {
    write({ "a/package.json": "{ not json" });
    expect(findRepoRoot(at("a"))).toBe(at("a"));
  });

  it("treats a package.json that is a directory as no manifest", () => {
    fs.mkdirSync(at("a", "package.json"), { recursive: true });
    expect(findRepoRoot(at("a"))).toBe(at("a"));
  });
});

const TSCONFIG =
  '{ "compilerOptions": { "strict": true, "module": "ESNext", "moduleResolution": "Bundler", "target": "ES2022" }, "include": ["**/*.ts"] }\n';

const PACKAGES = ["a", "b", "c"] as const;

const bigFile = (name: string): string => {
  const rows = Array.from({ length: 700 }, (_, i) => `  ${i},`);
  return `export const ${name} = [\n${rows.join("\n")}\n];\n`;
};

// An npm workspace with no `pnpm-workspace.yaml`. Each package holds one dead export, one export
// only its test calls, one big file, and two features the first of which reaches into the second's
// internals. `b` calls an export of `a`, so a run on `a` alone reads it as dead and the root does not.
// A test in `b` is the only caller of `helper` in `a`, so `a` alone reads it as dead and the root as
// only-called-from-tests.
function npmWorkspace(): void {
  const files: Record<string, string> = {
    "package.json": '{ "name": "root", "private": true, "workspaces": ["packages/*"] }\n',
    "tsconfig.json": TSCONFIG,
    "boundary-rules.json": `${JSON.stringify({
      features: Object.fromEntries(PACKAGES.map((p) => [`packages/${p}`, ["one", "two"]])),
    })}\n`,
    "smell-ledger.json": `${JSON.stringify({ entries: [], gated: ["big-file"] })}\n`,
  };
  for (const name of PACKAGES) {
    Object.assign(files, {
      [`packages/${name}/package.json`]: `{ "name": "${name}", "private": true }\n`,
      [`packages/${name}/tsconfig.json`]: TSCONFIG,
      [`packages/${name}/src/dead.ts`]: `export function dead${name}(n: number): number {\n  return n + 1;\n}\n`,
      [`packages/${name}/src/tested.ts`]: `export function tested${name}(n: number): number {\n  return n * 2;\n}\n`,
      [`packages/${name}/src/tested.test.ts`]: `import { tested${name} } from "./tested.js";\n\nexport function check${name}(): boolean {\n  return tested${name}(1) === 2;\n}\n`,
      [`packages/${name}/src/big.ts`]: bigFile(`big${name}`),
      [`packages/${name}/src/one/index.ts`]: `import { inner } from "../two/inner.js";\n\nexport const one = inner;\n`,
      [`packages/${name}/src/two/index.ts`]: `export { inner } from "./inner.js";\n`,
      [`packages/${name}/src/two/inner.ts`]: "export const inner = 1;\n",
    });
  }
  files["packages/a/src/shared.ts"] =
    "export function shared(n: number): number {\n  return n - 1;\n}\n";
  files["packages/b/src/caller.ts"] =
    'import { shared } from "../../a/src/shared.js";\n\nexport function caller(): number {\n  return shared(1);\n}\n';
  files["packages/a/src/helper.ts"] =
    "export function helper(n: number): number {\n  return n + 2;\n}\n";
  files["packages/b/src/use.test.ts"] =
    'import { helper } from "../../a/src/helper.js";\n\nexport function checkHelper(): boolean {\n  return helper(1) === 3;\n}\n';
  write(files);
}

function ledgerFilesBelowRoot(): string[] {
  const found: string[] = [];
  for (const name of PACKAGES) {
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const absolute = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(absolute);
        else if (/(-ledger|-ceilings)\.json$/.test(entry.name)) found.push(absolute);
      }
    };
    walk(at("packages", name));
  }
  return found;
}

const unreachableCi = (root: string): ReturnType<typeof runCli> =>
  runCli([root, "--unreachable", "--ci"]);

describe(
  "a repo with no pnpm-workspace.yaml judges a folder and the root the same",
  {
    timeout: 120_000,
  },
  () => {
    beforeEach(npmWorkspace);

    it("agrees on every finding across three packages and the root, run after run", () => {
      const allRoots = [...PACKAGES.map((name) => at("packages", name)), top];

      for (const failing of allRoots) expect(unreachableCi(failing).code).toBe(1);

      expect(
        runCli([at("packages", "a"), "--unreachable", "--accept-dead", "--reason", "x"]).code,
      ).toBe(0);
      expect(fs.existsSync(at("unreachable-ledger.json"))).toBe(true);
      expect(unreachableCi(at("packages", "a")).code).toBe(0);
      expect(unreachableCi(at("packages", "b")).code).toBe(1);

      const partial = runCli([top, "--unreachable", "--ci", "--json"]);
      expect(partial.code).toBe(1);
      const unrecorded: { id: string }[] = JSON.parse(partial.stdout).unrecorded;
      expect(
        unrecorded.map((finding) => finding.id).filter((id) => id.includes("packages/a")),
      ).toEqual([]);

      for (const name of ["b", "c"]) {
        expect(
          runCli([at("packages", name), "--unreachable", "--accept-dead", "--reason", "x"]).code,
        ).toBe(0);
      }
      const ledger = fs.readFileSync(at("unreachable-ledger.json"), "utf8");
      const entries: { scope: string; kind: string; id: string }[] = JSON.parse(ledger).entries;
      expect(entries).toContainEqual(
        expect.objectContaining({ scope: "packages/a", kind: "dead", id: "src/helper.ts:helper" }),
      );
      expect(
        entries.some((entry) => entry.id.includes("helper") && entry.scope !== "packages/a"),
      ).toBe(false);
      const measuredAtRoot = JSON.parse(runCli([top, "--unreachable", "--json"]).stdout);
      expect(measuredAtRoot.unreachable).toContainEqual(
        expect.objectContaining({
          id: "packages/a/src/helper.ts:helper",
          category: "only-called-from-tests",
        }),
      );

      const atRoot = unreachableCi(top).stdout;
      expect(atRoot).toMatch(/PASS — scope \., [1-9]\d* recorded finding/);

      for (let round = 0; round < 2; round++) {
        for (const root of allRoots) {
          const run = unreachableCi(root);
          expect(run.stdout).not.toContain("FAILED");
          expect(run.code).toBe(0);
        }
        expect(fs.readFileSync(at("unreachable-ledger.json"), "utf8")).toBe(ledger);
        expect(ledgerFilesBelowRoot()).toEqual([]);
      }
    });

    it("fails the root run on a symbol a package recorded as test-only once its test is gone", () => {
      for (const name of PACKAGES) {
        expect(
          runCli([at("packages", name), "--unreachable", "--accept-dead", "--reason", "x"]).code,
        ).toBe(0);
      }
      const ledger = fs.readFileSync(at("unreachable-ledger.json"), "utf8");
      expect(JSON.parse(ledger).entries).toContainEqual(
        expect.objectContaining({
          scope: "packages/a",
          kind: "only-called-from-tests",
          id: "src/tested.ts:testeda",
        }),
      );
      expect(unreachableCi(top).code).toBe(0);

      fs.rmSync(at("packages", "a", "src", "tested.test.ts"));

      const nowDead = { scope: ".", kind: "dead", id: "packages/a/src/tested.ts:testeda" };
      for (const gate of [[], ["--dead-only"]]) {
        for (let round = 0; round < 2; round++) {
          const run = runCli([top, "--unreachable", "--ci", ...gate, "--json"]);
          expect(run.code).toBe(1);
          expect(JSON.parse(run.stdout).unrecorded).toEqual([nowDead]);
        }
      }
      expect(fs.readFileSync(at("unreachable-ledger.json"), "utf8")).toBe(ledger);
    });

    it("covers an unused-export the root measures on a package's dead entry", () => {
      // `b`'s public entry calls `lone`, which calls `leaf`. `c` alone reads `leaf` as dead. The root
      // reaches it, and no other file uses the export.
      write({
        "packages/c/src/lone.ts":
          "export function lone(n: number): number {\n  return leaf(n);\n}\n\nexport function leaf(n: number): number {\n  return n + 4;\n}\n",
        "packages/b/package.json": '{ "name": "b", "private": true, "main": "src/api.ts" }\n',
        "packages/b/src/api.ts":
          'import { lone } from "../../c/src/lone.js";\n\nexport function api(n: number): number {\n  return lone(n);\n}\n',
      });
      for (const name of PACKAGES) {
        expect(
          runCli([at("packages", name), "--unreachable", "--accept-dead", "--reason", "x"]).code,
        ).toBe(0);
      }
      const entries = JSON.parse(fs.readFileSync(at("unreachable-ledger.json"), "utf8")).entries;
      expect(entries).toContainEqual(
        expect.objectContaining({ scope: "packages/c", kind: "dead", id: "src/lone.ts:leaf" }),
      );
      const measured = JSON.parse(runCli([top, "--unreachable", "--json"]).stdout);
      expect(measured.unusedExports).toContainEqual(
        expect.objectContaining({ id: "packages/c/src/lone.ts:leaf" }),
      );
      expect(unreachableCi(top).code).toBe(0);
    });

    it("covers an unused-export the root measures on a package's test-only entry", () => {
      // A test names `leaf` without importing it, so `c` alone reads it as test-only. The root reaches
      // it from `b`'s public entry, and a name in a test is not a use, so the root reads it as unused.
      write({
        "packages/c/src/lone.ts":
          "export function lone(n: number): number {\n  return leaf(n);\n}\n\nexport function leaf(n: number): number {\n  return n + 4;\n}\n",
        "packages/c/src/other.test.ts":
          'import { vi } from "vitest";\n\nvi.mock("./lone.js", () => ({ leaf: () => 1 }));\n',
        "packages/b/package.json": '{ "name": "b", "private": true, "main": "src/api.ts" }\n',
        "packages/b/src/api.ts":
          'import { lone } from "../../c/src/lone.js";\n\nexport function api(n: number): number {\n  return lone(n);\n}\n',
      });
      for (const name of PACKAGES) {
        expect(
          runCli([at("packages", name), "--unreachable", "--accept-dead", "--reason", "x"]).code,
        ).toBe(0);
      }
      const ledger = fs.readFileSync(at("unreachable-ledger.json"), "utf8");
      expect(JSON.parse(ledger).entries).toContainEqual(
        expect.objectContaining({
          scope: "packages/c",
          kind: "only-called-from-tests",
          id: "src/lone.ts:leaf",
        }),
      );
      const measured = JSON.parse(runCli([top, "--unreachable", "--json"]).stdout);
      expect(measured.unusedExports).toContainEqual(
        expect.objectContaining({ id: "packages/c/src/lone.ts:leaf" }),
      );

      for (let round = 0; round < 2; round++) {
        for (const root of [...PACKAGES.map((name) => at("packages", name)), top]) {
          expect(unreachableCi(root).code).toBe(0);
        }
        expect(fs.readFileSync(at("unreachable-ledger.json"), "utf8")).toBe(ledger);
      }
    });

    it("reads an entry the root run recorded from a package run", () => {
      expect(runCli([top, "--unreachable", "--accept-dead", "--reason", "x"]).code).toBe(0);
      expect(unreachableCi(top).code).toBe(0);
      for (const name of ["b", "c"]) expect(unreachableCi(at("packages", name)).code).toBe(0);
      expect(ledgerFilesBelowRoot()).toEqual([]);

      // The root saw `b` call `shared`, so it recorded nothing for it. `a` alone cannot see that call.
      // The root did record `helper`, under another kind, so `a` reads that entry for its own finding.
      const a = runCli([at("packages", "a"), "--unreachable", "--ci", "--json"]);
      expect(JSON.parse(a.stdout).unrecorded).toEqual([
        { scope: "packages/a", kind: "dead", id: "src/shared.ts:shared" },
      ]);
    });

    it("lands --accept-smells, --accept-crossings and --write-ceilings at the root", () => {
      const pkg = at("packages", "a");
      const rules = at("boundary-rules.json");

      const smells = runCli([pkg, "--accept-smells", "--reason", "x"]);
      expect(smells.code).toBe(0);
      const smellLedger = JSON.parse(fs.readFileSync(at("smell-ledger.json"), "utf8"));
      expect(smellLedger.entries.map((e: { target: string }) => e.target)).toEqual([
        "packages/a/src/big.ts",
      ]);

      const crossings = runCli([
        pkg,
        "--boundaries",
        "--boundary-rules",
        rules,
        "--accept-crossings",
        "--reason",
        "x",
      ]);
      expect(crossings.code).toBe(0);
      expect(fs.existsSync(at("boundary-ledger.json"))).toBe(true);

      expect(runCli([pkg, "--comments", "--write-ceilings"]).code).toBe(0);
      expect(fs.existsSync(at("comment-ceilings.json"))).toBe(true);

      expect(ledgerFilesBelowRoot()).toEqual([]);
      expect(runCli([pkg, "--ci"]).code).toBe(0);
      expect(runCli([pkg, "--boundaries", "--boundary-rules", rules, "--ci"]).code).toBe(0);
      expect(runCli([pkg, "--comments", "--ci"]).code).toBe(0);
      expect(runCli([top, "--comments", "--ci"]).code).toBe(0);
    });
  },
);
