import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { getCompilerOptionsFromTsConfig, type SourceFile, ts } from "ts-morph";
import { absurd } from "../absurd.js";
import type { PackageEdge } from "./dependencies.js";
import {
  type ExportEntry,
  exportEntries,
  sourceOfSubpath,
  subpathOf,
  subpathsOf,
} from "./entries.js";
import type { Exists } from "./heal.js";
import type { PathMove } from "./manifest.js";
import {
  moduleFileCandidates,
  moduleFileSpellings,
  moduleLiterals,
  namesCode,
  relativeSpecifierOf,
  withoutBundlerSuffix,
} from "./specifier.js";
import {
  packageLabel,
  packageOf,
  type Workspace,
  type WorkspacePackage,
} from "./workspace.js";

/**
 * Which extension a relative specifier must carry under the compiler options in force: NodeNext (`module` or `moduleResolution`, in any of its versions) asks
 * for one, `.ts` where the config lets imports name source files, `.js` otherwise.
 */
function specifierExtensionFrom(
  options: ts.CompilerOptions,
): "none" | "js" | "ts" {
  const resolution = options.moduleResolution;
  const nodeNext =
    resolution === undefined
      ? options.module !== undefined &&
        options.module >= ts.ModuleKind.Node16 &&
        options.module <= ts.ModuleKind.NodeNext
      : resolution === ts.ModuleResolutionKind.Node16 ||
        resolution === ts.ModuleResolutionKind.NodeNext;
  if (!nodeNext) return "none";
  return options.allowImportingTsExtensions === true ? "ts" : "js";
}

/**
 * What a specifier names in one tree. `outside`: no workspace package, so an npm package or a Node
 * builtin. `missing`: a relative path to no file. `file`: an absolute path. `package`: a workspace
 * package, by a subpath apply cannot follow to a file (a target with no source here, a `null` block).
 * Such an import still needs its package declared, wherever the importer lands. `alias`: a file in
 * this repository, through the importer's tsconfig `paths` or `baseUrl` or its package's `imports`,
 * a name that means something only from where the importer sits.
 */
export type Named =
  | { readonly kind: "outside" }
  | { readonly kind: "missing" }
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "package"; readonly pkg: WorkspacePackage }
  | { readonly kind: "alias"; readonly path: string };

/** Whether `specifier` matches a tsconfig `paths` key, which holds at most one `*`. */
const matchesPathsKey = (key: string, specifier: string): boolean => {
  const star = key.indexOf("*");
  if (star === -1) return key === specifier;
  const [before, after] = [key.slice(0, star), key.slice(star + 1)];
  return (
    specifier.length >= before.length + after.length &&
    specifier.startsWith(before) &&
    specifier.endsWith(after)
  );
};

/**
 * A workspace read against one tree: which file each specifier names there, and the subpath each
 * file is imported by from another package. `tree` decides which exact `exports` targets follow
 * back to a source, so the same workspace answers differently before and after the renames.
 */
export class PackageTree {
  readonly #entries = new Map<string, readonly ExportEntry[]>();
  readonly #options = new Map<string, ts.CompilerOptions>();

  constructor(
    readonly repoRoot: string,
    readonly workspace: Workspace,
    readonly tree: Exists,
  ) {}

  /** The compiler options of the `tsconfig.json` nearest `dir`; none when there is no such file. */
  #optionsAt(dir: string): ts.CompilerOptions {
    let options = this.#options.get(dir);
    if (options === undefined) {
      const config = ts.findConfigFile(dir, ts.sys.fileExists);
      options =
        config === undefined
          ? {}
          : getCompilerOptionsFromTsConfig(config).options;
      this.#options.set(dir, options);
    }
    return options;
  }

  /**
   * The file in this repository `literal` names from `importer` through tsconfig `paths`, tsconfig
   * `baseUrl` or a package's `imports`, read against `tree`. Only a specifier that looks like the
   * first or the last goes to the compiler, since this is asked of every quoted string in every
   * tracked source.
   */
  #aliased(importer: string, literal: string): string | undefined {
    const options = this.#optionsAt(dirname(importer));
    const looksAliased =
      literal.startsWith("#") ||
      Object.keys(options.paths ?? {}).some((key) =>
        matchesPathsKey(key, literal),
      );
    if (!looksAliased)
      return options.baseUrl === undefined
        ? undefined
        : moduleFileCandidates(resolve(options.baseUrl, literal)).find(
            this.tree,
          );
    const { resolvedModule } = ts.resolveModuleName(
      literal,
      importer,
      options,
      {
        fileExists: this.tree,
        readFile: ts.sys.readFile,
      },
    );
    return resolvedModule === undefined ||
      resolvedModule.isExternalLibraryImport === true
      ? undefined
      : resolvedModule.resolvedFileName;
  }

  /** The package an absolute path sits in. */
  packageAt(path: string): WorkspacePackage {
    return packageOf(this.workspace, relative(this.repoRoot, path));
  }

  /** What answers each subpath of `pkg`: its `exports`, or with none its `main` answering `.`. */
  #entriesOf(pkg: WorkspacePackage): readonly ExportEntry[] {
    let entries = this.#entries.get(pkg.root);
    if (entries === undefined) {
      const dir = join(this.repoRoot, pkg.root);
      entries = exportEntries(dir, pkg.exports ?? pkg.main, (p) =>
        this.tree(join(dir, p)),
      );
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
   * What `literal` names from `importer`. A relative specifier names a file by its base with the
   * module suffixes tried. A workspace package's name names a file by its `exports`; with no
   * `exports`, by its `main`, or by the path under the package, as Node reads it.
   */
  name(importer: string, literal: string): Named {
    if (literal.startsWith(".")) {
      const path = moduleFileCandidates(
        resolve(dirname(importer), literal),
      ).find(this.tree);
      return path === undefined ? { kind: "missing" } : { kind: "file", path };
    }
    const pkg = this.#owner(literal);
    if (pkg?.name === undefined) {
      const aliased = this.#aliased(importer, literal);
      return aliased === undefined
        ? { kind: "outside" }
        : { kind: "alias", path: aliased };
    }
    const subpath =
      literal === pkg.name ? "." : `./${literal.slice(pkg.name.length + 1)}`;
    const dir = join(this.repoRoot, pkg.root);
    const source = sourceOfSubpath(this.#entriesOf(pkg), subpath, (p) =>
      this.tree(join(dir, p)),
    );
    const path =
      source !== undefined
        ? join(dir, source)
        : pkg.exports === undefined
          ? moduleFileCandidates(
              join(dir, subpath === "." ? "index" : subpath),
            ).find(this.tree)
          : undefined;
    return path === undefined
      ? { kind: "package", pkg }
      : { kind: "file", path };
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

  /**
   * Every package-name specifier that names the absolute file `target` in this tree, as {@link name}
   * reads one: each `exports` subpath that reaches it, and with no `exports` the path under the package.
   */
  specifiersOf(target: string): string[] {
    const pkg = this.packageAt(target);
    if (pkg.name === undefined) return [];
    const { name } = pkg;
    const file = relative(join(this.repoRoot, pkg.root), target);
    return [
      ...subpathsOf(this.#entriesOf(pkg), file).map((subpath) =>
        subpath === "." ? name : `${name}/${subpath.slice(2)}`,
      ),
      ...(pkg.exports === undefined
        ? moduleFileSpellings(file).map((spelling) => `${name}/${spelling}`)
        : []),
    ];
  }

  /**
   * The relative specifier `importer` names the absolute file `target` by, in its own resolution.
   * An `.mjs` or `.cjs` importer runs under Node whatever the tsconfig says, so it keeps an extension.
   */
  relativeSpecifier(importer: string, target: string): string {
    const dir = dirname(importer);
    return relativeSpecifierOf(
      relative(dir, target),
      /\.[cm]js$/.test(importer)
        ? "js"
        : specifierExtensionFrom(this.#optionsAt(dir)),
    );
  }
}

/**
 * An import a row makes cross a package line that no `exports` entry of the target's package
 * reaches: the row, the file importing, the file imported, and the package it sits in.
 */
export type Unreachable = {
  readonly row: PathMove;
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
 * An import a row would leave broken with apply unable to say how, so it refuses: a relative
 * specifier in a file moving across a package line that names no file; a package-name specifier
 * into a package a row leaves that apply cannot follow to a file, so it may name a moved one; an
 * alias in a file moving across a package line, or naming a moved file, which apply does not rewrite;
 * a path built at run time for which the row changes which file a value loads (`templates.ts`); or a
 * string in a file apply reads only for quoted strings, which the row would stop naming its file
 * (`unreadImports`).
 */
export type Unfollowed = {
  readonly row: PathMove;
  readonly importer: string;
  readonly specifier: string;
} & (
  | { readonly kind: "no-file" }
  | { readonly kind: "unknown-file"; readonly pkg: WorkspacePackage }
  | { readonly kind: "alias" }
  | { readonly kind: "template" }
  | { readonly kind: "unread-file" }
);

const unfollowedReason = (unfollowed: Unfollowed): string => {
  switch (unfollowed.kind) {
    case "no-file":
      return "which names no file apply can find";
    case "unknown-file":
      return `and apply cannot tell which file of ${packageLabel(unfollowed.pkg)} that is, so a row may move it`;
    case "alias":
      return "an alias from tsconfig paths, tsconfig baseUrl or package.json imports, which apply does not rewrite";
    case "template":
      return "a path built at run time that apply cannot rewrite, and this row changes which file it loads";
    case "unread-file":
      return "in a kind of file apply does not rewrite, and this row would leave it naming the wrong file";
    default:
      return absurd(unfollowed);
  }
};

export const describeUnfollowed = (
  repoRoot: string,
  unfollowed: Unfollowed,
): string => {
  const { row, importer, specifier } = unfollowed;
  return `${row.from} -> ${row.to}  (${relative(repoRoot, importer)} imports "${specifier}", ${unfollowedReason(unfollowed)})`;
};

/** For each package a row leaves, one row that leaves it, keyed by package root. */
const rowsLeaving = (
  rows: readonly PathMove[],
  tree: PackageTree,
): ReadonlyMap<string, PathMove> =>
  new Map(
    rows.map((r) => [tree.packageAt(join(tree.repoRoot, r.from)).root, r]),
  );

/**
 * Rewrite every import a move touched — one written in a moved file, or one naming a moved file —
 * so it matches where its two ends now sit. Across a package line it becomes the target package's
 * name and `exports` subpath, unless it is a package-name specifier already naming a file that did
 * not move, which stays as written; inside one package a package-name specifier becomes relative,
 * and a relative one keeps what the move wrote when that still names the file. Bare specifiers are
 * resolved in the tree before the renames (`before`), since ts-morph left them naming the old paths;
 * relative ones in the tree after (`after`), since ts-morph already rewrote them, and in `before`
 * for an importer that stayed put and a literal ts-morph does not follow. Returns the imports no
 * `exports` entry carries across and the imports apply cannot follow, which the caller refuses
 * rather than writes, and the package edge of every import that crosses a line a move made it
 * cross, which the importing package must now declare.
 */
export function rewriteCrossings(
  sourceFiles: readonly SourceFile[],
  rows: readonly PathMove[],
  before: PackageTree,
  after: PackageTree,
): {
  readonly unreachable: Unreachable[];
  readonly unfollowed: Unfollowed[];
  readonly edges: PackageEdge[];
} {
  const at = (path: string) => join(after.repoRoot, path);
  const movedTo = new Map(rows.map((r) => [at(r.from), at(r.to)]));
  const landed = new Map(rows.map((r) => [at(r.to), r]));
  const leaving = rowsLeaving(rows, before);
  const unreachable: Unreachable[] = [];
  const unfollowed: Unfollowed[] = [];
  const edges: PackageEdge[] = [];
  for (const sf of sourceFiles) {
    const importer = sf.getFilePath();
    const home = after.packageAt(importer);
    const own = landed.get(importer);
    const crossed =
      own !== undefined && before.packageAt(at(own.from)).root !== home.root;
    for (const literal of moduleLiterals(sf)) {
      const value = literal.getLiteralValue();
      const relativeSpecifier = value.startsWith(".");
      const afterMove = relativeSpecifier
        ? after.name(importer, value)
        : before.name(own === undefined ? importer : at(own.from), value);
      const named =
        afterMove.kind === "missing" && own === undefined
          ? before.name(importer, value)
          : afterMove;
      if (named.kind === "outside") continue;
      if (named.kind === "alias") {
        const target = landed.get(movedTo.get(named.path) ?? "");
        const row = crossed ? own : target;
        if (row !== undefined)
          unfollowed.push({ kind: "alias", row, importer, specifier: value });
        continue;
      }
      if (named.kind === "missing") {
        if (crossed)
          unfollowed.push({
            kind: "no-file",
            row: own,
            importer,
            specifier: value,
          });
        continue;
      }
      if (named.kind === "package") {
        const row = leaving.get(named.pkg.root);
        if (row !== undefined && namesCode(value))
          unfollowed.push({
            kind: "unknown-file",
            row,
            importer,
            specifier: value,
            pkg: named.pkg,
          });
        else if (crossed && named.pkg.root !== home.root)
          edges.push({ from: home, to: named.pkg });
        continue;
      }
      const target = movedTo.get(named.path) ?? named.path;
      const row = own ?? landed.get(target);
      if (row === undefined) continue;
      const pkg = after.packageAt(target);
      if (pkg.root === home.root) {
        if (relativeSpecifier && afterMove.kind === "file") continue;
        literal.setLiteralValue(after.relativeSpecifier(importer, target));
        continue;
      }
      if (!relativeSpecifier && target === named.path) {
        edges.push({ from: home, to: pkg });
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
  return { unreachable, unfollowed, edges };
}

/** An opening quote, with what runs up to the next like quote on its line in a lookahead. */
const QUOTED = /(["'`])(?=((?:(?!\1)[^\n])+)\1)/g;

/**
 * Everything between two like quotes on one line of `text` — a cheap superset of its module
 * specifiers. The matches overlap, so an apostrophe earlier on the line cannot hide a specifier.
 */
const quotedStrings = (text: string): string[] =>
  [...text.matchAll(QUOTED)].flatMap(([, , quoted]) =>
    quoted === undefined ? [] : [quoted],
  );

/**
 * Those of `sources` in every workspace package holding one of them whose text names one of `rows`'
 * sources, or names a package a row leaves by a subpath apply cannot follow to a file, read in the
 * tree before the renames. These are the packages a move across a package line must load beyond its
 * scope, since an importer there needs rewriting or refusing too.
 */
export function importerPackageSources(
  sources: readonly string[],
  rows: readonly PathMove[],
  before: PackageTree,
): string[] {
  const moved = new Set(rows.map((r) => join(before.repoRoot, r.from)));
  const leaving = rowsLeaving(rows, before);
  const names = (named: Named, literal: string) =>
    named.kind === "file" || named.kind === "alias"
      ? moved.has(named.path)
      : named.kind === "package" &&
        leaving.has(named.pkg.root) &&
        namesCode(literal);
  const importing = new Set<string>();
  for (const file of sources) {
    const pkg = before.packageAt(file).root;
    if (importing.has(pkg)) continue;
    const quoted = quotedStrings(readFileSync(file, "utf8"));
    if (quoted.some((literal) => names(before.name(file, literal), literal)))
      importing.add(pkg);
  }
  return sources.filter((file) => importing.has(before.packageAt(file).root));
}

/**
 * The imports `rows` would break in `files`, which apply cannot parse or rewrite: each quoted string
 * that names a file in the tree before the renames and, read from where its file then sits, no longer
 * names that file after them. A bundler's query or hash after the path does not change what it names.
 * So a string naming a moved file is refused, and so is a moved file's string naming one left behind
 * and a string a row's destination takes over from the file it named, while a file moving together
 * with what it names passes. A package-name string into a package a row leaves that apply cannot
 * follow to a file is refused too, though it may name no moved file. The scan cannot tell an import
 * from prose quoting a path, so such prose is refused as well.
 */
export function unreadImports(
  files: readonly string[],
  rows: readonly PathMove[],
  before: PackageTree,
  after: PackageTree,
): Unfollowed[] {
  const at = (path: string) => join(before.repoRoot, path);
  const leavingFrom = new Map(rows.map((r) => [at(r.from), r]));
  const arrivingAt = new Map(rows.map((r) => [at(r.to), r]));
  const leaving = rowsLeaving(
    rows.filter(
      (r) =>
        before.packageAt(at(r.from)).root !== after.packageAt(at(r.to)).root,
    ),
    before,
  );
  return files.flatMap((importer) => {
    const own = leavingFrom.get(importer) ?? arrivingAt.get(importer);
    const was = own === undefined ? importer : at(own.from);
    const now = own === undefined ? importer : at(own.to);
    const unread = (specifier: string): Unfollowed | undefined => {
      const path = withoutBundlerSuffix(specifier);
      const named = before.name(was, path);
      if (named.kind === "package") {
        const row = leaving.get(named.pkg.root);
        return row !== undefined && namesCode(path)
          ? { kind: "unknown-file", row, importer, specifier, pkg: named.pkg }
          : undefined;
      }
      if (named.kind === "outside" || named.kind === "missing")
        return undefined;
      const moved = leavingFrom.get(named.path);
      const target = moved === undefined ? named.path : at(moved.to);
      const still = after.name(now, path);
      const landed =
        still.kind === "file" || still.kind === "alias"
          ? still.path
          : undefined;
      if (landed === target) return undefined;
      const row = moved ?? own ?? arrivingAt.get(landed ?? "");
      return row === undefined
        ? undefined
        : { kind: "unread-file", row, importer, specifier };
    };
    const quoted = new Set(quotedStrings(readFileSync(importer, "utf8")));
    return [...quoted].flatMap((specifier) => unread(specifier) ?? []);
  });
}
