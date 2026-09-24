/**
 * Every tutorial page's program typechecks (#356).
 *
 * The tutorials tell the reader to run `tsc --noEmit` after every edit, and the
 * page's code is what they type. `build-a-durable-agent.test.ts` runs its page
 * through a bundler, which strips types without checking them, and
 * `build-your-first-machine.md` had no gate at all — so a page could ship code
 * that fails the reader's first `tsc`. Here each page under `docs/tutorial/` is
 * reassembled into the files it names and handed to the TypeScript compiler,
 * and any diagnostic fails the page.
 *
 * The files are served from memory at a path inside the package, so their bare
 * imports (`zod`, `@anthropic-ai/sdk`) resolve from its `node_modules`. The
 * options are the test program's (`tsconfig.test.json`), whose `paths` point
 * `@demlik/tea/*` at `src/`, plus the page's own `allowImportingTsExtensions`
 * so `./model.ts` resolves under its real name.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { cacheDir, inMemoryProgram } from "../in-memory-program";
import { programOf, UNNAMED_PAGE_FILE } from "./program";

const repo = fileURLToPath(new URL("../../..", import.meta.url));
const tutorials = join(repo, "docs/tutorial");

/** Every tutorial page that carries TypeScript, with the program it reassembles to. */
async function pages(): Promise<[string, Map<string, string>][]> {
  const names = (await readdir(tutorials)).filter((n) => n.endsWith(".md"));
  const programs = await Promise.all(
    names
      .sort()
      .map(
        async (name): Promise<[string, Map<string, string>]> => [
          name,
          programOf(await readFile(join(tutorials, name), "utf8")),
        ],
      ),
  );
  return programs.filter(([, program]) => program.size > 0);
}

/** The compiler's diagnostics for one page's program, one formatted line each. */
function diagnosticsOf(page: string, program: Map<string, string>): string[] {
  const dir = join(cacheDir("tea-tutorial-typecheck"), page);
  const files = new Map(
    [...program].map(([name, body]) => [join(dir, name), body]),
  );
  const compiled = inMemoryProgram(dir, files, {
    allowImportingTsExtensions: true,
  });
  return ts.getPreEmitDiagnostics(compiled).map((d) => {
    const text = ts.flattenDiagnosticMessageText(d.messageText, "\n");
    if (d.file === undefined || d.start === undefined) return text;
    const { line } = d.file.getLineAndCharacterOfPosition(d.start);
    return `${d.file.fileName.replace(`${dir}/`, "")}:${line + 1} ${text}`;
  });
}

describe("docs/tutorial/*.md programs typecheck", async () => {
  const programs = await pages();

  it("reads both tutorials, including the page that names no file", () => {
    const byPage = new Map(programs);
    expect(byPage.get("build-a-durable-agent.md")?.has("model.ts")).toBe(true);
    expect(
      byPage.get("build-your-first-machine.md")?.has(UNNAMED_PAGE_FILE),
    ).toBe(true);
  });

  it.each(programs)(
    "%s compiles without a diagnostic",
    (page, program) => {
      expect(diagnosticsOf(page, program)).toEqual([]);
    },
    120_000,
  );
});
