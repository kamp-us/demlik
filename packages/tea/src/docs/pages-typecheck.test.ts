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
 * Four how-to pages are under the mirror gate as well. They are here because
 * the mirror gate compares a block with a region of a source file, and that
 * file can define a name outside the region: the block then matches and still
 * does not compile when pasted.
 *
 * The options are the test program's with one loosened: a page shows what a
 * call returns by binding it, so `noUnusedLocals` is off.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cacheDir, PKG_ROOT, programDiagnostics } from "./in-memory-program";
import { programOf } from "./tutorial/program";

interface Page {
  /** Package-relative. */
  readonly path: string;
  /** The module the page's blocks make. A page showing JSX names a `.tsx` one. */
  readonly file?: string;
  /**
   * `## ` sections left out of the program, by heading. Their blocks are not
   * module-level code a reader pastes after the ones above: a fragment of a
   * component body, or a recipe of its own that brings its own names.
   */
  readonly skip?: readonly string[];
}

const PAGES: readonly Page[] = [
  { path: "README.md" },
  { path: "docs/explanation/cmd-or-sub.md" },
  { path: "docs/explanation/errors-as-data.md" },
  {
    path: "docs/how-to/add-resilience.md",
    // An agent's policy: `model` and `search` are the reader's own.
    skip: ["## 6. Retry a `defineAgent`'s brain call"],
  },
  {
    path: "docs/how-to/drive-from-react.md",
    file: "main.tsx",
    // Each shows the lines inside a component, for a machine the reader has.
    skip: [
      "## 2. Hand it the handlers, and a `ctx` when they need one",
      "## 3. Persist across mounts with a `store`",
    ],
  },
  {
    path: "docs/how-to/handle-a-tool-failure.md",
    skip: [
      // The agent's `model` is the reader's own.
      "## Branch on the failure in your own code",
      // One arm of the tutorial adapter's `switch`.
      "## Render it for your provider",
    ],
  },
  { path: "docs/how-to/make-durable.md" },
];

const pageOf = (path: string): Page => {
  const page = PAGES.find((p) => p.path === path);
  if (page === undefined) throw new Error(`${path} is not a listed page`);
  return page;
};

/** `markdown` without the named `## ` sections, each from its heading to the next. */
function withoutSections(
  markdown: string,
  headings: readonly string[],
): string {
  const sections = markdown.split(/^(?=## )/m);
  const missing = headings.filter(
    (heading) => !sections.some((s) => s.startsWith(`${heading}\n`)),
  );
  if (missing.length > 0)
    throw new Error(`no section is headed ${missing.join(" or ")}`);
  return sections
    .filter((s) => !headings.some((heading) => s.startsWith(`${heading}\n`)))
    .join("");
}

/** The program a reader pastes from `markdown`: file name → text. */
const pastedFrom = (page: Page, markdown: string): Map<string, string> =>
  programOf(withoutSections(markdown, page.skip ?? []), page.file);

/** The compiler's diagnostics for `markdown` read as the page's program. */
const diagnosticsOf = (page: Page, markdown: string): string[] =>
  programDiagnostics(
    join(cacheDir("tea-pages-typecheck"), page.path),
    pastedFrom(page, markdown),
    { noUnusedLocals: false },
  );

const read = (page: Page) => readFile(join(PKG_ROOT, page.path), "utf8");

describe("pages typecheck from their own text", () => {
  it.each(PAGES.map((page) => [page.path, page] as const))(
    "%s compiles without a diagnostic",
    async (_path, page) => {
      const markdown = await read(page);
      expect(pastedFrom(page, markdown).size).toBeGreaterThan(0);
      expect(diagnosticsOf(page, markdown)).toEqual([]);
    },
    120_000,
  );

  it("fails a handler that takes `ok` from a third argument the engine never passes", async () => {
    const page = pageOf("docs/explanation/cmd-or-sub.md");
    const markdown = await read(page);
    const current = "async (cmd, { ok })";
    expect(markdown).toContain(current);

    const diagnostics = diagnosticsOf(
      page,
      markdown.replace(current, "async (cmd, _ctx, { ok })"),
    );

    expect(diagnostics.join("\n")).toContain("Property 'ok' does not exist");
  });

  // #543: `tool()` calls a handler with `(args, ctx, { ok, fail })`. The call's
  // id and an abort signal are not among them, so a page must not show a
  // handler that takes either.
  it.each([
    { takes: "`callId` as a fourth argument", edit: ", callId: string) =>" },
    {
      takes: "an `AbortSignal` as a fourth argument",
      edit: ", signal: AbortSignal) =>",
    },
  ])("fails every tool handler on handle-a-tool-failure.md edited to take $takes", async ({
    edit,
  }) => {
    const page = pageOf("docs/how-to/handle-a-tool-failure.md");
    const markdown = await read(page);
    const handlers = [
      "async ({ key }, _ctx, { ok, fail }) =>",
      "async ({ pair }, _ctx, { ok, fail }) =>",
    ];
    for (const handler of handlers) expect(markdown).toContain(handler);

    const edited = handlers.reduce(
      (text, handler) => text.replace(handler, handler.replace(") =>", edit)),
      markdown,
    );

    const refused = diagnosticsOf(page, edited).filter((d) =>
      d.includes("is not assignable to parameter of type 'ToolHandler<"),
    );
    expect(refused).toHaveLength(handlers.length);
  }, 120_000);

  it.each([
    {
      path: "docs/how-to/add-resilience.md",
      defines: "const resilientFetch = defineMachine(",
      renamed: "const fetcher = defineMachine(",
      name: "resilientFetch",
    },
    {
      path: "docs/how-to/drive-from-react.md",
      defines: "export const downloader = defineMachine(",
      renamed: "export const download = defineMachine(",
      name: "downloader",
    },
  ])("fails $path when a block uses `$name` and the page no longer defines it", async ({
    path,
    defines,
    renamed,
    name,
  }) => {
    const page = pageOf(path);
    const markdown = await read(page);
    expect(markdown).toContain(defines);

    const diagnostics = diagnosticsOf(page, markdown.replace(defines, renamed));

    expect(diagnostics.join("\n")).toContain(`Cannot find name '${name}'`);
  }, 120_000);
});
