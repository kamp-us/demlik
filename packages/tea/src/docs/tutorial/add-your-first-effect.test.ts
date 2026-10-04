/**
 * The second tutorial is followed in CI (#551).
 * `docs/tutorial/add-your-first-effect.md` continues the first lesson's
 * project, so the first lesson's page is followed into a folder once and each
 * test here follows the second page in a copy of that folder. `follow.ts` says
 * what each kind of block does and what stands in for the registry.
 */

import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTea, FENCE, follow } from "./follow";

const repo = fileURLToPath(new URL("../../..", import.meta.url));
const firstLesson = join(repo, "docs/tutorial/build-your-first-machine.md");
const page = join(repo, "docs/tutorial/add-your-first-effect.md");

const RUN = "node --experimental-strip-types effects.ts";

/** What the page must say the program prints once the first effect is in. */
const ONE_EFFECT = `start -> downloading
fetch_file_ok -> done
start -> downloading
fetch_file_err -> failed
{ phase: 'failed', reason: 'not_found' }
`;

/** What it must say the finished program prints: two effects, then the failure. */
const TWO_EFFECTS = `start -> downloading
fetch_file_ok -> downloading
save_file_ok -> done
start -> downloading
fetch_file_err -> failed
{ phase: 'failed', reason: 'not_found' }
`;

/** Every block of the page that puts code in the reader's file, in page order. */
const steps = [...(await readFile(page, "utf8")).matchAll(FENCE)]
  .filter(([, lang]) => lang === "ts" || lang === "diff")
  .map(([block], index) => ({
    block,
    name: `step ${index + 1} (${block.split("\n")[1]?.trim()})`,
  }));

describe("docs/tutorial/add-your-first-effect.md, followed after the first lesson", () => {
  let cache: string;
  let tea: string;
  let work: string;
  let finished: string;
  let markdown: string;
  let copies = 0;

  /** A fresh copy of the folder a reader has when the first lesson ends. */
  const firstLessonFolder = async (): Promise<string> => {
    const dir = join(work, `reader-${copies++}`);
    await cp(finished, dir, { recursive: true, verbatimSymlinks: true });
    return dir;
  };

  /** Follow the page; a stated output that is not what ran printed rejects. */
  const lesson = async (text: string, cwd: string): Promise<string[]> => {
    const stated = await follow(text, cwd, tea);
    for (const run of stated)
      if (run.printed !== run.pageSays)
        throw new Error(
          `\`${run.command}\` printed:\n${run.printed}\nthe page says:\n${run.pageSays}`,
        );
    return stated.filter((run) => run.command === RUN).map((r) => r.printed);
  };

  beforeAll(async () => {
    markdown = await readFile(page, "utf8");
    // Built INSIDE the repo so the bundle's and the declarations' own imports
    // resolve from the repo's `node_modules`; the reader's folder links to it.
    cache = join(
      repo,
      "node_modules/.cache/tea-first-effect",
      String(process.pid),
    );
    tea = join(cache, "tea");
    await mkdir(tea, { recursive: true });
    await buildTea(tea);

    work = await mkdtemp(join(tmpdir(), "tea-first-effect-"));
    finished = join(work, "first-lesson");
    await mkdir(finished);
    await follow(await readFile(firstLesson, "utf8"), finished, tea);
  }, 240_000);

  afterAll(async () => {
    await rm(work, { recursive: true, force: true });
    await rm(cache, { recursive: true, force: true });
  });

  it("runs two effects in order, handles the failure, and prints what the page says", async () => {
    const cwd = await firstLessonFolder();

    expect(await lesson(markdown, cwd)).toEqual([ONE_EFFECT, TWO_EFFECTS]);
    expect(await readFile(join(cwd, "copy.json"), "utf8")).toBe(
      await readFile(join(cwd, "package.json"), "utf8"),
    );
  }, 120_000);

  it("finds the steps it takes off the page one at a time", () => {
    expect(steps.length).toBeGreaterThan(0);
  });

  it.concurrent.each(
    steps,
  )("does not get there once $name is taken off the page", async ({
    block,
  }) => {
    expect(markdown).toContain(block);

    await expect(
      lesson(markdown.replace(block, ""), await firstLessonFolder()),
    ).rejects.toThrow();
  }, 120_000);
});
