import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { SourceFile } from "ts-morph";
import type { PackageEdge } from "./dependencies.js";
import {
  type ExportEntry,
  exportEntries,
  sourceOfSubpath,
  subpathOf,
} from "./entries.js";
import type { Exists } from "./heal.js";
import { moduleLiterals } from "./heal.js";
import type { MoveRow } from "./manifest.js";
import { splitSpecifierExtension } from "./mover.js";
import {
  packageLabel,
  packageOf,
  type Workspace,
  type WorkspacePackage,
} from "./workspace.js";

/** Where a relative specifier's base can land: a module file, or a directory's index. */
const MODULE_SUFFIXES = [".ts", ".tsx", "/index.ts", "/index.tsx"];

/**
 * A workspace read against one tree: which file each specifier names there, and the subpath each
 * file is imported by from another package. `tree` decides which exact `exports` targets follow
 * back to a source, so the same workspace answers differently before and after the renames.
 */
export class PackageTree {
  readonly #entries = new Map<string, readonly ExportEntry[]>();

  constructor(
    readonly repoRoot: string,
    readonly workspace: Workspace,
    readonly tree: Exists,
  ) {}

  /** The package an absolute path sits in. */
  packageAt(path: string): WorkspacePackage {
    return packageOf(this.workspace, relative(this.repoRoot, path));
  }

  #entriesOf(pkg: WorkspacePackage): readonly ExportEntry[] {
    let entries = this.#entries.get(pkg.root);
    if (entries === undefined) {
      const dir = join(this.repoRoot, pkg.root);
      entries = exportEntries(dir, pkg.exports, (p) => this.tree(join(dir, p)));
      this.#entries.set(pkg.root, entries);
    }
    return entries;
  }

  /** The workspace package a bare specifier names, by the longest matching `name`. */
  #owner(specifier: string): WorkspacePackage | undefined {
    let best: WorkspacePackage | undefined;
    for (const pkg of [this.workspace.root, ...this.workspace.members]) {
      const name = pkg.name;
      if (name === undefined) continue;
      if (specifier !== name && !specifier.startsWith(`${name}/`)) continue;
      if (best?.name === undefined || name.length > best.name.length)
        best = pkg;
    }
    return best;
  }

  /**
   * The absolute source file `literal` names from `importer`: a relative specifier by its base
   * with the module suffixes tried, a workspace package's name by its `exports`. `undefined` for
   * a specifier that names nothing in this workspace's tree.
   */
  resolve(importer: string, literal: string): string | undefined {
    if (literal.startsWith(".")) {
      const base = resolve(
        dirname(importer),
        splitSpecifierExtension(literal).base,
      );
      return MODULE_SUFFIXES.map((s) => `${base}${s}`).find(this.tree);
    }
    const pkg = this.#owner(literal);
    if (pkg?.name === undefined) return undefined;
    const subpath =
      literal === pkg.name ? "." : `./${literal.slice(pkg.name.length + 1)}`;
    const dir = join(this.repoRoot, pkg.root);
    const source = sourceOfSubpath(this.#entriesOf(pkg), subpath, (p) =>
      this.tree(join(dir, p)),
    );
    return source === undefined ? undefined : join(dir, source);
  }

  /**
   * The specifier another package imports the absolute file `target` by — its package's name and
   * the `exports` subpath that reaches it — or `undefined` when its package has no name or no
   * entry reaches the file.
   */
  specifierOf(target: string): string | undefined {
    const pkg = this.packageAt(target);
    if (pkg.name === undefined) return undefined;
    const file = relative(join(this.repoRoot, pkg.root), target);
    const subpath = subpathOf(this.#entriesOf(pkg), file);
    if (subpath === undefined) return undefined;
    return subpath === "." ? pkg.name : `${pkg.name}/${subpath.slice(2)}`;
  }
}

/**
 * An import a row makes cross a package line that no `exports` entry of the target's package
 * reaches: the row, the file importing, the file imported, and the package it sits in.
 */
export type Unreachable = {
  readonly row: MoveRow;
  readonly importer: string;
  readonly target: string;
  readonly pkg: WorkspacePackage;
};

export const describeUnreachable = (
  repoRoot: string,
  { row, importer, target, pkg }: Unreachable,
): string =>
  `${row.from} -> ${row.to}  (${relative(repoRoot, importer)} imports ${relative(repoRoot, target)}, which no exports entry of ${packageLabel(pkg)} reaches)`;

/**
 * Rewrite every import a move touched — one written in a moved file, or one naming a moved file —
 * so it matches where its two ends now sit. Across a package line it becomes the target package's
 * name and `exports` subpath; inside one package a package-name specifier becomes relative, and a
 * relative one keeps what the move wrote. Bare specifiers are resolved in the tree before the
 * renames (`before`), since ts-morph left them naming the old paths; relative ones in the tree
 * after (`after`), since ts-morph already rewrote them. Returns the imports no `exports` entry
 * carries across, which the caller refuses rather than writes, and the package edge of every import
 * it carried across, which the importing package must now declare.
 */
export function rewriteCrossings(
  sourceFiles: readonly SourceFile[],
  rows: readonly MoveRow[],
  before: PackageTree,
  after: PackageTree,
): { readonly unreachable: Unreachable[]; readonly edges: PackageEdge[] } {
  const at = (path: string) => join(after.repoRoot, path);
  const movedTo = new Map(rows.map((r) => [at(r.from), at(r.to)]));
  const landed = new Map(rows.map((r) => [at(r.to), r]));
  const unreachable: Unreachable[] = [];
  const edges: PackageEdge[] = [];
  for (const sf of sourceFiles) {
    const importer = sf.getFilePath();
    const home = after.packageAt(importer);
    for (const literal of moduleLiterals(sf)) {
      const value = literal.getLiteralValue();
      const relativeSpecifier = value.startsWith(".");
      const named = relativeSpecifier
        ? after.resolve(importer, value)
        : before.resolve(importer, value);
      if (named === undefined) continue;
      const target = movedTo.get(named) ?? named;
      const row = landed.get(importer) ?? landed.get(target);
      if (row === undefined) continue;
      const pkg = after.packageAt(target);
      if (pkg.root === home.root) {
        if (relativeSpecifier) continue;
        const rel = relative(dirname(importer), target).replace(/\.tsx?$/, "");
        literal.setLiteralValue(rel.startsWith(".") ? rel : `./${rel}`);
        continue;
      }
      const specifier = after.specifierOf(target);
      if (specifier === undefined) {
        unreachable.push({ row, importer, target, pkg });
        continue;
      }
      edges.push({ from: home, to: pkg });
      if (specifier !== value) literal.setLiteralValue(specifier);
    }
  }
  return { unreachable, edges };
}

/** Every quoted string in a file — a cheap superset of its module specifiers. */
const QUOTED = /["']([^"'\n]+)["']/g;

/**
 * The tracked source files, absolute, of every workspace package holding a file whose text names
 * one of `rows`' sources, read in the tree before the renames. These are the packages a move
 * across a package line must load beyond its scope, since an importer there needs rewriting too.
 */
export function importerPackageSources(
  sources: readonly string[],
  rows: readonly MoveRow[],
  before: PackageTree,
): string[] {
  const moved = new Set(rows.map((r) => join(before.repoRoot, r.from)));
  const importing = new Set<string>();
  for (const file of sources) {
    const pkg = before.packageAt(file).root;
    if (importing.has(pkg)) continue;
    const text = readFileSync(file, "utf8");
    for (const [, literal] of text.matchAll(QUOTED)) {
      const named =
        literal === undefined ? undefined : before.resolve(file, literal);
      if (named !== undefined && moved.has(named)) {
        importing.add(pkg);
        break;
      }
    }
  }
  return sources.filter((file) => importing.has(before.packageAt(file).root));
}
