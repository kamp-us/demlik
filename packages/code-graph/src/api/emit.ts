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

export function emittedFileOf(emit: DeclarationEmit, rootAbsolute: string, entry: string): string {
  const relative = path.relative(rootAbsolute, entry);
  for (const [source, declaration] of EMITTED_EXTENSION) {
    if (source.test(relative)) return path.join(emit.out, relative.replace(source, declaration));
  }
  return path.join(emit.out, relative);
}

function diagnosticCount(output: string, status: number | null): number {
  const found = /Found (\d+) errors?/.exec(output);
  if (found !== null) return Number(found[1]);
  return status === 0 ? 0 : 1;
}

// The package's installed dependencies, seen from the temp folder, so the emitted files' bare
// specifiers resolve as the source's did. The link lives in the temp folder, never the checkout.
function linkDependencies(temp: string, rootAbsolute: string): void {
  const installed = path.join(rootAbsolute, "node_modules");
  if (fs.existsSync(installed)) fs.symlinkSync(installed, path.join(temp, "node_modules"), "dir");
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
  const args = [
    ...["-p", tsConfigPath, "--noEmit", "false", "--declaration", "--emitDeclarationOnly"],
    ...["--declarationMap", "false", "--noEmitOnError", "false", "--incremental", "false"],
    ...["--composite", "false", "--rootDir", rootAbsolute, "--outDir", out],
  ];
  const run = spawnSync(tsgo.path, args, { cwd: rootAbsolute, encoding: "utf8" });
  if (run.error !== undefined) {
    removeEmit({ temp });
    throw new ApiInputError(`tsgo failed to start: ${run.error.message}`);
  }
  linkDependencies(temp, rootAbsolute);
  const diagnostics = diagnosticCount(`${run.stdout}${run.stderr}`, run.status);
  return { temp, out, compiler: tsgo.version, diagnostics };
}

export function emittedEntries(
  emit: DeclarationEmit,
  rootAbsolute: string,
  subpaths: readonly ApiSubpath[],
): ReadonlyMap<string, string> {
  const files = new Map<string, string>();
  for (const { subpath, entry, entryAbsolute } of subpaths) {
    const emitted = emittedFileOf(emit, rootAbsolute, entryAbsolute);
    if (!fs.existsSync(emitted)) {
      throw new ApiInputError(
        `${subpath}: entry ${entry} has no emitted declaration file (does the tsconfig include it?)`,
      );
    }
    files.set(subpath, emitted);
  }
  return files;
}
