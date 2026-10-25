import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import {
  checkoutOf,
  exportBaseTree,
  namesAtBase,
  removeBaseTree,
  resolveBase,
} from "../../packages/code-graph/src/api/base.ts";
import { readChangesetsSince } from "../../packages/code-graph/src/api/ratchet/changesets.ts";

const revision = z
  .object({ top: z.string(), packagePath: z.string(), revision: z.string() })
  .strict();
const request = z.discriminatedUnion("operation", [
  z
    .object({
      id: z.string(),
      operation: z.literal("checkout"),
      input: z.object({ root: z.string() }).strict(),
    })
    .strict(),
  z
    .object({
      id: z.string(),
      operation: z.literal("resolve"),
      input: revision,
    })
    .strict(),
  z
    .object({
      id: z.string(),
      operation: z.literal("names"),
      input: z
        .object({ cwd: z.string(), sha: z.string(), dir: z.string() })
        .strict(),
    })
    .strict(),
  z
    .object({
      id: z.string(),
      operation: z.literal("read"),
      input: z
        .object({
          root: z.string(),
          base: z.string(),
          repoRoot: z.string().optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({ id: z.string(), operation: z.literal("export"), input: revision })
    .strict(),
  z
    .object({
      id: z.string(),
      operation: z.literal("remove"),
      input: z.object({ temp: z.string() }).strict(),
    })
    .strict(),
]);
type Request = z.infer<typeof request>;
type ErrorView = {
  name: string;
  message: string;
  code?: string;
  path?: string;
  destination?: string;
  location?: string;
  argument?: string;
};
function errorView(error: unknown, request: Request): ErrorView {
  if (!(error instanceof Error))
    return { name: "Error", message: String(error) };
  const result: ErrorView = { name: error.name, message: error.message };
  const code =
    "code" in error && typeof error.code === "string" ? error.code : undefined;
  if (code !== undefined) result.code = code;
  if ("path" in error) result.path = String(error.path);
  if ("dest" in error) result.destination = String(error.dest);
  if (code === "ERR_INVALID_ARG_VALUE") {
    const location =
      error.message.match(/args\[\d+\]/)?.[0] ??
      (error.message.includes("cwd") ? "options.cwd" : "path");
    let args: string[] = [],
      cwd = "";
    switch (request.operation) {
      case "checkout":
        args = ["rev-parse", "--show-toplevel"];
        cwd = request.input.root;
        break;
      case "resolve":
        args = [
          "rev-parse",
          "--verify",
          "--quiet",
          "--end-of-options",
          `${request.input.revision}^{commit}`,
        ];
        cwd = request.input.top;
        break;
      case "names":
        args = [
          "ls-tree",
          "-z",
          "--name-only",
          request.input.sha,
          "--",
          request.input.dir,
        ];
        cwd = request.input.cwd;
        break;
      case "export":
        args = ["archive", "--format=tar", request.input.revision];
        cwd = request.input.top;
        break;
    }
    result.location = location;
    result.argument =
      location === "path" && request.operation === "remove"
        ? request.input.temp
        : location === "options.cwd"
          ? cwd
          : args[Number(location.match(/\d+/)?.[0])];
  }
  return result;
}
type Entry = {
  path: string;
  kind: string;
  mode: number;
  target?: string;
  bytes?: number[];
};
function entries(root: string, relative = ""): Entry[] {
  const output: Entry[] = [];
  for (const name of fs.readdirSync(path.join(root, relative)).sort()) {
    const file = path.join(relative, name),
      absolute = path.join(root, file),
      stat = fs.lstatSync(absolute);
    const entry: Entry = {
      path: file,
      kind: stat.isSymbolicLink()
        ? "symlink"
        : stat.isDirectory()
          ? "directory"
          : "file",
      mode: stat.mode & 0o7777,
    };
    if (stat.isSymbolicLink()) entry.target = fs.readlinkSync(absolute);
    else if (stat.isFile()) entry.bytes = [...fs.readFileSync(absolute)];
    output.push(entry);
    if (stat.isDirectory()) output.push(...entries(root, file));
  }
  return output;
}
async function execute(
  value: Request,
): Promise<{ value: unknown } | { error: ErrorView }> {
  try {
    let output: unknown;
    switch (value.operation) {
      case "checkout":
        output = checkoutOf(value.input.root);
        break;
      case "resolve":
        output = resolveBase(value.input, value.input.revision);
        break;
      case "names":
        output = namesAtBase(value.input.cwd, value.input.sha, value.input.dir);
        break;
      case "read":
        output = readChangesetsSince(value.input.root, value.input.base, {
          repoRoot: value.input.repoRoot,
        });
        break;
      case "remove":
        removeBaseTree(value.input);
        output = { removed: !fs.existsSync(value.input.temp) };
        break;
      case "export": {
        const tree = await exportBaseTree(value.input, value.input.revision);
        const view = {
          tempExternal: !tree.temp.startsWith(`${value.input.top}/`),
          tempMode: fs.statSync(tree.temp).mode & 0o7777,
          rootRelative: path.relative(tree.temp, tree.root),
          rootExists: fs.existsSync(tree.root),
          entries: entries(tree.temp),
          removed: false,
          repeatRemoved: false,
        };
        removeBaseTree(tree);
        view.removed = !fs.existsSync(tree.temp);
        removeBaseTree(tree);
        view.repeatRemoved = !fs.existsSync(tree.temp);
        output = view;
        break;
      }
    }
    return { value: output };
  } catch (error) {
    return { error: errorView(error, value) };
  }
}
for await (const line of createInterface({ input: process.stdin })) {
  let id: string | null = null;
  try {
    const raw: unknown = JSON.parse(line);
    id =
      typeof raw === "object" &&
      raw !== null &&
      "id" in raw &&
      typeof raw.id === "string"
        ? raw.id
        : null;
    const value = request.parse(raw);
    console.log(JSON.stringify({ id, ok: true, output: await execute(value) }));
  } catch (error) {
    console.log(JSON.stringify({ id, ok: false, error: String(error) }));
  }
}
