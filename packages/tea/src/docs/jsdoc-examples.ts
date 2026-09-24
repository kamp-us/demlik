/**
 * The JSDoc example gate (#361): every `@example` tag in tea's source holds a
 * fenced ```ts block that typechecks against the published entry points.
 *
 * An example lives in the source so an editor hover shows it, and nothing else
 * compiles it, so it rots unseen. This is the model of Effect's
 * `@effect/docgen`, Rust's doctests and `deno test --doc`: the block is lifted
 * out of the comment and handed to the TypeScript compiler as a module of its
 * own, importing tea only through `@demlik/tea` specifiers the export map
 * carries. Nothing runs it.
 */

import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import ts from "typescript";
import { cacheDir, inMemoryProgram, PKG_ROOT } from "./in-memory-program";
import { blocksOf } from "./page-mirrors";

/**
 * One `@example` tag's reading. `at` is the package-relative source file and
 * `tag` the line the tag sits on. A tag with no ```ts fence is its own case,
 * because it holds nothing the compiler can check, and passing it would let an
 * example leave the gate by losing its fence.
 */
export type Example =
  | {
      readonly kind: "fenced";
      readonly at: string;
      readonly tag: number;
      readonly body: string;
      /** The source line the block's first line of code sits on. */
      readonly line: number;
    }
  | { readonly kind: "unfenced"; readonly at: string; readonly tag: number };

/** A JSDoc comment. */
const JSDOC = /\/\*\*[\s\S]*?\*\//g;
/** The gutter a JSDoc line opens with, up to one space after the star. */
const GUTTER = /^\s*\* ?/;
/** A line that opens a block tag. */
const TAG = /^@[A-Za-z]/;

/** A comment's lines with the delimiters and gutter removed, one per source line. */
function commentLines(comment: string): string[] {
  return comment
    .replace(/^\/\*\* ?/, "")
    .replace(/\*\/$/, "")
    .split("\n")
    .map((line) => line.replace(GUTTER, ""));
}

/**
 * Pure core: every `@example` tag in one source file. A tag runs from its own
 * line to the next block tag outside a fence, or to the end of the comment.
 */
export function examplesOf(at: string, source: string): Example[] {
  const found: Example[] = [];
  for (const m of source.matchAll(JSDOC)) {
    const first = source.slice(0, m.index).split("\n").length;
    const lines = commentLines(m[0]);
    lines.forEach((line, i) => {
      if (!/^@example\b/.test(line)) return;
      const tagLines = [line];
      let fenced = false;
      for (const next of lines.slice(i + 1)) {
        if (!fenced && TAG.test(next)) break;
        if (next.startsWith("```")) fenced = !fenced;
        tagLines.push(next);
      }
      const tag = first + i;
      const blocks = blocksOf(tagLines.join("\n"));
      if (blocks.length === 0) found.push({ kind: "unfenced", at, tag });
      for (const block of blocks)
        found.push({
          kind: "fenced",
          at,
          tag,
          body: block.body,
          line: tag + block.line - 1,
        });
    });
  }
  return found;
}

/** Every non-test `.ts` / `.tsx` file under `src/`, package-relative, in stable order. */
export async function sourceFiles(): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name))
        found.push(relative(PKG_ROOT, path));
    }
  };
  await walk(join(PKG_ROOT, "src"));
  return found.sort();
}

/** Every `@example` tag in tea's non-test source. */
export async function sourceExamples(): Promise<Example[]> {
  const files = await sourceFiles();
  const read = await Promise.all(
    files.map(async (at) =>
      examplesOf(at, await readFile(join(PKG_ROOT, at), "utf8")),
    ),
  );
  return read.flat();
}

type ExportEntry = string | { readonly import?: string };

/**
 * `paths` that resolve exactly the specifiers `package.json` exports, each to
 * its `src/` module. A specifier the export map does not carry resolves to
 * nothing, so an example cannot reach past the public surface. The target is
 * extensionless, so tsc finds a `.tsx` module as readily as a `.ts` one.
 */
export async function publishedPaths(): Promise<Record<string, string[]>> {
  const pkg = JSON.parse(
    await readFile(join(PKG_ROOT, "package.json"), "utf8"),
  ) as { readonly exports: Readonly<Record<string, ExportEntry>> };
  const paths: Record<string, string[]> = {};
  for (const [subpath, entry] of Object.entries(pkg.exports)) {
    const dist = typeof entry === "string" ? entry : entry.import;
    if (dist?.startsWith("./dist/") !== true || !dist.endsWith(".js")) continue;
    const stem = dist.slice("./dist/".length, -".js".length);
    paths[`@demlik/tea${subpath.slice(1)}`] = [join(PKG_ROOT, "src", stem)];
  }
  return paths;
}

/**
 * Why each example fails, one line per diagnostic, as `<file>:<line>` in the
 * source plus the tag's own line. Empty when every example typechecks.
 *
 * Each block compiles as a module of its own, under the test program's
 * options with two loosened: an unused binding is how an example shows what a
 * call returns, so `noUnusedLocals` and `noUnusedParameters` are off.
 */
export async function exampleFailures(
  examples: readonly Example[],
): Promise<string[]> {
  const failures: string[] = [];
  const dir = cacheDir("tea-jsdoc-examples");
  const files = new Map<
    string,
    Extract<Example, { readonly kind: "fenced" }>
  >();
  for (const example of examples) {
    if (example.kind === "unfenced")
      failures.push(
        `${example.at}:${example.tag}: this @example holds no \`\`\`ts block, so nothing typechecks it. Fence its code in \`\`\`ts.`,
      );
    else
      files.set(
        join(dir, `${example.at.replaceAll("/", "__")}.${example.line}.ts`),
        example,
      );
  }
  if (files.size === 0) return failures;
  const program = inMemoryProgram(
    dir,
    new Map([...files].map(([path, example]) => [path, example.body])),
    {
      paths: await publishedPaths(),
      noUnusedLocals: false,
      noUnusedParameters: false,
      moduleDetection: ts.ModuleDetectionKind.Force,
    },
  );
  const message = (d: ts.Diagnostic) =>
    ts.flattenDiagnosticMessageText(d.messageText, " ");
  for (const d of [
    ...program.getOptionsDiagnostics(),
    ...program.getGlobalDiagnostics(),
  ])
    failures.push(message(d));
  for (const [path, example] of files) {
    const file = program.getSourceFile(path);
    if (file === undefined) throw new Error(`${path} left the program`);
    for (const d of [
      ...program.getSyntacticDiagnostics(file),
      ...program.getSemanticDiagnostics(file),
    ]) {
      const offset =
        d.start === undefined
          ? 0
          : file.getLineAndCharacterOfPosition(d.start).line;
      failures.push(
        `${example.at}:${example.line + offset}: ${message(d)} (the @example at line ${example.tag})`,
      );
    }
  }
  return failures;
}
