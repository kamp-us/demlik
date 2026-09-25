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

function offends(source: string): boolean {
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
        PATH_LISTING.has(literal(node) ?? ""),
      ),
    );
  });
}

/** The sources, by their `src/`-relative path, that list paths with git outside `git.ts`. */
function pathListingOffenders(sources: ReadonlyMap<string, string>): string[] {
  return [...sources]
    .filter(([path, text]) => !exempt(path) && offends(text))
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
