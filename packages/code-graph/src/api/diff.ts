import fs from "node:fs";
import path from "node:path";
import { checkoutOf, exportBaseTree, removeBaseTree, resolveBase } from "./base.js";
import { type ApiSubpath, apiSubpaths, baseApiSubpaths } from "./map.js";
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

// What the diff takes beyond the view's options (SPEC §13.4).
export type ApiDiffOptions = PublishedApiOptions & {
  // Reads the API map the package had at the base commit. It is called with the package root
  // inside the base tree, so it can read the files that stated the map then, and the base side is
  // read through its answer. Without it the base is read through `map`, which cannot name a
  // subpath the working tree no longer has.
  readonly baseMap?: (baseRoot: string) => unknown | Promise<unknown>;
};

const isDirectory = (dir: string): boolean => fs.existsSync(dir) && fs.statSync(dir).isDirectory();

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

// What the base commit publishes: the subpaths it is read through, and each one's names.
type BaseSide = {
  readonly subpaths: readonly ApiSubpath[];
  readonly names: EmittedNames["names"];
};

async function readBaseSide(
  rootAbsolute: string,
  sha: string,
  subpaths: readonly ApiSubpath[],
  baseMap: ApiDiffOptions["baseMap"],
  options: PublishedApiOptions,
): Promise<BaseSide> {
  const checkout = checkoutOf(rootAbsolute);
  const tree = await exportBaseTree(checkout, sha);
  try {
    // A commit that predates the package has no map to read: it published nothing.
    const present =
      baseMap === undefined
        ? subpathsAtBase(tree.root, subpaths)
        : isDirectory(tree.root)
          ? baseApiSubpaths(tree.root, await baseMap(tree.root), sha)
          : [];
    if (present.length === 0) return { subpaths: present, names: new Map() };
    const { names } = await readEmittedNames(tree.root, present, {
      ...options,
      repoRoot: tree.temp,
      context: ` at the base ${sha.slice(0, 12)}`,
    });
    return { subpaths: present, names };
  } finally {
    removeBaseTree(tree);
  }
}

// The published-API diff of the package at `root` against the commit `base` names (SPEC §13.4).
// The base tree is read from the repository's objects into a temp folder outside the checkout;
// the checkout's files, index and refs are never written. The "after" side is the working tree as
// it is, uncommitted edits included. With `options.baseMap`, a subpath only the base map names is
// a key too, with the tier that map gave it and every name it published `removed`.
export async function diffPublishedApi(
  root: string,
  map: unknown,
  base: string,
  { baseMap, ...options }: ApiDiffOptions = {},
): Promise<ApiDiff> {
  const rootAbsolute = packageRoot(root);
  const subpaths = apiSubpaths(rootAbsolute, map);
  const sha = resolveBase(checkoutOf(rootAbsolute), base);
  const now = await readEmittedNames(rootAbsolute, subpaths, options);
  const before = await readBaseSide(rootAbsolute, sha, subpaths, baseMap, options);
  const kept = new Set(subpaths.map(({ subpath }) => subpath));
  const gone = before.subpaths.filter(({ subpath }) => !kept.has(subpath));
  const diff: Record<string, SubpathDiff> = {};
  for (const { subpath, tier } of [...subpaths, ...gone].sort((a, b) =>
    a.subpath < b.subpath ? -1 : a.subpath > b.subpath ? 1 : 0,
  )) {
    diff[subpath] = diffSubpathNames(
      tier,
      before.names.get(subpath) ?? {},
      now.names.get(subpath) ?? {},
    );
  }
  return { root: projectRelative(rootAbsolute), base: sha, compiler: now.compiler, subpaths: diff };
}
