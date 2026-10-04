/**
 * Pages whose code is typechecked from the page text (#542).
 *
 * An explanation page and the README show code no example file holds, so the
 * mirror gate (`page-mirrors.ts`) has nothing to compare them with, and a
 * snippet there can name an argument the library never passes. Each page
 * listed here is read as one program, the way a reader pastes it: its ```ts
 * blocks in page order, as one module, importing tea only through the
 * `@demlik/tea` specifiers. Any diagnostic fails the page. Nothing runs it.
 *
 * `docs/how-to/make-durable.md` is under the mirror gate as well. It is here
 * because the mirror gate cannot see a name the page uses and never defines.
 *
 * The options are the test program's with one loosened: a page shows what a
 * call returns by binding it, so `noUnusedLocals` is off.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cacheDir, PKG_ROOT, programDiagnostics } from "./in-memory-program";
import { programOf } from "./tutorial/program";

/** Package-relative. */
const PAGES = [
  "README.md",
  "docs/explanation/cmd-or-sub.md",
  "docs/explanation/errors-as-data.md",
  "docs/how-to/make-durable.md",
];

/** The compiler's diagnostics for `markdown` read as one program. */
function diagnosticsOf(page: string, markdown: string): string[] {
  return programDiagnostics(
    join(cacheDir("tea-pages-typecheck"), page),
    programOf(markdown),
    { noUnusedLocals: false },
  );
}

describe("pages typecheck from their own text", () => {
  it.each(PAGES)("%s compiles without a diagnostic", async (page) => {
    const markdown = await readFile(join(PKG_ROOT, page), "utf8");
    expect(programOf(markdown).size).toBeGreaterThan(0);
    expect(diagnosticsOf(page, markdown)).toEqual([]);
  }, 120_000);

  it("fails a handler that takes `ok` from a third argument the engine never passes", async () => {
    const page = "docs/explanation/cmd-or-sub.md";
    const markdown = await readFile(join(PKG_ROOT, page), "utf8");
    const current = "async (cmd, { ok })";
    expect(markdown).toContain(current);

    const diagnostics = diagnosticsOf(
      page,
      markdown.replace(current, "async (cmd, _ctx, { ok })"),
    );

    expect(diagnostics.join("\n")).toContain("Property 'ok' does not exist");
  });
});
