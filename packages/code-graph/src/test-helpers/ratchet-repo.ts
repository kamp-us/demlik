import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The committed ratchet fixture (test/api/ratchet): the package `@demo/pkg` with a `stable`, a
// `battery` and an `experimental` subpath (`base/`), one overlay per branch (`branches/<name>/`,
// holding only the files that branch rewrites), the API map and a bump policy with a row for every
// tier and change kind.
const here = path.dirname(fileURLToPath(import.meta.url));
export const PACKAGE_DIR = path.resolve(here, "..", "..");
export const FIXTURE = path.join(PACKAGE_DIR, "test", "api", "ratchet");
export const MAP_FILE = path.join(FIXTURE, "api-map.json");
export const POLICY_FILE = path.join(FIXTURE, "policy.json");
const CLI = path.join(PACKAGE_DIR, "src", "index.ts");

export const PACKAGE_NAME = "@demo/pkg";
export const CALLOUT = "**Breaking:** callers must change.";

export const git = (cwd: string, ...args: string[]): string =>
  execFileSync(
    "git",
    ["-c", "user.name=fixture", "-c", "user.email=fixture@example.com", ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );

// A changeset file's text: one frontmatter line per package, then the body.
export const changeset = (bumps: Readonly<Record<string, string>>, body = "A change."): string =>
  `---\n${Object.entries(bumps)
    .map(([name, bump]) => `"${name}": ${bump}\n`)
    .join("")}---\n\n${body}\n`;

// A changeset for the fixture package; `callout` puts the policy's marker in its body.
export const bumped = (bump: string, callout = false): string =>
  changeset({ [PACKAGE_NAME]: bump }, callout ? CALLOUT : "A change.");

export type RatchetRepo = {
  readonly top: string;
  // The package root, `packages/demo` below the repository's top.
  readonly root: string;
  // The base commit every branch is cut from: `main`'s sha.
  readonly base: string;
};

// A throwaway repository with the fixture's base committed on `main`: a pnpm workspace whose
// `.changeset/` already holds a README and one shipped changeset for the package (a `major` with
// the callout), which predate every branch and so must never count.
export function ratchetRepository(): RatchetRepo {
  const top = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "code-graph-ratchet-")));
  const root = path.join(top, "packages", "demo");
  git(top, "init", "--quiet", "--initial-branch=main");
  fs.writeFileSync(path.join(top, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"\n');
  fs.mkdirSync(path.join(top, ".changeset"));
  fs.writeFileSync(path.join(top, ".changeset", "README.md"), "# Changesets\n");
  fs.writeFileSync(path.join(top, ".changeset", "shipped.md"), bumped("major", true));
  fs.cpSync(path.join(FIXTURE, "base"), root, { recursive: true });
  git(top, "add", "-A");
  git(top, "commit", "--quiet", "--no-gpg-sign", "-m", "base");
  return { top, root, base: git(top, "rev-parse", "HEAD").trim() };
}

// Commits `files` (repo-relative path → text) on the branch the repository is on.
export function commitFiles(repo: RatchetRepo, files: Readonly<Record<string, string>>): void {
  for (const [relative, text] of Object.entries(files)) {
    const file = path.join(repo.top, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  git(repo.top, "add", "-A");
  git(repo.top, "commit", "--quiet", "--no-gpg-sign", "--allow-empty", "-m", "files");
}

// Cuts the fixture branch `name` off `main` afresh, as a PR would: its overlay committed over the
// base, then `changesets` (file name → text) committed into `.changeset/`.
export function checkoutBranch(
  repo: RatchetRepo,
  name: string,
  changesets: Readonly<Record<string, string>> = {},
): void {
  git(repo.top, "checkout", "--quiet", "-B", name, "main");
  fs.cpSync(path.join(FIXTURE, "branches", name), repo.root, { recursive: true });
  const files = Object.entries(changesets).map(([file, text]) => [`.changeset/${file}`, text]);
  commitFiles(repo, Object.fromEntries(files));
}

export type CliRun = { readonly code: number; readonly stdout: string; readonly stderr: string };

export function runCli(args: readonly string[]): CliRun {
  try {
    const stdout = execFileSync(process.execPath, ["--import", "tsx", CLI, ...args], {
      cwd: PACKAGE_DIR,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout, stderr: "" };
  } catch (error) {
    const failed = error as { status: number; stdout: string; stderr: string };
    return { code: failed.status, stdout: failed.stdout, stderr: failed.stderr };
  }
}

// The gate as a CI job runs it on the checked-out branch: the fixture's map, `main` as the base
// and the fixture's policy unless `policyFile` names another.
export const runGate = (
  repo: RatchetRepo,
  extra: readonly string[] = [],
  policyFile = POLICY_FILE,
): CliRun =>
  runCli([
    repo.root,
    "--api",
    MAP_FILE,
    "--api-base",
    "main",
    "--api-policy",
    policyFile,
    ...extra,
  ]);
