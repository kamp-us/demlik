/**
 * Compile TypeScript that exists only in memory: a tutorial page's program
 * (#356) or a JSDoc example (#361). The text is served at paths under `dir`,
 * which sits inside the package so bare imports (`zod`, `fast-check`) resolve
 * from its `node_modules`. The options are the test program's
 * (`tsconfig.test.json`) with the caller's overrides on top.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/** packages/tea — this file lives at src/docs/, two levels down. */
export const PKG_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

/** Where a caller serves its in-memory files from, under the package's `node_modules`. */
export const cacheDir = (name: string): string =>
  join(PKG_ROOT, "node_modules/.cache", name);

/** The program that compiles `files` (absolute path → text, every path under `dir`). */
export function inMemoryProgram(
  dir: string,
  files: ReadonlyMap<string, string>,
  overrides: ts.CompilerOptions = {},
): ts.Program {
  const config = ts.getParsedCommandLineOfConfigFile(
    join(PKG_ROOT, "tsconfig.test.json"),
    overrides,
    { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} },
  );
  if (config === undefined) throw new Error("tsconfig.test.json is unreadable");
  const host = ts.createCompilerHost(config.options);
  const { fileExists, readFile, getSourceFile } = host;
  const directoryExists = host.directoryExists?.bind(host);
  host.fileExists = (path) => files.has(path) || fileExists(path);
  host.directoryExists = (path) =>
    path === dir || (directoryExists?.(path) ?? true);
  host.readFile = (path) => files.get(path) ?? readFile(path);
  host.getSourceFile = (path, language, ...rest) => {
    const body = files.get(path);
    return body === undefined
      ? getSourceFile(path, language, ...rest)
      : ts.createSourceFile(path, body, language);
  };
  return ts.createProgram([...files.keys()], config.options, host);
}

/**
 * The compiler's diagnostics for a program served from `dir` (file name →
 * text), one formatted line each: `<file>:<line> <message>`.
 */
export function programDiagnostics(
  dir: string,
  program: ReadonlyMap<string, string>,
  overrides: ts.CompilerOptions = {},
): string[] {
  const files = new Map(
    [...program].map(([name, body]) => [join(dir, name), body]),
  );
  const compiled = inMemoryProgram(dir, files, overrides);
  return ts.getPreEmitDiagnostics(compiled).map((d) => {
    const text = ts.flattenDiagnosticMessageText(d.messageText, "\n");
    if (d.file === undefined || d.start === undefined) return text;
    const { line } = d.file.getLineAndCharacterOfPosition(d.start);
    return `${d.file.fileName.replace(`${dir}/`, "")}:${line + 1} ${text}`;
  });
}
