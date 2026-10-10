import fs from "node:fs";
import path from "node:path";
import * as ts from "../engine/tsgo.js";
import { findRepoRoot, resolveEdgeTsConfig } from "../extract/project.js";
import { emitDeclarations, emittedEntries, removeEmit } from "./emit.js";
import { ApiInputError, type ApiSubpath, apiSubpaths } from "./map.js";
import { readSubpathNames, type SubpathNames } from "./read.js";

export type PublishedApi = {
  readonly root: string;
  readonly compiler: string;
  readonly subpaths: Readonly<
    Record<
      string,
      { readonly entry: string; readonly tier: string | null; readonly names: SubpathNames }
    >
  >;
};

export type PublishedApiOptions = {
  readonly repoRoot?: string;
  // Where the emit's diagnostic count goes as one warning line; stderr by default.
  readonly warn?: (line: string) => void;
};

function packageRoot(root: string): string {
  const absolute = path.resolve(root);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isDirectory()) {
    throw new ApiInputError(`${absolute} is not a directory`);
  }
  return fs.realpathSync(absolute);
}

function packageTsConfig(rootAbsolute: string, repoRoot: string): string {
  try {
    return resolveEdgeTsConfig(rootAbsolute, "package", repoRoot);
  } catch (error) {
    throw new ApiInputError(error instanceof Error ? error.message : String(error));
  }
}

function readNames(
  tsConfigPath: string,
  out: string,
  entries: ReadonlyMap<string, string>,
): ReadonlyMap<string, SubpathNames> {
  const program = ts.openTypeProgram({
    tsConfigPath,
    rootFiles: [...new Set(entries.values())].sort(),
    includeConfigFiles: false,
  });
  try {
    return new Map(
      [...entries].map(([subpath, file]) => [subpath, readSubpathNames(program, out, file)]),
    );
  } finally {
    program.close();
  }
}

function assemble(
  rootAbsolute: string,
  compiler: string,
  subpaths: readonly ApiSubpath[],
  names: ReadonlyMap<string, SubpathNames>,
): PublishedApi {
  const view: Record<string, PublishedApi["subpaths"][string]> = {};
  for (const { subpath, entry, tier } of subpaths) {
    view[subpath] = { entry, tier, names: names.get(subpath) ?? {} };
  }
  return { root: path.relative(process.cwd(), rootAbsolute) || ".", compiler, subpaths: view };
}

// The published-API view of the package at `root` (SPEC §13.3): every name each subpath of `map`
// publishes, with its declaration text as emitted. The emit lives in a temp folder outside the
// checkout and is removed before this returns or throws.
export async function readPublishedApi(
  root: string,
  map: unknown,
  options: PublishedApiOptions = {},
): Promise<PublishedApi> {
  const rootAbsolute = packageRoot(root);
  const subpaths = apiSubpaths(rootAbsolute, map);
  const tsConfigPath = packageTsConfig(
    rootAbsolute,
    options.repoRoot ?? findRepoRoot(rootAbsolute),
  );
  const emit = await emitDeclarations(rootAbsolute, tsConfigPath);
  try {
    if (emit.diagnostics > 0) {
      const warn = options.warn ?? ((line: string) => process.stderr.write(`${line}\n`));
      warn(
        `code-graph: warning: tsgo reported ${emit.diagnostics} diagnostic(s); the declarations were emitted anyway`,
      );
    }
    const entries = emittedEntries(emit, rootAbsolute, subpaths);
    return assemble(
      rootAbsolute,
      emit.compiler,
      subpaths,
      readNames(tsConfigPath, emit.out, entries),
    );
  } finally {
    removeEmit(emit);
  }
}
