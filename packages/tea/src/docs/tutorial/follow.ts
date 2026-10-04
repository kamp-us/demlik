/**
 * Follow a tutorial page the way its reader is told to, in a real directory.
 *
 * Every fenced block is acted on in page order: a `sh` block's commands are
 * run, the `json` block is written as `tsconfig.json`, each `ts` block is
 * appended to the file the page is building, a `diff` block is applied to that
 * file, and a `text` block is what the command above it must have printed.
 *
 * One thing is stood in for. `pnpm add` would fetch the published packages, so
 * it installs this checkout instead: `@demlik/tea` is built from `src/` (the
 * entry points the lessons import, with their declarations) and the other
 * packages are linked from this package's own `node_modules`. A package a page
 * adds that has no stand-in fails the follow.
 */

import { execFile } from "node:child_process";
import {
  appendFile,
  mkdir,
  readFile,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { build } from "vite";
import { FILE_MARKER, UNNAMED_PAGE_FILE } from "./program";

const repo = fileURLToPath(new URL("../../..", import.meta.url));

/** The entry points the lessons import, as `package.json` `exports` keys them. */
const ENTRIES = { ".": "index", "./promise": "promise/index" } as const;

/**
 * `@demlik/tea` as an installed package, built from `src/` into `dir`.
 *
 * The declarations are one `.d.ts` per source file, with the extensionless
 * relative imports `src/` uses. The reader's `nodenext` resolver accepts those
 * only in a CommonJS-format file, so this `package.json` declares no `type` and
 * the JavaScript carries its format in the `.mjs` extension instead.
 */
export async function buildTea(dir: string): Promise<void> {
  const stems = Object.values(ENTRIES);
  await build({
    configFile: join(repo, "vitest.config.ts"),
    root: repo,
    logLevel: "error",
    build: {
      ssr: true,
      outDir: dir,
      emptyOutDir: true,
      minify: false,
      rollupOptions: {
        input: Object.fromEntries(
          stems.map((stem) => [stem, join(repo, "src", `${stem}.ts`)]),
        ),
        output: {
          entryFileNames: "[name].mjs",
          chunkFileNames: "chunks/[name]-[hash].mjs",
          format: "es",
        },
      },
    },
  });

  const config = ts.getParsedCommandLineOfConfigFile(
    join(repo, "tsconfig.json"),
    {
      noEmit: false,
      emitDeclarationOnly: true,
      rootDir: join(repo, "src"),
      outDir: join(dir, "types"),
    },
    { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} },
  );
  if (config === undefined) throw new Error("tsconfig.json is unreadable");
  const emitted = ts
    .createProgram(
      stems.map((stem) => join(repo, "src", `${stem}.ts`)),
      config.options,
    )
    .emit();
  if (emitted.emitSkipped) throw new Error("tea's declarations did not emit");

  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({
      name: "@demlik/tea",
      exports: Object.fromEntries(
        Object.entries(ENTRIES).map(([spec, stem]) => [
          spec,
          { types: `./types/${stem}.d.ts`, import: `./${stem}.mjs` },
        ]),
      ),
    }),
  );
}

/** Where `pnpm add <name>` gets each package a page installs. */
const stoodIn = (tea: string): Readonly<Record<string, string>> => ({
  "@demlik/tea": tea,
  typescript: join(repo, "node_modules/typescript"),
  "@types/node": join(repo, "node_modules/@types/node"),
  zod: join(repo, "node_modules/zod"),
});

/** `pnpm add [-D] <names>` in `cwd`, from this checkout instead of the registry. */
async function add(
  cwd: string,
  names: readonly string[],
  from: Readonly<Record<string, string>>,
): Promise<void> {
  for (const name of names) {
    const source = from[name];
    if (source === undefined)
      throw new Error(`the page installs ${name}, which has no stand-in here`);
    const target = join(cwd, "node_modules", name);
    await mkdir(dirname(target), { recursive: true });
    await symlink(await realpath(source), target);
  }
  if (names.includes("typescript")) {
    await mkdir(join(cwd, "node_modules/.bin"), { recursive: true });
    await symlink("../typescript/bin/tsc", join(cwd, "node_modules/.bin/tsc"));
  }
}

/** Run one command line of the page in `cwd`; a non-zero exit throws with its output. */
function sh(cwd: string, line: string): Promise<string> {
  const [command = "", ...args] = line.split(/\s+/);
  return new Promise((resolve, reject) => {
    execFile(
      command === "node" ? process.execPath : command,
      args,
      { cwd },
      (error, stdout, stderr) => {
        if (error === null) resolve(stdout);
        else
          reject(
            new Error(`\`${line}\` failed:\n${stdout}${stderr}`.trimEnd()),
          );
      },
    );
  });
}

/**
 * Apply one `diff` block to the file at `path`. A line opens with a space
 * (kept), `-` (taken out) or `+` (put in). The kept and taken-out lines must
 * sit together in the file exactly once, and that stretch becomes the kept and
 * put-in lines.
 */
async function applyDiff(path: string, body: string): Promise<void> {
  const lines = body.trimEnd().split("\n");
  const without = (sign: string): string =>
    lines
      .filter((line) => !line.startsWith(sign))
      .map((line) => line.slice(1))
      .join("\n");
  const [before, after] = [without("+"), without("-")];
  const file = await readFile(path, "utf8");
  if (file.split(before).length !== 2)
    throw new Error(`a diff does not apply to ${path} exactly once:\n${body}`);
  await writeFile(
    path,
    file.replace(before, () => after),
  );
}

/** A fenced block with a language tag, group 1 the tag and group 2 the body. */
export const FENCE = /```(\w+)\n([\s\S]*?)```/g;

/** One command the page ran whose output it goes on to state. */
export interface Printed {
  readonly command: string;
  readonly printed: string;
  readonly pageSays: string;
}

/**
 * Follow the page in the directory `cwd`, block by block, with `tea` the
 * directory `buildTea` filled. A command that fails rejects, and so does a diff
 * that does not apply. What the page says each run prints is returned beside
 * what it printed.
 */
export async function follow(
  markdown: string,
  cwd: string,
  tea: string,
): Promise<Printed[]> {
  const stated: Printed[] = [];
  let last: { command: string; printed: string } | undefined;
  let file = UNNAMED_PAGE_FILE;
  for (const [, lang, body = ""] of markdown.matchAll(FENCE)) {
    if (lang === "ts") {
      const marker = FILE_MARKER.exec(body);
      file = marker?.[1] ?? file;
      await appendFile(join(cwd, file), body.slice(marker?.[0].length ?? 0));
    } else if (lang === "diff") await applyDiff(join(cwd, file), body);
    else if (lang === "json") await writeFile(join(cwd, "tsconfig.json"), body);
    else if (lang === "sh")
      for (const command of body.trimEnd().split("\n")) {
        const added = /^pnpm add (?:-D )?(.+)$/.exec(command);
        if (added?.[1] === undefined)
          last = { command, printed: await sh(cwd, command) };
        else await add(cwd, added[1].split(" "), stoodIn(tea));
      }
    else if (lang === "text") {
      if (last === undefined)
        throw new Error("the page states an output before it runs anything");
      stated.push({ ...last, pageSays: body });
    } else
      throw new Error(`the page has a \`${lang}\` block nothing here acts on`);
  }
  return stated;
}
