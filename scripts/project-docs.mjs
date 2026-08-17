// @ts-check
//
// Project the repo's canonical Markdown into Starlight's content collection.
//
// WHY THIS EXISTS, and why it is not symlinks. Starlight's `docs` schema requires
// `title` frontmatter on every page. Not one of this repo's 79 Markdown files has
// frontmatter — they open with an `# H1` and are read on GitHub, and two of the
// trees are GENERATED (docs/reference/ is emitted by typedoc and drift-gated in
// CI). Adding frontmatter to them would mean editing generated output and fighting
// that gate, and it would put a YAML table at the top of every file on GitHub.
//
// So the canonical sources stay pristine and this script projects them: it derives
// `title` from the H1, derives `description` from the opening paragraph, rewrites
// cross-tree links to site routes, and writes the result into src/content/docs/.
// The projection is gitignored and regenerated on every `dev`, `build` and
// `typecheck`, so it cannot drift from the source — there is nothing to keep in
// sync by hand.
//
// Links are rewritten HERE rather than in a remark plugin because the trees are
// re-parented on the way in (`.patterns/tea` becomes `/patterns/tea/`), so a
// relative link's meaning depends on the source layout, which only this script
// knows. `starlight-links-validator` is the build-failing gate on the result.

import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

// The output directory is an ARGUMENT, not a constant, because this script does not
// belong to any particular site. It projects the repo's docs into whatever content
// collection a consumer points it at:
//
//   node scripts/project-docs.mjs apps/docs/src/content/docs
//
// There is no site in this repo today. The script is kept because the projection
// itself is the hard part and is independent of whatever renders it.
const OUT_ARG = process.argv[2];
if (!OUT_ARG) {
  console.error(
    "project-docs: needs an output directory.\n" +
      "  usage: node scripts/project-docs.mjs <out-dir>\n" +
      "  e.g.   node scripts/project-docs.mjs apps/docs/src/content/docs",
  );
  process.exit(2);
}
const OUT_ROOT = path.resolve(REPO_ROOT, OUT_ARG);

const GITHUB_BLOB = "https://github.com/kamp-us/demlik/blob/main";

/**
 * Every tree that becomes site content, as `repo-relative source` → `route prefix`.
 * The route prefix doubles as the output directory under src/content/docs/.
 * Adding a tree is one row here plus a sidebar group in astro.config.mjs.
 */
const TREES = [
  { src: "docs/tutorial", dest: "tutorial" },
  { src: "docs/how-to", dest: "how-to" },
  { src: "docs/reference", dest: "reference" },
  { src: "docs/explanation", dest: "explanation" },
];

/** Site-owned pages that live in src/content/docs/ and must survive a clean. */
/** Files in the output dir the consumer owns; a clean must not delete them. */
const SITE_OWNED = new Set(["index.mdx", "index.md"]);

/** @param {string} p */
const toPosix = (p) => p.split(path.sep).join("/");

/**
 * A page's route, mirroring Starlight's file-based routing: path under the
 * content root, minus the extension, with an `index` basename collapsing to its
 * directory, lowercased and served with a trailing slash.
 * @param {string} destRelPath e.g. "reference/do.md"
 */
function routeFor(destRelPath) {
  let r = toPosix(destRelPath).replace(/\.mdx?$/i, "");
  r = r.replace(/(^|\/)index$/i, "$1").replace(/\/$/, "");
  return `/${r.toLowerCase()}/`.replace(/\/{2,}/g, "/");
}

/**
 * `README.md` is an index page by convention in the pattern trees; Starlight
 * routes on `index`. Normalise on the way out so `.patterns/tea/patterns/README.md`
 * becomes `/patterns/tea/patterns/`.
 * @param {string} relPath
 */
const normaliseIndex = (relPath) =>
  relPath.replace(/(^|\/)README\.md$/i, "$1index.md");

/**
 * Map a repo-relative Markdown path to its site route, or null when the file is
 * not part of any synced tree (a link into src/, scripts/, examples/ …).
 * @param {string} repoRelPath
 */
function repoPathToRoute(repoRelPath) {
  const posix = toPosix(repoRelPath);
  for (const tree of TREES) {
    const prefix = `${tree.src}/`;
    if (!posix.startsWith(prefix)) continue;
    const within = normaliseIndex(posix.slice(prefix.length));
    return routeFor(path.posix.join(tree.dest, within));
  }
  return null;
}

/**
 * Pull the page title out of the first `# ` heading, and return the body with
 * that heading removed — Starlight renders the frontmatter title as the page's
 * H1, so leaving it in the body would render it twice.
 * @param {string} body
 */
function extractTitle(body) {
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^#\s+(.+?)\s*$/.exec(lines[i]);
    if (!m) continue;
    lines.splice(i, 1);
    while (lines[i] !== undefined && lines[i].trim() === "") lines.splice(i, 1);
    return { title: m[1].trim(), body: lines.join("\n") };
  }
  return { title: null, body };
}

/**
 * First real paragraph, flattened to a single line and stripped of the Markdown
 * that would look wrong in a `<meta name="description">`.
 * @param {string} body
 */
function extractDescription(body) {
  const blocks = body.split(/\n\s*\n/);
  for (const raw of blocks) {
    const block = raw.trim();
    if (!block) continue;
    // Skip anything that isn't prose: headings, quotes, lists, tables, fences, badges.
    if (/^[#>\-*|`!]/.test(block)) continue;
    if (/^\s*\[/.test(block)) continue;
    const flat = block
      .replace(/\s+/g, " ")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // links → their text
      .replace(/[`*_]/g, "")
      .trim();
    if (flat.length < 20) continue;
    return flat.length > 160 ? `${flat.slice(0, 157).trimEnd()}…` : flat;
  }
  return null;
}

/**
 * Rewrite relative Markdown links to site routes. A link whose target is inside
 * the repo but outside every synced tree becomes a GitHub blob URL, so it still
 * resolves for a reader instead of 404ing or failing the link gate.
 * @param {string} body
 * @param {string} srcFileAbs
 * @param {string[]} dangling collects links whose target does not exist on disk
 */
function rewriteLinks(body, srcFileAbs, dangling) {
  const srcDir = path.dirname(srcFileAbs);
  return body.replace(
    /\]\(([^)\s#]+)(#[^)\s]*)?\)/g,
    (match, target, hash = "") => {
      // Absolute paths, protocol URLs and anchor-only links are already final.
      if (/^(\/|[a-z][a-z0-9+.-]*:)/i.test(target)) return match;

      const isMarkdown = /\.mdx?$/i.test(target);
      const isExplicitlyRelative = /^\.\.?\//.test(target);
      // A bare `14-ports-interop.md` is a sibling link and just as common in these
      // docs as `./14-ports-interop.md`. Anything else without a `./` prefix is
      // not confidently a path, so leave it alone rather than invent a link.
      if (!isExplicitlyRelative && !isMarkdown) return match;

      const targetAbs = path.resolve(srcDir, target);
      const repoRel = toPosix(path.relative(REPO_ROOT, targetAbs));
      // Escaped the repo entirely — leave it alone rather than invent a link.
      if (repoRel.startsWith("..")) return match;

      // A link to a file that isn't here is a content defect, not a routing
      // problem. Left alone it would become a GitHub URL that 404s silently, so
      // collect it and fail the sync — the link gate downstream can only see
      // links that resolved to a route.
      if (!existsSync(targetAbs)) {
        dangling.push(
          `${toPosix(path.relative(REPO_ROOT, srcFileAbs))} → ${target} (no such file)`,
        );
        return match;
      }

      if (isMarkdown) {
        const route = repoPathToRoute(repoRel);
        if (route) return `](${route}${hash})`;
      }
      return `](${GITHUB_BLOB}/${repoRel}${hash})`;
    },
  );
}

/** @param {string} dir */
async function walk(dir) {
  /** @type {string[]} */
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (/\.mdx?$/i.test(entry.name)) out.push(full);
  }
  return out;
}

/** Remove previously-projected content, leaving site-owned pages in place. */
async function clean() {
  if (!existsSync(OUT_ROOT)) return;
  for (const entry of await readdir(OUT_ROOT)) {
    if (SITE_OWNED.has(entry)) continue;
    await rm(path.join(OUT_ROOT, entry), { recursive: true, force: true });
  }
}

async function main() {
  await clean();
  await mkdir(OUT_ROOT, { recursive: true });

  let written = 0;
  let untitled = 0;
  /** @type {string[]} */
  const dangling = [];

  for (const tree of TREES) {
    const srcRoot = path.join(REPO_ROOT, tree.src);
    if (!existsSync(srcRoot) || !(await stat(srcRoot)).isDirectory()) {
      throw new Error(
        `project-docs: source tree "${tree.src}" does not exist. Either it moved, or TREES is stale.`,
      );
    }

    for (const fileAbs of await walk(srcRoot)) {
      const withinTree = normaliseIndex(toPosix(path.relative(srcRoot, fileAbs)));
      const destAbs = path.join(OUT_ROOT, tree.dest, withinTree);

      const raw = await readFile(fileAbs, "utf8");
      if (raw.startsWith("---\n")) {
        throw new Error(
          `project-docs: ${toPosix(path.relative(REPO_ROOT, fileAbs))} already has frontmatter. ` +
            `This script assumes plain Markdown and would double it up.`,
        );
      }

      const { title, body } = extractTitle(raw);
      if (!title) untitled++;
      const description = extractDescription(body);
      const rewritten = rewriteLinks(body, fileAbs, dangling);

      // Fall back to the filename so a heading-less page still builds instead of
      // failing the whole run over one file.
      const pageTitle =
        title ?? path.basename(withinTree, path.extname(withinTree)).replace(/[-_]/g, " ");

      const frontmatter = [
        "---",
        `title: ${JSON.stringify(pageTitle)}`,
        ...(description ? [`description: ${JSON.stringify(description)}`] : []),
        "---",
        "",
      ].join("\n");

      await mkdir(path.dirname(destAbs), { recursive: true });
      await writeFile(destAbs, frontmatter + rewritten.trimStart(), "utf8");
      written++;
    }
  }

  if (dangling.length > 0) {
    throw new Error(
      `project-docs: ${dangling.length} link(s) point at files that do not exist:\n  ` +
        dangling.join("\n  "),
    );
  }

  console.log(
    `project-docs: projected ${written} pages from ${TREES.length} trees` +
      (untitled ? ` (${untitled} had no H1; titled from filename)` : ""),
  );
}

await main();
