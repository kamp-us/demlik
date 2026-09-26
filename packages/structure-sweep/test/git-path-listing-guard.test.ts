import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { type Node, Project, SyntaxKind } from "ts-morph";
import { describe, expect, it } from "vitest";

/**
 * Every git path listing goes through `src/git.ts`, which reads git's NUL-separated output so a
 * non-ASCII name is never C-quoted (#400, #402). This guard names every other source that spawns
 * git itself or hands the `git()` helper a path-listing argument.
 */

const SRC = join(import.meta.dirname, "../src");

const SPAWNS = new Set([
  "spawnSync",
  "execFileSync",
  "execSync",
  "spawn",
  "exec",
]);
const PATH_LISTING = new Set([
  "ls-files",
  "ls-tree",
  "check-ignore",
  "--name-only",
  "--name-status",
]);

/** Paths relative to `src/`, forward-slashed. */
function exempt(path: string): boolean {
  return path === "git.ts";
}

function literal(node: Node | undefined): string | undefined {
  return node?.isKind(SyntaxKind.StringLiteral) ||
    node?.isKind(SyntaxKind.NoSubstitutionTemplateLiteral)
    ? node.getLiteralText()
    : undefined;
}

function spawnsGit(command: string | undefined): boolean {
  return command !== undefined && /^git(\s|$)/.test(command);
}

/** Whether `source` spawns git itself, or hands `git()` an argument in `flagged`. */
function callsGit(source: string, flagged: ReadonlySet<string>): boolean {
  const project = new Project({ useInMemoryFileSystem: true });
  const file = project.createSourceFile("source.ts", source);
  return file.getDescendantsOfKind(SyntaxKind.CallExpression).some((call) => {
    const callee = call.getExpression();
    const name = callee.isKind(SyntaxKind.PropertyAccessExpression)
      ? callee.getName()
      : callee.getText();
    const args = call.getArguments();
    if (SPAWNS.has(name)) return spawnsGit(literal(args[0]));
    if (name !== "git") return false;
    return args.some((arg) =>
      [arg, ...arg.getDescendants()].some((node) =>
        flagged.has(literal(node) ?? ""),
      ),
    );
  });
}

/** The sources, by their `src/`-relative path, that list paths with git outside `git.ts`. */
function pathListingOffenders(sources: ReadonlyMap<string, string>): string[] {
  return [...sources]
    .filter(([path, text]) => !exempt(path) && callsGit(text, PATH_LISTING))
    .map(([path]) => path);
}

function sourceTree(dir: string): Map<string, string> {
  return new Map(
    readdirSync(dir, { recursive: true, encoding: "utf8" })
      .filter((path) => path.endsWith(".ts"))
      .map((path) => [
        relative(dir, join(dir, path)).split("\\").join("/"),
        readFileSync(join(dir, path), "utf8"),
      ]),
  );
}

/**
 * `propose` reads file content through `blobsAt`, one subprocess for every file, never one
 * `git show` per file (#436). A `propose/` source that hands `git()` a `show` or spawns git itself
 * is named.
 */
const PER_FILE_READ = new Set(["show", "cat-file"]);

function proposeReadOffenders(sources: ReadonlyMap<string, string>): string[] {
  return [...sources]
    .filter(
      ([path, text]) =>
        path.startsWith("propose/") && callsGit(text, PER_FILE_READ),
    )
    .map(([path]) => path);
}

describe("the propose content-read guard", () => {
  it("finds no propose source that reads git itself", () => {
    expect(proposeReadOffenders(sourceTree(SRC))).toEqual([]);
  });

  it("names a propose source that shows a blob or spawns git, and nothing outside propose", () => {
    const show = 'git(root, ["show", ref + ":" + path]);';
    const samples = new Map([
      ["propose/signals.ts", show],
      ["propose/spawn.ts", 'spawnSync("git", ["cat-file", "--batch"]);'],
      ["propose/helper.ts", "blobsAt(root, ref, paths);"],
      ["sweep/show.ts", show],
    ]);
    expect(proposeReadOffenders(samples)).toEqual([
      "propose/signals.ts",
      "propose/spawn.ts",
    ]);
  });
});

describe("the git path-listing guard", () => {
  it("finds no source outside git.ts that lists paths with git", () => {
    expect(pathListingOffenders(sourceTree(SRC))).toEqual([]);
  });

  it("reports a source that spawns git check-ignore itself", () => {
    const sample = [
      'import { spawnSync } from "node:child_process";',
      'spawnSync("git", ["check-ignore", "--stdin"], { input: "a" });',
    ].join("\n");
    expect(
      pathListingOffenders(new Map([["pairs/sample.ts", sample]])),
    ).toEqual(["pairs/sample.ts"]);
  });

  it("reports a path-listing argument handed to git()", () => {
    const samples = new Map([
      ["log.ts", 'git(root, ["log", "HEAD", "--name-only"]);'],
      ["diff.ts", 'git(root, ["diff", ...["--name-status"], "HEAD"]);'],
      ["shell.ts", 'execSync("git ls-files", { cwd });'],
      ["show.ts", 'git(root, ["show", ref + ":" + path]);'],
      ["biome.ts", 'execFileSync(biome, ["check", "--write"]);'],
      ["regex.ts", "SPECIFIER.exec(specifier);"],
    ]);
    expect(pathListingOffenders(samples)).toEqual([
      "log.ts",
      "diff.ts",
      "shell.ts",
    ]);
  });

  it("exempts git.ts and nothing else", () => {
    const sample = 'git(root, ["ls-tree", "-r", "-z", "--name-only", ref]);';
    expect(
      pathListingOffenders(
        new Map([
          ["git.ts", sample],
          ["propose/signals.ts", sample],
        ]),
      ),
    ).toEqual(["propose/signals.ts"]);
  });
});
