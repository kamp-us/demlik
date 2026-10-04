/**
 * The first tutorial is followed in CI (#545).
 * `docs/tutorial/build-your-first-machine.md` is read and every fenced block is
 * acted on in page order, in an empty directory, the way the reader is told to.
 * `follow.ts` says what each kind of block does and what stands in for the
 * registry.
 */

import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTea, follow } from "./follow";
import { UNNAMED_PAGE_FILE } from "./program";

const repo = fileURLToPath(new URL("../../..", import.meta.url));
const page = join(repo, "docs/tutorial/build-your-first-machine.md");

describe(
  "docs/tutorial/build-your-first-machine.md, followed from an empty folder",
  { timeout: 120_000 },
  () => {
    let cache: string;
    let tea: string;
    let markdown: string;
    const folders: string[] = [];

    const emptyFolder = async (): Promise<string> => {
      const dir = await mkdtemp(join(tmpdir(), "tea-first-machine-"));
      folders.push(dir);
      return dir;
    };

    beforeAll(async () => {
      markdown = await readFile(page, "utf8");
      // Built INSIDE the repo so the bundle's and the declarations' own imports
      // resolve from the repo's `node_modules`; the reader's folder links to it.
      cache = join(
        repo,
        "node_modules/.cache/tea-first-machine",
        String(process.pid),
      );
      tea = join(cache, "tea");
      await mkdir(tea, { recursive: true });
      await buildTea(tea);
    }, 120_000);

    afterAll(async () => {
      for (const dir of folders)
        await rm(dir, { recursive: true, force: true });
      await rm(cache, { recursive: true, force: true });
    });

    it("typechecks, runs, and prints what the page says it prints", async () => {
      const stated = await follow(markdown, await emptyFolder(), tea);

      expect(stated.map((run) => run.command)).toContain(
        `node --experimental-strip-types ${UNNAMED_PAGE_FILE}`,
      );
      for (const run of stated) expect(run.printed).toBe(run.pageSays);
    });

    it("does not run once the setup step is taken off the page", async () => {
      const start = markdown.indexOf("## Set up the project");
      const end = markdown.indexOf("```ts", start);
      expect(start).toBeGreaterThan(-1);
      const withoutSetup = markdown.slice(0, start) + markdown.slice(end);

      await expect(
        follow(withoutSetup, await emptyFolder(), tea),
      ).rejects.toThrow(/failed/);
    });
  },
);
