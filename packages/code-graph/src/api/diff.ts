import fs from "node:fs";
import path from "node:path";
import { checkoutOf, exportBaseTree, removeBaseTree, resolveBase } from "./base.js";
import { type ApiSubpath, apiSubpaths } from "./map.js";
import type { ApiEntryText, SubpathNames } from "./read.js";
import {
  type EmittedNames,
  type PublishedApiOptions,
  packageRoot,
  projectRelative,
  readEmittedNames,
} from "./view.js";

export type SubpathDiff = {
  readonly tier: string | null;
  readonly added: Readonly<Record<string, { readonly after: ApiEntryText }>>;
  readonly removed: Readonly<Record<string, { readonly before: ApiEntryText }>>;
  readonly changed: Readonly<
    Record<string, { readonly before: ApiEntryText; readonly after: ApiEntryText }>
  >;
};

// What a change did to a package's published API against a base commit (SPEC §13.4).
export type ApiDiff = {
  readonly root: string;
  readonly base: string;
  readonly compiler: string;
  readonly subpaths: Readonly<Record<string, SubpathDiff>>;
};

function sameReferences(a: ApiEntryText["references"], b: ApiEntryText["references"]): boolean {
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => Object.hasOwn(b, key) && a[key] === b[key])
  );
}

const sameEntry = (a: ApiEntryText, b: ApiEntryText): boolean =>
  a.text === b.text && sameReferences(a.references, b.references);

// One subpath's names at the base against its names now: exact string equality on text and
// references.
export function diffSubpathNames(
  tier: string | null,
  before: SubpathNames,
  after: SubpathNames,
): SubpathDiff {
  const added: Record<string, { after: ApiEntryText }> = {};
  const removed: Record<string, { before: ApiEntryText }> = {};
  const changed: Record<string, { before: ApiEntryText; after: ApiEntryText }> = {};
  for (const [name, now] of Object.entries(after)) {
    const then = Object.hasOwn(before, name) ? before[name] : undefined;
    if (then === undefined) added[name] = { after: now };
    else if (!sameEntry(then, now)) changed[name] = { before: then, after: now };
  }
  for (const [name, then] of Object.entries(before)) {
    if (!Object.hasOwn(after, name)) removed[name] = { before: then };
  }
  return { tier, added, removed, changed };
}

// The map's subpaths as they stand in the base tree: a subpath whose entry the base commit lacks is
// left out, so every name it publishes now is `added`.
function subpathsAtBase(baseRoot: string, subpaths: readonly ApiSubpath[]): readonly ApiSubpath[] {
  return subpaths.flatMap((subpath) => {
    const entryAbsolute = path.join(baseRoot, subpath.entry);
    return fs.existsSync(entryAbsolute) && fs.statSync(entryAbsolute).isFile()
      ? [{ ...subpath, entryAbsolute }]
      : [];
  });
}

async function readBaseNames(
  rootAbsolute: string,
  sha: string,
  subpaths: readonly ApiSubpath[],
  options: PublishedApiOptions,
): Promise<EmittedNames["names"]> {
  const checkout = checkoutOf(rootAbsolute);
  const tree = await exportBaseTree(checkout, sha);
  try {
    const present = subpathsAtBase(tree.root, subpaths);
    if (present.length === 0) return new Map();
    const { names } = await readEmittedNames(tree.root, present, {
      ...options,
      repoRoot: tree.temp,
      context: ` at the base ${sha.slice(0, 12)}`,
    });
    return names;
  } finally {
    removeBaseTree(tree);
  }
}

// The published-API diff of the package at `root` against the commit `base` names (SPEC §13.4).
// The base tree is read from the repository's objects into a temp folder outside the checkout;
// the checkout's files, index and refs are never written. The "after" side is the working tree as
// it is, uncommitted edits included.
export async function diffPublishedApi(
  root: string,
  map: unknown,
  base: string,
  options: PublishedApiOptions = {},
): Promise<ApiDiff> {
  const rootAbsolute = packageRoot(root);
  const subpaths = apiSubpaths(rootAbsolute, map);
  const sha = resolveBase(checkoutOf(rootAbsolute), base);
  const now = await readEmittedNames(rootAbsolute, subpaths, options);
  const before = await readBaseNames(rootAbsolute, sha, subpaths, options);
  const diff: Record<string, SubpathDiff> = {};
  for (const { subpath, tier } of subpaths) {
    diff[subpath] = diffSubpathNames(tier, before.get(subpath) ?? {}, now.names.get(subpath) ?? {});
  }
  return { root: projectRelative(rootAbsolute), base: sha, compiler: now.compiler, subpaths: diff };
}
