/**
 * A tutorial page's program, reassembled from its ```ts blocks.
 *
 * A page names each file on the first line of the block that starts it
 * (`// agent.ts`); a block with no marker continues the file above it. A page
 * that names no file at all is one file: `main.ts`, or the name the caller
 * gives it, which a page showing JSX needs to be a `.tsx` one.
 */

import { tsBlocksOf } from "../page-mirrors";

/** The file a page that names none is reassembled into. */
export const UNNAMED_PAGE_FILE = "main.ts";

/** The `// <file>.ts` line a block that starts a file opens with. */
export const FILE_MARKER = /^\/\/ (\S+\.ts)\n/;

/**
 * Every ```ts block on the page, keyed by the `// <file>` marker on its first
 * line; a file spread over several blocks is their concatenation in page order.
 */
export function programOf(
  markdown: string,
  unnamed = UNNAMED_PAGE_FILE,
): Map<string, string> {
  const blocks = tsBlocksOf(markdown);
  const files = new Map<string, string>();
  if (!blocks.some((block) => FILE_MARKER.test(block))) {
    if (blocks.length > 0) files.set(unnamed, blocks.join(""));
    return files;
  }
  for (const block of blocks) {
    const marker = FILE_MARKER.exec(block);
    const name = marker?.[1] ?? [...files.keys()].at(-1);
    if (name === undefined)
      throw new Error("a ts block precedes any file marker");
    const body = marker ? block.slice(marker[0].length) : block;
    files.set(name, `${files.get(name) ?? ""}${body}`);
  }
  return files;
}
