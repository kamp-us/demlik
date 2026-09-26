import path from "node:path";
import { Node, type Project, type SourceFile, SyntaxKind } from "ts-morph";

/** One file move, both ends relative to the root the moves are applied under. */
export type Move = readonly [from: string, to: string];

const SPECIFIER_EXTENSION = /\.(?:[cm]?[jt]sx?)$/;

export const stripExtension = (filePath: string) =>
  filePath.replace(/\.tsx?$/, "");

export function splitSpecifierExtension(specifier: string): {
  readonly base: string;
  readonly extension: string;
} {
  const extension = SPECIFIER_EXTENSION.exec(specifier)?.[0] ?? "";
  return {
    base: specifier.slice(0, specifier.length - extension.length),
    extension,
  };
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
 * then remap the `vi.*` mock specifiers ts-morph leaves behind. Returns how many mock specifiers
 * changed. Nothing is saved — the caller owns `project.saveSync()`.
 */
export function applyMoves(
  project: Project,
  root: string,
  moves: readonly Move[],
): number {
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

  return remapMockSpecifiers(project, dirBeforeMove, movedModules);
}
