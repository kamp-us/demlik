import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ApiDiff, ApiInputError, diffPublishedApi } from "../api.js";
import { stableStringify } from "../render/json.js";

// The committed fixture (test/api/diff): one package at two commits. `before/` is the base and
// `after/` the branch: across three entries it adds a name (`format`), removes one (`legacy`),
// changes a signature (`parse`), changes a private type a published name reads (`Options`, read by
// `make`), renames a re-export (`check` → `verify`), adds a subpath (`./labs`) and leaves
// `VERSION` and `expectEqual`'s text alone.
const here = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = path.resolve(here, "..", "..");
const FIXTURE = path.join(PACKAGE_DIR, "test", "api", "diff");
const MAP_FILE = path.join(FIXTURE, "api-map.json");
const CLI = path.join(PACKAGE_DIR, "src", "index.ts");
const map: unknown = JSON.parse(fs.readFileSync(MAP_FILE, "utf8"));
const quiet = { warn: () => {} };

const git = (cwd: string, ...args: string[]): string =>
  execFileSync(
    "git",
    ["-c", "user.name=fixture", "-c", "user.email=fixture@example.com", ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );

const scratch: string[] = [];

// A throwaway repository whose package sits below its top, at `packages/demo`, with the `before`
// tree committed and the `after` tree committed on top. Returns the package root.
function throwawayRepository(): string {
  const top = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "code-graph-api-repo-")));
  scratch.push(top);
  const root = path.join(top, "packages", "demo");
  git(top, "init", "--quiet", "--initial-branch=main");
  fs.cpSync(path.join(FIXTURE, "before"), root, { recursive: true });
  git(top, "add", "-A");
  git(top, "commit", "--quiet", "--no-gpg-sign", "-m", "before");
  fs.rmSync(root, { recursive: true });
  fs.cpSync(path.join(FIXTURE, "after"), root, { recursive: true });
  git(top, "add", "-A");
  git(top, "commit", "--quiet", "--no-gpg-sign", "-m", "after");
  return root;
}

function filesUnder(dir: string, top = dir): readonly string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.name !== ".git")
    .flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return filesUnder(full, top);
      const bytes = createHash("sha256").update(fs.readFileSync(full)).digest("hex");
      return [`${path.relative(top, full)} ${bytes}`];
    })
    .sort();
}

// Everything a diff run must leave as it found it: the files' bytes, the porcelain status, the
// index, the branch and HEAD, and the stash list.
function checkoutState(root: string) {
  const top = git(root, "rev-parse", "--show-toplevel").trim();
  return {
    files: filesUnder(top),
    status: git(top, "--no-optional-locks", "status", "--porcelain=v1", "--untracked-files=all"),
    index: git(top, "ls-files", "--stage"),
    branch: git(top, "symbolic-ref", "HEAD"),
    head: git(top, "rev-parse", "HEAD"),
    stash: git(top, "stash", "list"),
  };
}

const MAKE = "export declare function make(options: Options): {\n    options: Options;\n};";
const OPTIONS = "src/core.d.ts#Options";
const EXPECT_EQUAL =
  "export declare function expectEqual<T>(actual: T, expected: NoInfer<T>): boolean;";

const expectedSubpaths = (): ApiDiff["subpaths"] => ({
  ".": {
    tier: "stable",
    added: {
      format: {
        after: { text: "export declare function format(n: number): string;", references: {} },
      },
    },
    removed: {
      legacy: { before: { text: "export declare function legacy(): void;", references: {} } },
    },
    changed: {
      make: {
        before: {
          text: MAKE,
          references: { [OPTIONS]: "type Options = {\n    readonly retries: number;\n};" },
        },
        after: {
          text: MAKE,
          references: {
            [OPTIONS]:
              "type Options = {\n    readonly retries: number;\n    readonly delayMs?: number;\n};",
          },
        },
      },
      parse: {
        before: { text: "export declare function parse(text: string): number;", references: {} },
        after: {
          text: "export declare function parse(text: string, radix?: number): number;",
          references: {},
        },
      },
    },
  },
  "./labs": {
    tier: "experimental",
    added: { flag: { after: { text: "export declare const flag = true;", references: {} } } },
    removed: {},
    changed: {},
  },
  "./testing": {
    tier: "stable",
    added: { verify: { after: { text: EXPECT_EQUAL, references: {} } } },
    removed: { check: { before: { text: EXPECT_EQUAL, references: {} } } },
    changed: {},
  },
});

let root: string;
let base: string;
let diff: ApiDiff;
let before: ReturnType<typeof checkoutState>;

beforeAll(async () => {
  root = throwawayRepository();
  base = git(root, "rev-parse", "HEAD~1").trim();
  before = checkoutState(root);
  diff = await diffPublishedApi(root, map, "HEAD~1", quiet);
});

afterAll(() => {
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
});

describe("diffPublishedApi — the published-API diff (SPEC §13.4)", () => {
  it("reports each added, removed and changed name under its subpath, and nothing else", () => {
    expect(diff.subpaths).toEqual(expectedSubpaths());
    expect(diff.base).toBe(base);
    expect(diff.root).toBe(path.relative(process.cwd(), root) || ".");
  });

  it("does not report a name whose text and references did not move", () => {
    expect(JSON.stringify(diff)).not.toContain("VERSION");
  });

  it("leaves the checkout's files, status, index, branch and stash as they were", () => {
    expect(checkoutState(root)).toEqual(before);
  });

  it("gives the same bytes on a second run", async () => {
    const again = await diffPublishedApi(root, map, base, quiet);
    expect(stableStringify(again, true)).toBe(stableStringify(diff, true));
  });

  it("reads a dirty working tree as the after side, and leaves it byte-identical", async () => {
    const dirty = throwawayRepository();
    const core = path.join(dirty, "src", "core.ts");
    fs.appendFileSync(core, "export const DIRTY = 1;\n");
    fs.writeFileSync(path.join(dirty, "src", "scratch.ts"), "export const untracked = true;\n");
    fs.writeFileSync(
      path.join(dirty, "src", "index.ts"),
      'export * from "./core";\nexport * from "./scratch";\n',
    );
    const state = checkoutState(dirty);
    expect(state.status).not.toBe("");

    const dirtyDiff = await diffPublishedApi(dirty, map, "HEAD~1", quiet);

    expect(checkoutState(dirty)).toEqual(state);
    expect(Object.keys(dirtyDiff.subpaths["."]?.added ?? {}).sort()).toEqual([
      "DIRTY",
      "format",
      "untracked",
    ]);
  });

  it("refuses a base that names no commit, and writes nothing", async () => {
    const state = checkoutState(root);
    await expect(diffPublishedApi(root, map, "no-such-ref", quiet)).rejects.toThrow(
      new ApiInputError(
        `base rev "no-such-ref" does not resolve to a commit in ${path.dirname(path.dirname(root))} (in CI, fetch it first)`,
      ),
    );
    expect(checkoutState(root)).toEqual(state);
  });
});

describe("code-graph --api --api-base", () => {
  const run = (cwd: string, args: readonly string[]) => {
    try {
      const stdout = execFileSync(process.execPath, ["--import", "tsx", CLI, ...args], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { code: 0, stdout, stderr: "" };
    } catch (error) {
      const failed = error as { status: number; stdout: string; stderr: string };
      return { code: failed.status, stdout: failed.stdout, stderr: failed.stderr };
    }
  };

  it("prints the library's diff as sorted JSON", () => {
    const printed = run(PACKAGE_DIR, [root, "--api", MAP_FILE, "--api-base", "HEAD~1"]);
    expect(printed.code).toBe(0);
    expect((JSON.parse(printed.stdout) as ApiDiff).subpaths).toEqual(expectedSubpaths());
    expect(printed.stdout).toBe(`${stableStringify(JSON.parse(printed.stdout), false)}\n`);
  });

  it("exits 2 on a base that names no commit, writing no --out file and leaving the checkout", () => {
    const state = checkoutState(root);
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "code-graph-api-out-"));
    scratch.push(outDir);
    const out = path.join(outDir, "diff.json");
    const refused = run(PACKAGE_DIR, [root, "--api", MAP_FILE, "--api-base", "nope", "--out", out]);
    expect(refused.code).toBe(2);
    expect(refused.stdout).toBe("");
    expect(refused.stderr).toContain('base rev "nope" does not resolve to a commit');
    expect(fs.existsSync(out)).toBe(false);
    expect(checkoutState(root)).toEqual(state);
  });

  it("exits 2 on --api-base without --api", () => {
    const refused = run(PACKAGE_DIR, [root, "--api-base", "HEAD~1"]);
    expect(refused.code).toBe(2);
    expect(refused.stdout).toBe("");
    expect(refused.stderr).toContain("--api-base needs --api");
  });
});
