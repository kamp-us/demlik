import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { API_LEDGER_FILENAME } from "./ledger/ledger.js";

const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = path.join(PACKAGE_DIR, "src", "index.ts");

// A workspace whose one package publishes three subpaths, each with an inferred return type, so a
// view that fell back to source text or to no text would read differently. Everything runs through
// the real CLI.
const COMPILER_OPTIONS = {
  target: "ES2022",
  module: "ESNext",
  moduleResolution: "Bundler",
  strict: true,
  skipLibCheck: true,
  types: [],
};
const json = (value: unknown): string => `${JSON.stringify(value)}\n`;

const PKG = "packages/demo";
const WORKSPACE: Readonly<Record<string, string>> = {
  "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
  "package.json": json({ name: "top", private: true }),
  ".gitignore": "built\n",
  "tsconfig.base.json": json({ compilerOptions: COMPILER_OPTIONS }),
  [`${PKG}/package.json`]: json({ name: "demo" }),
  [`${PKG}/tsconfig.json`]: json({ extends: "../../tsconfig.base.json", include: ["src"] }),
  [`${PKG}/src/index.ts`]: 'export * from "./pair";\nexport const one = () => ({ n: 1 });\n',
  [`${PKG}/src/pair.ts`]: "export const pair = (n: number) => [n, n] as const;\n",
  [`${PKG}/src/battery/index.ts`]: "export function battery(n: number) {\n  return String(n);\n}\n",
  [`${PKG}/src/labs/index.ts`]: "export const labs = { on: true };\n",
};
const MAP = {
  ".": { entry: "src/index.ts" },
  "./battery": { entry: "src/battery/index.ts" },
  "./labs": { entry: "src/labs/index.ts" },
};
const NAMES = ["battery", "labs", "one", "pair"];

// Each way a package comes to set `declarationDir`: its own config, a base config whose relative
// path resolves beside the base, and a base config whose `${configDir}` names a folder in the package.
const SETTING: ReadonlyArray<{
  readonly how: string;
  readonly files: Readonly<Record<string, string>>;
}> = [
  {
    how: "its own tsconfig.json",
    files: {
      [`${PKG}/tsconfig.json`]: json({
        extends: "../../tsconfig.base.json",
        compilerOptions: { declarationDir: "types" },
        include: ["src"],
      }),
    },
  },
  {
    how: "a base config it extends",
    files: {
      "tsconfig.base.json": json({
        compilerOptions: { ...COMPILER_OPTIONS, declarationDir: "types" },
      }),
    },
  },
  {
    how: "a base config it extends, under configDir",
    files: {
      "tsconfig.base.json": json({
        // biome-ignore lint/suspicious/noTemplateCurlyInString: tsconfig's own variable, as written in the file.
        compilerOptions: { ...COMPILER_OPTIONS, declarationDir: "${configDir}/types" },
      }),
    },
  },
];
const THROUGH_EXTENDS = SETTING[1]?.files ?? {};

let top: string;
let scratch: string;
let tmp: string;
let mapFile: string;

const write = (files: Readonly<Record<string, string>>): void => {
  for (const [relative, text] of Object.entries(files)) {
    const file = path.join(top, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
};

const git = (...args: string[]): string =>
  execFileSync("git", args, { cwd: top, encoding: "utf8" }).trim();

function commitAll(message: string): string {
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", message);
  return git("rev-parse", "HEAD");
}

// The run's temp folder lives under `tmp`, so a leftover one shows there.
const cli = (...args: string[]) => {
  const run = spawnSync(
    process.execPath,
    ["--import", "tsx", CLI, path.join(top, PKG), "--api", mapFile, ...args],
    { cwd: PACKAGE_DIR, encoding: "utf8", env: { ...process.env, TMPDIR: tmp } },
  );
  return { code: run.status, stdout: run.stdout, stderr: run.stderr };
};

// Every file in the repo with its text, git's own folder aside: a stray write anywhere changes this,
// a gitignored one included, which `git status` alone would miss.
function snapshot(under = ""): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of fs.readdirSync(path.join(top, under), { withFileTypes: true })) {
    const relative = path.join(under, entry.name);
    if (relative === ".git") continue;
    if (entry.isDirectory()) Object.assign(files, snapshot(relative));
    else files[relative] = fs.readFileSync(path.join(top, relative), "utf8");
  }
  return files;
}

type RepoState = {
  readonly files: Record<string, string>;
  readonly status: string;
  readonly head: string;
};
const repoState = (): RepoState => ({
  files: snapshot(),
  status: git("status", "--porcelain"),
  head: git("rev-parse", "HEAD"),
});

beforeEach(() => {
  top = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "code-graph-api-decldir-")));
  scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "code-graph-api-decldir-map-")));
  tmp = path.join(scratch, "tmp");
  fs.mkdirSync(tmp);
  mapFile = path.join(scratch, "map.json");
  fs.writeFileSync(mapFile, JSON.stringify(MAP));
  write(WORKSPACE);
  git("init", "-q", "-b", "main");
});

afterEach(() => {
  expect(fs.readdirSync(tmp).filter((name) => name.startsWith("code-graph-"))).toEqual([]);
  fs.rmSync(top, { recursive: true, force: true });
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe("--api on a package that sets declarationDir", () => {
  it.each(SETTING)("set through $how: same view, nothing written, on repeat runs", ({ files }) => {
    const plain = cli("--json");
    expect(plain.code, plain.stderr).toBe(0);
    expect(plain.stderr).toBe("");
    const view = JSON.parse(plain.stdout) as {
      subpaths: Record<string, { names: Record<string, { text: string }> }>;
    };
    const names = Object.values(view.subpaths).flatMap((subpath) => Object.keys(subpath.names));
    expect(names.sort()).toEqual(NAMES);
    expect(view.subpaths["."]?.names.pair?.text).toContain("readonly [number, number]");

    write(files);
    commitAll("sets declarationDir");
    const before = repoState();
    for (let run = 0; run < 2; run++) {
      const current = cli("--json");
      expect(current.code, current.stderr).toBe(0);
      expect(current.stderr).toBe("");
      expect(current.stdout).toBe(plain.stdout);
      expect(repoState()).toEqual(before);
    }
  });

  // What a person who sets this option has lying around: their own last build, in that folder.
  it("reads the same over a package already built into that folder, and leaves the build alone", () => {
    const built = { [`${PKG}/built/src/index.d.ts`]: "export declare const stale: 1;\n" };
    write(built);
    const plain = cli("--json");
    expect(plain.code, plain.stderr).toBe(0);

    write({
      [`${PKG}/tsconfig.json`]: json({
        extends: "../../tsconfig.base.json",
        compilerOptions: { declarationDir: "built" },
      }),
    });
    commitAll("sets declarationDir");
    const before = repoState();
    for (let run = 0; run < 2; run++) {
      const current = cli("--json");
      expect(current.code, current.stderr).toBe(0);
      expect(current.stdout).toBe(plain.stdout);
      expect(repoState()).toEqual(before);
    }
    expect(before.files[`${PKG}/built/src/index.d.ts`]).toBe("export declare const stale: 1;\n");
  });

  it("--api-base reports the diff when the base commit sets it too, and writes nothing", () => {
    write(THROUGH_EXTENDS);
    const base = commitAll("base");
    write({
      [`${PKG}/src/labs/index.ts`]:
        "export const labs = { on: 1 };\nexport const added = () => 2;\n",
      [`${PKG}/src/pair.ts`]: "export const twin = (n: number) => [n, n] as const;\n",
    });
    commitAll("head");
    const before = repoState();

    const run = cli("--api-base", base, "--json");
    expect(run.code, run.stderr).toBe(0);
    expect(run.stderr).toBe("");
    const diff = JSON.parse(run.stdout) as {
      subpaths: Record<
        string,
        {
          added: Record<string, unknown>;
          removed: Record<string, unknown>;
          changed: Record<string, unknown>;
        }
      >;
    };
    expect(Object.keys(diff.subpaths["."]?.added ?? {})).toEqual(["twin"]);
    expect(Object.keys(diff.subpaths["."]?.removed ?? {})).toEqual(["pair"]);
    expect(Object.keys(diff.subpaths["./labs"]?.added ?? {})).toEqual(["added"]);
    expect(Object.keys(diff.subpaths["./labs"]?.changed ?? {})).toEqual(["labs"]);
    expect(Object.keys(diff.subpaths["./battery"]?.added ?? {})).toEqual([]);
    expect(repoState()).toEqual(before);
  });

  it("--ci passes against a ledger holding its names and writes nothing but that ledger", () => {
    write(THROUGH_EXTENDS);
    commitAll("sets declarationDir");
    const before = repoState();

    const missing = cli("--ci");
    expect(missing.code, missing.stderr).toBe(1);

    const accepted = cli("--accept-api", "--reason", "published");
    expect(accepted.code, accepted.stderr).toBe(0);
    const { [API_LEDGER_FILENAME]: ledger, ...others } = snapshot();
    expect(others).toEqual(before.files);
    const recorded = JSON.parse(ledger ?? "") as { entries: { name: string }[] };
    expect(recorded.entries.map((entry) => entry.name).sort()).toEqual(NAMES);
    expect(git("status", "--porcelain")).toBe(`?? ${API_LEDGER_FILENAME}`);

    const held = snapshot();
    for (let run = 0; run < 2; run++) {
      const checked = cli("--ci");
      expect(checked.code, checked.stderr).toBe(0);
      expect(checked.stdout).toContain("PASS");
      expect(snapshot()).toEqual(held);
    }
  });

  it.each(
    SETTING,
  )("set through $how: an entry truly outside include exits 2 with the existing message", ({
    files,
  }) => {
    write({ ...files, [`${PKG}/other/index.ts`]: "export const other = 1;\n" });
    commitAll("sets declarationDir");
    fs.writeFileSync(mapFile, JSON.stringify({ "./other": { entry: "other/index.ts" } }));
    const before = repoState();

    const run = cli("--json");
    expect(run.code).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe(
      "code-graph: ./other: entry other/index.ts has no emitted declaration file (does the tsconfig include it?)\n",
    );
    expect(repoState()).toEqual(before);
  });
});
