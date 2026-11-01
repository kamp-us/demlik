import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { SourceFile } from "ts-morph";
import type { PathMove } from "./manifest.js";
import { moduleLiterals, splitSpecifierExtension } from "./specifier.js";

const RESOLVABLE = ["", ".ts", ".tsx", ".d.ts", "/index.ts", "/index.tsx"];

export type MovedModules = ReadonlyMap<string, string>;

/** Whether a file exists in the tree a specifier is healed against; the disk unless told otherwise. */
export type Exists = (path: string) => boolean;

export function movedModules(
  repoRoot: string,
  rows: readonly PathMove[],
): MovedModules {
  return new Map(
    rows.map((r) => [
      join(repoRoot, r.from).replace(/\.tsx?$/, ""),
      join(repoRoot, r.to).replace(/\.tsx?$/, ""),
    ]),
  );
}

export function healedSpecifier(
  fromFile: string,
  literal: string,
  moved: MovedModules,
  exists: Exists = existsSync,
): string | undefined {
  if (!literal.startsWith(".")) return undefined;
  const { base: bare, extension } = splitSpecifierExtension(literal);
  const dir = dirname(fromFile);
  const base = resolve(dir, bare);
  if (RESOLVABLE.some((suffix) => exists(`${base}${suffix}`))) return undefined;
  const target = moved.get(base);
  if (target === undefined) return undefined;
  const rel = relative(dir, target);
  return `${rel.startsWith(".") ? rel : `./${rel}`}${extension}`;
}

const QUOTED_RELATIVE = /["'](\.\.?\/[^"'\n]+)["']/g;

export function hasDangling(
  files: readonly string[],
  moved: MovedModules,
): boolean {
  return files.some((file) =>
    [...readFileSync(file, "utf8").matchAll(QUOTED_RELATIVE)].some(
      ([, literal]) =>
        literal !== undefined &&
        healedSpecifier(file, literal, moved) !== undefined,
    ),
  );
}

export function heal(
  sourceFiles: readonly SourceFile[],
  moved: MovedModules,
  exists: Exists = existsSync,
): number {
  let healed = 0;
  for (const sourceFile of sourceFiles) {
    for (const literal of moduleLiterals(sourceFile)) {
      const next = healedSpecifier(
        sourceFile.getFilePath(),
        literal.getLiteralValue(),
        moved,
        exists,
      );
      if (next === undefined) continue;
      literal.setLiteralValue(next);
      healed += 1;
    }
  }
  return healed;
}
