import fs from "node:fs";
import path from "node:path";
import { findRepoRoot } from "../../extract/project.js";
import { checkoutOf, namesAtBase, resolveBase } from "../base.js";
import { ApiInputError } from "../map.js";
import { packageRoot } from "../view.js";
import type { Bump } from "./policy.js";

const CHANGESET_DIR = ".changeset";

// A bump a changeset can give a package and still count (SPEC §13.5): `none` releases nothing.
export type ChangesetBump = Exclude<Bump, "none">;

// One counted changeset: its repo-relative file, the bump it gives the package, and its body.
export type Changeset = {
  readonly file: string;
  readonly bump: ChangesetBump;
  readonly body: string;
};

// The package's changesets added since a base commit (SPEC §13.5).
export type ChangesetsSince = {
  readonly package: string;
  readonly changesets: readonly Changeset[];
};

export type ChangesetsOptions = { readonly repoRoot?: string };

export type ChangesetText = {
  readonly bumps: ReadonlyMap<string, Bump>;
  readonly body: string;
};

const BUMP_LINE = /^\s*(?:"([^"]+)"|'([^']+)'|([^\s:"']+))\s*:\s*(major|minor|patch|none)\s*$/;

// The changesets format: a block between two `---` lines whose lines read `"<package>": <bump>`,
// then the body. `null` when the text does not have that shape.
export function parseChangeset(text: string): ChangesetText | null {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  const closing = lines.findIndex((line, index) => index > 0 && line.trimEnd() === "---");
  if (lines[0]?.trimEnd() !== "---" || closing === -1) return null;
  const bumps = new Map<string, Bump>();
  for (const line of lines.slice(1, closing)) {
    if (line.trim() === "") continue;
    const match = BUMP_LINE.exec(line);
    if (match === null) return null;
    bumps.set((match[1] ?? match[2] ?? match[3]) as string, match[4] as Bump);
  }
  return { bumps, body: lines.slice(closing + 1).join("\n") };
}

function packageName(rootAbsolute: string): string {
  const file = path.join(rootAbsolute, "package.json");
  let name: unknown;
  try {
    name = (JSON.parse(fs.readFileSync(file, "utf8")) as { name?: unknown }).name;
  } catch {
    throw new ApiInputError(`cannot read ${file}; the ratchet needs the package's name`);
  }
  if (typeof name !== "string" || name === "") {
    throw new ApiInputError(`${file} has no name; the ratchet needs the package's name`);
  }
  return name;
}

// The `.md` files directly in the working tree's `.changeset/`, bar its README, sorted.
function changesetFilesNow(repoRoot: string): readonly string[] {
  const dir = path.join(repoRoot, CHANGESET_DIR);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md") && entry.name !== "README.md")
    .map((entry) => `${CHANGESET_DIR}/${entry.name}`)
    .sort();
}

function countedChangeset(repoRoot: string, file: string, named: string): readonly Changeset[] {
  const parsed = parseChangeset(fs.readFileSync(path.join(repoRoot, file), "utf8"));
  if (parsed === null) {
    throw new ApiInputError(
      `changeset ${file} has no frontmatter that parses: expected a block between two --- lines whose lines read "<package>": major | minor | patch | none`,
    );
  }
  const bump = parsed.bumps.get(named);
  if (bump === undefined || bump === "none") return [];
  return [{ file, bump, body: parsed.body }];
}

// The changesets that count for the package at `root` since the commit `base` names (SPEC §13.5):
// the `.md` files in the repo root's `.changeset/` that the working tree has, the base commit's
// tree lacks, and whose frontmatter gives the package a `major`, `minor` or `patch` bump. It only
// reads: the working tree's files, and `git ls-tree` on the base.
export function readChangesetsSince(
  root: string,
  base: string,
  options: ChangesetsOptions = {},
): ChangesetsSince {
  const rootAbsolute = packageRoot(root);
  const named = packageName(rootAbsolute);
  const repoRoot = options.repoRoot ?? findRepoRoot(rootAbsolute);
  const sha = resolveBase(checkoutOf(rootAbsolute), base);
  const atBase = new Set(namesAtBase(repoRoot, sha, `${CHANGESET_DIR}/`));
  const changesets = changesetFilesNow(repoRoot)
    .filter((file) => !atBase.has(file))
    .flatMap((file) => countedChangeset(repoRoot, file, named));
  return { package: named, changesets };
}
