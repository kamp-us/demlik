import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { Project, type TemplateExpression } from "ts-morph";
import type { PackageTree, Unfollowed } from "./crossing.js";
import type { PackageEdge } from "./dependencies.js";
import type { PathMove } from "./manifest.js";
import { moduleFileSpellings, moduleTemplates } from "./specifier.js";

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** What names a file: the spellings of a relative path, or a package's names for it. */
type NamesOf = (file: string) => readonly string[];

/** One path a run-time value can make the import spell, and the file that path loads. */
type Load = { readonly value: string; readonly file: string };

const loadsById = (loads: readonly Load[]): ReadonlyMap<string, Load> =>
  new Map(loads.map((load) => [`${load.value}\0${load.file}`, load]));

/**
 * An import whose path is built at run time, read as what never changes: the fixed text around each
 * `${}`. It is never rewritten, so all a move can do to it is change which files it can load.
 */
class ImportTemplate {
  /** The specifier as the file spells it, with no backticks. */
  readonly written: string;
  readonly #start: string;
  readonly #rest: readonly string[];

  constructor(node: TemplateExpression) {
    this.written = node.getText().slice(1, -1);
    this.#start = node.getHead().getLiteralText();
    this.#rest = node
      .getTemplateSpans()
      .map((span) => span.getLiteral().getLiteralText());
  }

  /** `${base}/one` starts with nothing fixed, and `/x/${y}` with no path in this repository. */
  get matchable(): boolean {
    return this.#start !== "" && !this.#start.startsWith("/");
  }

  get relative(): boolean {
    return this.#start.startsWith(".");
  }

  /**
   * What this import can load from `importer`, each of `files` known by `names`. A `${}` stands for
   * any text, a `/` included: `./${dir}/x` can load `./a/b/x`. A relative name is read back from the
   * importer's directory, since that is what the unchanged template goes on spelling.
   */
  loads(
    importer: string,
    files: readonly string[],
    names: NamesOf,
  ): ReadonlyMap<string, Load> {
    const dir = dirname(importer);
    const start = this.relative ? join(dir, this.#start) : this.#start;
    const pattern = new RegExp(
      `^${[start, ...this.#rest].map(escaped).join(".*")}$`,
      "s",
    );
    return loadsById(
      files.flatMap((file) =>
        names(file)
          .filter((name) => pattern.test(name))
          .map((name) => ({
            value: this.relative ? relative(dir, name) : name,
            file,
          })),
      ),
    );
  }
}

/** Everything one move is checked against. */
export type TemplateCheck = {
  readonly rows: readonly PathMove[];
  readonly before: PackageTree;
  readonly after: PackageTree;
  /** Every tracked file as an absolute path, each row at whichever end the disk holds it. */
  readonly tracked: readonly string[];
  /** Those of `tracked` apply reads as modules. */
  readonly modules: readonly string[];
};

/**
 * Every import built at run time that `rows` change: each path it can spell and the file that path
 * loads before the move, the file carried through the rows, against the same after it. Equal sets
 * mean every run-time value still loads the same file, as for a folder moved whole. A file moved
 * within a wide `./${path}` differs, since it now answers to another value. The rows behind any
 * difference are named for the caller to refuse. Worked from tracked files and the rows alone, so
 * the answer is the same whether the renames are still to be made or an earlier run committed them,
 * and whether or not a row crosses a package line. A moved file's package-name template also yields
 * the edge its new package must declare.
 */
export function checkTemplates({
  rows,
  before,
  after,
  tracked,
  modules,
}: TemplateCheck): {
  readonly unfollowed: readonly Unfollowed[];
  readonly edges: readonly PackageEdge[];
} {
  const at = (path: string) => join(before.repoRoot, path);
  const landing = new Map(rows.map((r) => [at(r.from), at(r.to)]));
  const origin = new Map(rows.map((r) => [at(r.to), at(r.from)]));
  const rowOf = new Map(
    rows.flatMap((r) => [
      [at(r.from), r],
      [at(r.to), r],
    ]),
  );
  const filesBefore = tracked.map((file) => origin.get(file) ?? file);
  const filesAfter = tracked.map((file) => landing.get(file) ?? file);
  const spelled = new Map<string, readonly string[]>();
  const spellings: NamesOf = (file) => {
    const known = spelled.get(file) ?? moduleFileSpellings(file);
    spelled.set(file, known);
    return known;
  };
  const parser = new Project({
    useInMemoryFileSystem: true,
    skipLoadingLibFiles: true,
  });
  const unfollowed: Unfollowed[] = [];
  const edges: PackageEdge[] = [];
  for (const path of modules) {
    const text = readFileSync(path, "utf8");
    if (!text.includes("${")) continue;
    const source = parser.createSourceFile(path, text);
    const templates = moduleTemplates(source)
      .map((node) => new ImportTemplate(node))
      .filter((template) => template.matchable);
    parser.removeSourceFile(source);
    const importerBefore = origin.get(path) ?? path;
    const importer = landing.get(path) ?? path;
    const own = rowOf.get(path);
    const home = after.packageAt(importer);
    const crossed = before.packageAt(importerBefore).root !== home.root;
    for (const template of templates) {
      const [namesBefore, namesAfter] = template.relative
        ? [spellings, spellings]
        : [
            (file: string) => before.specifiersOf(file),
            (file: string) => after.specifiersOf(file),
          ];
      const carried = loadsById(
        [
          ...template.loads(importerBefore, filesBefore, namesBefore).values(),
        ].map(({ value, file }) => ({
          value,
          file: landing.get(file) ?? file,
        })),
      );
      const reachable = template.loads(importer, filesAfter, namesAfter);
      const changed = [
        ...[...carried].filter(([id]) => !reachable.has(id)),
        ...[...reachable].filter(([id]) => !carried.has(id)),
      ];
      const behind = new Set(
        changed.flatMap(([, { file }]) => {
          const row = rowOf.get(file) ?? own;
          return row === undefined ? [] : [row];
        }),
      );
      for (const row of behind)
        unfollowed.push({
          kind: "template",
          row,
          importer,
          specifier: template.written,
        });
      if (crossed && !template.relative)
        for (const { file } of reachable.values()) {
          const pkg = after.packageAt(file);
          if (pkg.root !== home.root) edges.push({ from: home, to: pkg });
        }
    }
  }
  return { unfollowed, edges };
}
