/**
 * The first tutorial is followed in CI (#545).
 * `docs/tutorial/build-your-first-machine.md` is read and every fenced block is
 * acted on in page order, in an empty directory, the way the reader is told to:
 * a `sh` block's commands are run, the `json` block is written as
 * `tsconfig.json`, each `ts` block is appended to `main.ts`, and a `text` block
 * must be exactly what the command above it printed.
 *
 * One thing is stood in for. `pnpm add` would fetch the published packages, so
 * it installs this checkout instead: `@demlik/tea` is built from `src/` (the
 * two entry points the lesson imports, with their declarations) and
 * `typescript` and `@types/node` are linked from this package's own
 * `node_modules`. A package the page adds that has no stand-in fails the test.
 */

import { execFile } from "node:child_process";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UNNAMED_PAGE_FILE } from "./program";

const repo = fileURLToPath(new URL("../../..", import.meta.url));
const page = join(repo, "docs/tutorial/build-your-first-machine.md");

/** The entry points the lesson imports, as `package.json` `exports` keys them. */
const ENTRIES = { ".": "index", "./promise": "promise/index" } as const;

/**
 * `@demlik/tea` as an installed package, built from `src/` into `dir`.
 *
 * The declarations are one `.d.ts` per source file, with the extensionless
 * relative imports `src/` uses. The reader's `nodenext` resolver accepts those
 * only in a CommonJS-format file, so this `package.json` declares no `type` and
 * the JavaScript carries its format in the `.mjs` extension instead.
 */
async function buildTea(dir: string): Promise<void> {
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

/** Where `pnpm add <name>` gets each package the page installs. */
const stoodIn = (tea: string): Readonly<Record<string, string>> => ({
  "@demlik/tea": tea,
  typescript: join(repo, "node_modules/typescript"),
  "@types/node": join(repo, "node_modules/@types/node"),
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

/** A fenced block with a language tag, group 1 the tag and group 2 the body. */
const FENCE = /```(\w+)\n([\s\S]*?)```/g;

/** One command the page ran whose output it goes on to state. */
interface Printed {
  readonly command: string;
  readonly printed: string;
  readonly pageSays: string;
}

/**
 * Follow the page in the empty directory `cwd`, block by block. A command that
 * fails rejects; what the page says each run prints is returned beside what it
 * printed.
 */
async function follow(
  markdown: string,
  cwd: string,
  tea: string,
): Promise<Printed[]> {
  const stated: Printed[] = [];
  let last: { command: string; printed: string } | undefined;
  for (const [, lang, body = ""] of markdown.matchAll(FENCE)) {
    if (lang === "ts") await appendFile(join(cwd, UNNAMED_PAGE_FILE), body);
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

describe("docs/tutorial/build-your-first-machine.md, followed from an empty folder", () => {
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
    for (const dir of folders) await rm(dir, { recursive: true, force: true });
    await rm(cache, { recursive: true, force: true });
  });

  it("typechecks, runs, and prints what the page says it prints", async () => {
    const stated = await follow(markdown, await emptyFolder(), tea);

    expect(stated.map((run) => run.command)).toContain(
      `node --experimental-strip-types ${UNNAMED_PAGE_FILE}`,
    );
    for (const run of stated) expect(run.printed).toBe(run.pageSays);
  }, 120_000);

  it("does not run once the setup step is taken off the page", async () => {
    const start = markdown.indexOf("## Set up the project");
    const end = markdown.indexOf("```ts", start);
    expect(start).toBeGreaterThan(-1);
    const withoutSetup = markdown.slice(0, start) + markdown.slice(end);

    await expect(
      follow(withoutSetup, await emptyFolder(), tea),
    ).rejects.toThrow(/failed/);
  }, 120_000);
});
