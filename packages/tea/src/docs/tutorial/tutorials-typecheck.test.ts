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
import { describe, expect, it } from "vitest";
import { cacheDir, programDiagnostics } from "../in-memory-program";
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
const diagnosticsOf = (page: string, program: Map<string, string>): string[] =>
  programDiagnostics(join(cacheDir("tea-tutorial-typecheck"), page), program, {
    allowImportingTsExtensions: true,
  });

describe(
  "docs/tutorial/*.md programs typecheck",
  { timeout: 120_000 },
  async () => {
    const programs = await pages();

    it("reads every tutorial, including the page that names no file", () => {
      const byPage = new Map(programs);
      expect(byPage.get("add-your-first-effect.md")?.has("effects.ts")).toBe(
        true,
      );
      expect(byPage.get("build-a-durable-agent.md")?.has("model.ts")).toBe(
        true,
      );
      expect(
        byPage.get("build-your-first-machine.md")?.has(UNNAMED_PAGE_FILE),
      ).toBe(true);
    });

    it.each(programs)("%s compiles without a diagnostic", (page, program) => {
      expect(diagnosticsOf(page, program)).toEqual([]);
    });

    // #543: `tool()` calls a handler with `(args, ctx, { ok, fail })`. The call's
    // id and an abort signal are not among them, so the lesson must not show a
    // handler that takes either.
    it.each([
      { takes: "`callId` as a fourth argument", edit: ", callId: string) =>" },
      {
        takes: "an `AbortSignal` as a fourth argument",
        edit: ", signal: AbortSignal) =>",
      },
    ])("fails build-a-durable-agent.md's tool handler edited to take $takes", ({
      edit,
    }) => {
      const page = "build-a-durable-agent.md";
      const program = new Map(programs).get(page) ?? new Map<string, string>();
      const agent = program.get("agent.ts") ?? "";
      const handler = "async ({ text }, _ctx, { ok }) =>";
      expect(agent).toContain(handler);

      const diagnostics = diagnosticsOf(
        page,
        new Map([
          ...program,
          ["agent.ts", agent.replace(handler, handler.replace(") =>", edit))],
        ]),
      );

      expect(diagnostics.join("\n")).toContain(
        "is not assignable to parameter of type 'ToolHandler<",
      );
    });
  },
);
