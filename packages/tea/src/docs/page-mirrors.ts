/**
 * The doc-mirror gate (#357): a page shows compiled source verbatim.
 *
 * A how-to or tutorial page reproduces an `examples/` file or a test file's
 * `#region` in a ```ts block, and a test asserts the block is that source, so
 * the page cannot drift from what compiles and runs. Pass/fail is exact
 * containment. What this module adds is the failure: it names the page and
 * the source, diffs the source against the closest block on the page, and says
 * which side to copy.
 */

import { readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/** packages/tea — this file lives at src/docs/, two levels down. */
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** A fenced ```ts block, group 1 its body. */
const TS_BLOCK = /```ts\n([\s\S]*?)```/g;

/** Every fenced ```ts block's body on the page, in page order, untrimmed. */
export function tsBlocksOf(markdown: string): string[] {
  return blocksOf(markdown).map((block) => block.body);
}

/** One ```ts block and the page line its body starts on. */
interface Block {
  readonly body: string;
  readonly line: number;
}

function blocksOf(markdown: string): Block[] {
  return [...markdown.matchAll(TS_BLOCK)].map((m) => ({
    body: m[1] ?? "",
    line: markdown.slice(0, m.index).split("\n").length + 1,
  }));
}

/**
 * Source text a page must show.
 *
 * `block` is a source that IS one ```ts block, compared with both sides'
 * trailing whitespace trimmed. `within` is a source that sits inside a larger
 * block, such as one function of a tutorial file; it must appear in one block
 * as a substring, exactly as written.
 */
export interface Mirror {
  /** Where the text came from, as a failure names it. */
  readonly source: string;
  readonly text: string;
  readonly fit: "block" | "within";
}

type Path = string | URL;

const pathOf = (path: Path) =>
  typeof path === "string" ? path : fileURLToPath(path);

/** A path as a failure names it: package-relative. */
const label = (path: Path) => relative(PKG_ROOT, pathOf(path));

/** A whole file the page shows as one block, such as an `examples/` file. */
export async function fileMirror(path: Path): Promise<Mirror> {
  return {
    source: label(path),
    text: (await readFile(pathOf(path), "utf8")).trimEnd(),
    fit: "block",
  };
}

/**
 * The text between a file's `// #region <name>` and `// #endregion <name>`
 * lines. By default the page shows it as one block; `within` finds it inside
 * a larger one.
 */
export async function regionMirror(
  path: Path,
  name: string,
  fit: Mirror["fit"] = "block",
): Promise<Mirror> {
  const source = await readFile(pathOf(path), "utf8");
  const body = source
    .split(`// #region ${name}\n`)[1]
    ?.split(`// #endregion ${name}\n`)[0];
  if (body === undefined)
    throw new Error(`the ${name} region markers are gone from ${label(path)}`);
  return {
    source: `${label(path)} #region ${name}`,
    text: fit === "block" ? body.trimEnd() : body,
    fit,
  };
}

/** Whether `block` shows the mirror, by the exact containment rule. */
function shows(block: Block, mirror: Mirror): boolean {
  return mirror.fit === "block"
    ? block.body.trimEnd() === mirror.text
    : block.body.includes(mirror.text);
}

/** One line of a line diff: kept on both sides, only on the page, or only in the source. */
type DiffLine =
  | { readonly op: "same"; readonly text: string }
  | { readonly op: "page"; readonly text: string; readonly line: number }
  | { readonly op: "source"; readonly text: string; readonly line: number };

/** A longest-common-subsequence line diff of the page's lines against the source's. */
function diffLines(page: readonly string[], source: readonly string[]) {
  const rows = page.length + 1;
  const cols = source.length + 1;
  const lcs = new Array<number>(rows * cols).fill(0);
  const at = (i: number, j: number) => lcs[i * cols + j] ?? 0;
  for (let i = page.length - 1; i >= 0; i--)
    for (let j = source.length - 1; j >= 0; j--)
      lcs[i * cols + j] =
        page[i] === source[j]
          ? at(i + 1, j + 1) + 1
          : Math.max(at(i + 1, j), at(i, j + 1));
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < page.length || j < source.length) {
    if (i < page.length && j < source.length && page[i] === source[j]) {
      out.push({ op: "same", text: page[i] ?? "" });
      i++;
      j++;
    } else if (
      i < page.length &&
      (j === source.length || at(i + 1, j) >= at(i, j + 1))
    ) {
      out.push({ op: "page", text: page[i] ?? "", line: i + 1 });
      i++;
    } else {
      out.push({ op: "source", text: source[j] ?? "", line: j + 1 });
      j++;
    }
  }
  return out;
}

/** The candidate a failure diffs against: which block, which of its lines, and the diff. */
interface Candidate {
  readonly index: number;
  readonly block: Block;
  /** The block line the compared span starts at, 0-based. */
  readonly offset: number;
  readonly diff: readonly DiffLine[];
  readonly differing: number;
  /** The tie-break between equally distant candidates: {@link charDrift}. */
  readonly drift: number;
}

/**
 * How many characters of the differing lines are not a shared prefix or
 * suffix — enough to tell a one-word edit of a line from a different line.
 */
function charDrift(diff: readonly DiffLine[]): number {
  const side = (op: DiffLine["op"]) =>
    diff
      .filter((d) => d.op === op)
      .map((d) => d.text)
      .join("\n");
  const page = side("page");
  const source = side("source");
  let prefix = 0;
  while (
    prefix < Math.min(page.length, source.length) &&
    page[prefix] === source[prefix]
  )
    prefix++;
  let suffix = 0;
  while (
    suffix < Math.min(page.length, source.length) - prefix &&
    page[page.length - 1 - suffix] === source[source.length - 1 - suffix]
  )
    suffix++;
  return page.length + source.length - 2 * (prefix + suffix);
}

/**
 * The block closest to the mirror: the one whose line diff against the source
 * has the fewest differing lines, then the fewest differing characters, then
 * the first in page order. A `within` mirror is compared against every
 * same-height span of each block.
 */
function closest(
  blocks: readonly Block[],
  mirror: Mirror,
): Candidate | undefined {
  const source = mirror.text.trimEnd().split("\n");
  let best: Candidate | undefined;
  blocks.forEach((block, index) => {
    const lines = block.body.trimEnd().split("\n");
    const spans =
      mirror.fit === "block" || lines.length <= source.length
        ? [0]
        : Array.from({ length: lines.length - source.length + 1 }, (_, k) => k);
    for (const offset of spans) {
      const page =
        mirror.fit === "block"
          ? lines
          : lines.slice(offset, offset + source.length);
      const diff = diffLines(page, source);
      const differing = diff.filter((d) => d.op !== "same").length;
      const drift = charDrift(diff);
      if (
        best === undefined ||
        differing < best.differing ||
        (differing === best.differing && drift < best.drift)
      )
        best = { index, block, offset, diff, differing, drift };
    }
  });
  return best;
}

/** 1st, 2nd, 3rd, 4th, …, 11th, 12th, 13th, 21st. */
const ordinal = (n: number) => {
  const suffixes = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${suffixes[(v - 20) % 10] ?? suffixes[v] ?? "th"}`;
};

/**
 * Pure core: why the page does not show the mirror, or `undefined` when it
 * does. `page` is the page's name as the failure should print it.
 */
export function mirrorDrift(
  page: string,
  markdown: string,
  mirror: Mirror,
): string | undefined {
  const blocks = blocksOf(markdown);
  if (blocks.some((block) => shows(block, mirror))) return undefined;
  const head = `${page} does not show ${mirror.source} verbatim.`;
  const best = closest(blocks, mirror);
  if (best === undefined)
    return `${head}\nThe page has no \`\`\`ts block; add one holding ${mirror.source}.`;
  const body = best.diff.flatMap((d) => {
    if (d.op === "same") return [];
    if (d.op === "source") return [`  + source line ${d.line}: ${d.text}`];
    const line = best.block.line + best.offset + d.line - 1;
    return [`  - page   line ${line}: ${d.text}`];
  });
  const where = `the ${ordinal(best.index + 1)} \`\`\`ts block (page line ${best.block.line})`;
  return [
    head,
    `Closest is ${where}, and only these lines differ:`,
    ...(body.length > 0
      ? body
      : ["  (every line matches; the difference is trailing whitespace)"]),
    `The source compiles and runs, so it wins: copy ${mirror.source} into that block on the page.`,
  ].join("\n");
}

/**
 * Assert the page shows every mirror, throwing one error that carries every
 * drift. With `only`, the page's ```ts blocks must also be exactly these
 * mirrors, in this order, and nothing else.
 */
export async function expectPageMirrors(
  page: Path,
  mirrors: readonly (Mirror | Promise<Mirror>)[],
  options: { readonly only?: boolean } = {},
): Promise<void> {
  const markdown = await readFile(pathOf(page), "utf8");
  const resolved = await Promise.all(mirrors);
  const name = label(page);
  const drifts = resolved.flatMap((mirror) => {
    const drift = mirrorDrift(name, markdown, mirror);
    return drift === undefined ? [] : [drift];
  });
  if (drifts.length === 0 && options.only) {
    const blocks = blocksOf(markdown);
    const inOrder =
      blocks.length === resolved.length &&
      resolved.every((mirror, i) => {
        const block = blocks[i];
        return block !== undefined && shows(block, mirror);
      });
    if (!inOrder)
      drifts.push(
        `${name} must show exactly ${resolved.length} \`\`\`ts block(s), in this order: ` +
          `${resolved.map((m) => m.source).join(", ")}. It shows ${blocks.length}; ` +
          "remove or reorder the page's blocks to match.",
      );
  }
  if (drifts.length > 0) throw new Error(drifts.join("\n\n"));
}
