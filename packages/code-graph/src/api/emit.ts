import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { tsgoBinary } from "../engine/tsgo.js";
import { ApiInputError, type ApiSubpath } from "./map.js";

// A declaration emit of one package into a temp folder outside the checkout (SPEC §13.3). The
// emit's root is the package root, so an entry's emitted file follows from the emit's own rule:
// `src/a/index.ts` → `<out>/src/a/index.d.ts`.
export type DeclarationEmit = {
  readonly temp: string;
  readonly out: string;
  readonly compiler: string;
  readonly diagnostics: number;
};

const EMITTED_EXTENSION: ReadonlyArray<readonly [RegExp, string]> = [
  [/\.mts$/, ".d.mts"],
  [/\.cts$/, ".d.cts"],
  [/\.tsx?$/, ".d.ts"],
];

// The emit as the read sees it: every source file that emitted keeps its path and reads as its
// declarations. A specifier in the emitted text therefore resolves from where the compile resolved
// it, through the same `node_modules` walk, `package.json`, `paths` and ambient modules, and nothing
// has to be linked or copied (SPEC §13.3).
export class EmittedTree {
  constructor(
    private readonly emit: DeclarationEmit,
    private readonly rootAbsolute: string,
  ) {}

  // Where `sourceFile` emitted to, relative to the emit's `out`; undefined when it emitted nothing,
  // as a dependency, a `.d.ts` or a file outside the package does not.
  declarationOf(sourceFile: string): string | undefined {
    const relative = path.relative(this.rootAbsolute, sourceFile);
    if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined;
    const emitted = EMITTED_EXTENSION.find(([source]) => source.test(relative));
    if (emitted === undefined) return undefined;
    const declaration = relative.replace(emitted[0], emitted[1]);
    return fs.existsSync(path.join(this.emit.out, declaration)) ? declaration : undefined;
  }

  readonly textOf = (sourceFile: string): string | undefined => {
    const declaration = this.declarationOf(sourceFile);
    if (declaration === undefined) return undefined;
    return fs.readFileSync(path.join(this.emit.out, declaration), "utf8");
  };
}

function diagnosticCount(output: string, status: number | null): number {
  const found = /Found (\d+) errors?/.exec(output);
  if (found !== null) return Number(found[1]);
  return status === 0 ? 0 : 1;
}

export function removeEmit(emit: { readonly temp: string }): void {
  fs.rmSync(emit.temp, { recursive: true, force: true });
}

// Runs the pinned tsgo with declaration-only emit. A type error does not stop the emit; it is
// counted in `diagnostics`. The caller removes the temp folder with `removeEmit`.
export async function emitDeclarations(
  rootAbsolute: string,
  tsConfigPath: string,
): Promise<DeclarationEmit> {
  const tsgo = await tsgoBinary();
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "code-graph-api-")));
  const out = path.join(temp, "out");
  // A tsconfig's `declarationDir` beats `--outDir`, so both are named or the emit lands in the package.
  const args = [
    ...["-p", tsConfigPath, "--noEmit", "false", "--declaration", "--emitDeclarationOnly"],
    ...["--declarationMap", "false", "--noEmitOnError", "false", "--incremental", "false"],
    ...["--composite", "false", "--rootDir", rootAbsolute, "--outDir", out],
    ...["--declarationDir", out],
  ];
  const run = spawnSync(tsgo.path, args, { cwd: rootAbsolute, encoding: "utf8" });
  if (run.error !== undefined) {
    removeEmit({ temp });
    throw new ApiInputError(`tsgo failed to start: ${run.error.message}`);
  }
  const diagnostics = diagnosticCount(`${run.stdout}${run.stderr}`, run.status);
  return { temp, out, compiler: tsgo.version, diagnostics };
}

// Each subpath's entry file, once the emit is known to hold its declarations.
export function emittedEntries(
  tree: EmittedTree,
  subpaths: readonly ApiSubpath[],
): ReadonlyMap<string, string> {
  const files = new Map<string, string>();
  for (const { subpath, entry, entryAbsolute } of subpaths) {
    if (tree.declarationOf(entryAbsolute) === undefined) {
      throw new ApiInputError(
        `${subpath}: entry ${entry} has no emitted declaration file (does the tsconfig include it?)`,
      );
    }
    files.set(subpath, entryAbsolute);
  }
  return files;
}
