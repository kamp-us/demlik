import path from "node:path";
import { Node, type Project, type SourceFile, SyntaxKind } from "ts-morph";
import { moduleLiterals, splitSpecifierExtension } from "./specifier.js";

/** One file move, both ends relative to the root the moves are applied under. */
export type Move = readonly [from: string, to: string];

export const stripExtension = (filePath: string) =>
  filePath.replace(/\.tsx?$/, "");

/** A source file's path with its extension off, `.d.ts` included: what a specifier's base names. */
const moduleBase = (filePath: string) =>
  filePath.replace(/(?:\.d)?\.[cm]?[jt]sx?$/, "");

/** The source files a specifier written with an extension can name, most likely first. */
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".d.ts"];

function relativeSpecifier(fromDir: string, to: string): string {
  const rel = path.relative(fromDir, to);
  return rel.startsWith(".") ? rel : `./${rel}`;
}

/** One relative specifier written with an extension, and the source file it named before any move. */
type Extended = {
  readonly literal: string;
  readonly extension: string;
  readonly target: SourceFile | undefined;
};

/**
 * Where `literal` points, when it is relative and carries an extension; `null` otherwise, since
 * an extensionless specifier is left as ts-morph writes it.
 */
function extendedOf(
  project: Project,
  dir: string,
  literal: string,
): Extended | null {
  if (!literal.startsWith(".")) return null;
  const { base, extension } = splitSpecifierExtension(literal);
  if (extension === "") return null;
  const resolved = path.resolve(dir, base);
  const target = [extension, ...SOURCE_EXTENSIONS]
    .map((suffix) => project.getSourceFile(`${resolved}${suffix}`))
    .find((sf) => sf !== undefined);
  return { literal, extension, target };
}

/**
 * Each file's module specifiers as written, position by position, before any move: ts-morph's
 * `move` rewrites a specifier without the extension it carried, and NodeNext needs it back.
 */
function specifiersBeforeMove(
  project: Project,
): Map<SourceFile, readonly (Extended | null)[]> {
  return new Map(
    project.getSourceFiles().map((sf) => {
      const dir = path.dirname(sf.getFilePath());
      return [
        sf,
        moduleLiterals(sf).map((l) =>
          extendedOf(project, dir, l.getLiteralValue()),
        ),
      ];
    }),
  );
}

/**
 * Put back the extension on every specifier ts-morph rewrote without one. The specifier is
 * re-derived from the file it named, now at its new path, so a `./x/index.js` keeps naming
 * the index file rather than its directory.
 */
function restoreExtensions(
  project: Project,
  before: ReadonlyMap<SourceFile, readonly (Extended | null)[]>,
): void {
  for (const sourceFile of project.getSourceFiles()) {
    const written = before.get(sourceFile);
    if (written === undefined) continue;
    const dir = path.dirname(sourceFile.getFilePath());
    moduleLiterals(sourceFile).forEach((specifier, i) => {
      const was = written[i];
      const now = specifier.getLiteralValue();
      if (!was || now === was.literal) return;
      if (splitSpecifierExtension(now).extension !== "") return;
      const base = was.target
        ? relativeSpecifier(dir, moduleBase(was.target.getFilePath()))
        : now;
      specifier.setLiteralValue(`${base}${was.extension}`);
    });
  }
}

/**
 * The module-path arguments ts-morph's `move` does not rewrite: it follows import and export
 * declarations, but a `vi.mock("../x")` is just a call with a string in it.
 */
const MOCK_CALLEES = new Set([
  "vi.mock",
  "vi.doMock",
  "vi.unmock",
  "vi.doUnmock",
  "vi.importActual",
  "vi.importMock",
]);

function resolveTarget(
  originalDir: string,
  literalBase: string,
  movedModules: ReadonlyMap<string, string>,
): string {
  const before = path.resolve(originalDir, literalBase);

  const movedFile = movedModules.get(before);
  if (movedFile) return stripExtension(movedFile);

  const movedIndex = movedModules.get(path.join(before, "index"));
  if (movedIndex) return path.dirname(movedIndex);

  return before;
}

function remapMockSpecifiers(
  project: Project,
  dirBeforeMove: ReadonlyMap<SourceFile, string>,
  movedModules: ReadonlyMap<string, string>,
): number {
  let remapped = 0;

  for (const sourceFile of project.getSourceFiles()) {
    const originalDir = dirBeforeMove.get(sourceFile);
    if (!originalDir) continue;
    const currentDir = path.dirname(sourceFile.getFilePath());

    for (const call of sourceFile.getDescendantsOfKind(
      SyntaxKind.CallExpression,
    )) {
      if (!MOCK_CALLEES.has(call.getExpression().getText())) continue;

      const [specifier] = call.getArguments();
      if (!specifier || !Node.isStringLiteral(specifier)) continue;

      const literal = specifier.getLiteralValue();
      if (!literal.startsWith(".")) continue;

      const { base, extension } = splitSpecifierExtension(literal);
      const target = resolveTarget(originalDir, base, movedModules);
      const rewritten = path.relative(currentDir, target);
      const normalized = rewritten.startsWith(".")
        ? rewritten
        : `./${rewritten}`;
      const next = `${normalized}${extension}`;
      if (next === literal) continue;

      specifier.setLiteralValue(next);
      remapped += 1;
    }
  }
  return remapped;
}

/**
 * Move each file with ts-morph, which rewrites every import and export declaration that names it,
 * put back the extension each rewritten specifier was written with, then remap the `vi.*` mock
 * specifiers ts-morph leaves behind. Returns how many mock specifiers changed. Nothing is saved —
 * the caller owns `project.saveSync()`.
 */
export function applyMoves(
  project: Project,
  root: string,
  moves: readonly Move[],
): number {
  const written = specifiersBeforeMove(project);
  const dirBeforeMove = new Map<SourceFile, string>();
  for (const sourceFile of project.getSourceFiles()) {
    dirBeforeMove.set(sourceFile, path.dirname(sourceFile.getFilePath()));
  }

  const movedModules = new Map<string, string>();
  for (const [from, to] of moves) {
    movedModules.set(
      stripExtension(path.join(root, from)),
      path.join(root, to),
    );
  }

  // `overwrite`: apply renames on disk first, so the destination already exists there when the
  // project, holding the file at its old path in memory, moves it.
  for (const [from, to] of moves) {
    project
      .getSourceFileOrThrow(path.join(root, from))
      .move(path.join(root, to), { overwrite: true });
  }
  restoreExtensions(project, written);

  return remapMockSpecifiers(project, dirBeforeMove, movedModules);
}
