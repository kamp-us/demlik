import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ApiInputError } from "./map.js";

// The git repository that holds a package (SPEC §13.4). Every git command here only reads:
// `rev-parse` and `archive`. Nothing writes the checkout's files, index or refs.
export type Checkout = {
  readonly top: string;
  // The package root, relative to `top`.
  readonly packagePath: string;
};

function gitRead(cwd: string, args: readonly string[]) {
  return spawnSync("git", args, { cwd, encoding: "utf8" });
}

export function checkoutOf(rootAbsolute: string): Checkout {
  const run = gitRead(rootAbsolute, ["rev-parse", "--show-toplevel"]);
  if (run.error !== undefined || run.status !== 0) {
    throw new ApiInputError(
      `${rootAbsolute} is not inside a git repository; --api-base reads its base commit from git`,
    );
  }
  const top = fs.realpathSync(run.stdout.trim());
  return { top, packagePath: path.relative(top, rootAbsolute) };
}

// The full sha `rev` names, or `ApiInputError` when it names no commit.
export function resolveBase(checkout: Checkout, rev: string): string {
  const run = gitRead(checkout.top, [
    ...["rev-parse", "--verify", "--quiet", "--end-of-options"],
    `${rev}^{commit}`,
  ]);
  if (run.error !== undefined || run.status !== 0) {
    throw new ApiInputError(
      `base rev "${rev}" does not resolve to a commit in ${checkout.top} (in CI, fetch it first)`,
    );
  }
  return run.stdout.trim();
}

const exited = (child: ReturnType<typeof spawn>): Promise<number | null> =>
  new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code));
  });

// `git archive <sha> | tar -x -C <into>`: the commit's whole tree from the repository's objects.
async function archiveInto(top: string, sha: string, into: string): Promise<void> {
  const archive = spawn("git", ["archive", "--format=tar", sha], {
    cwd: top,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const extract = spawn("tar", ["-x", "-f", "-", "-C", into], {
    stdio: ["pipe", "ignore", "pipe"],
  });
  const errors: string[] = [];
  archive.stderr?.on("data", (chunk) => errors.push(String(chunk)));
  extract.stderr?.on("data", (chunk) => errors.push(String(chunk)));
  // A tar that dies early closes its stdin under git; the exit codes below report that, so the
  // pipe error itself is not a second failure.
  extract.stdin?.on("error", () => {});
  archive.stdout?.pipe(extract.stdin as NodeJS.WritableStream);
  const codes = await Promise.all([exited(archive), exited(extract)]).catch((error: Error) => {
    throw new ApiInputError(`git archive of ${sha} failed: ${error.message}`);
  });
  if (codes.some((code) => code !== 0)) {
    throw new ApiInputError(
      `git archive of ${sha} failed: ${errors.join("").trim() || "no output"}`,
    );
  }
}

function linkInstalled(installed: string, link: string): void {
  if (!fs.existsSync(installed) || !fs.existsSync(path.dirname(link))) return;
  if (fs.existsSync(link)) return;
  fs.symlinkSync(installed, link, "dir");
}

// A base commit's tree, written into a temp folder outside the checkout. `root` is the package
// root inside it, which may not exist when the commit predates the package.
export type BaseTree = { readonly temp: string; readonly root: string };

// Writes `sha`'s tree into a temp folder and links the checkout's installed `node_modules` (the
// package's and the repository root's) into it, so the base resolves its dependencies against
// what is installed now. The caller removes the folder with `removeBaseTree`.
export async function exportBaseTree(checkout: Checkout, sha: string): Promise<BaseTree> {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "code-graph-api-base-")));
  try {
    await archiveInto(checkout.top, sha, temp);
    const root = path.join(temp, checkout.packagePath);
    const packageNow = path.join(checkout.top, checkout.packagePath);
    linkInstalled(path.join(packageNow, "node_modules"), path.join(root, "node_modules"));
    linkInstalled(path.join(checkout.top, "node_modules"), path.join(temp, "node_modules"));
    return { temp, root };
  } catch (error) {
    removeBaseTree({ temp });
    throw error;
  }
}

export function removeBaseTree(tree: { readonly temp: string }): void {
  fs.rmSync(tree.temp, { recursive: true, force: true });
}
