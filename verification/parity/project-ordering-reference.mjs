import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as project from "../../packages/code-graph/src/extract/project.js";
import {
  findWranglerConfigs,
  loadBindingCatalog,
} from "../../packages/code-graph/src/extract/wrangler-config.js";
import { runHexagon } from "../../packages/code-graph/src/hexagon/cli.js";
import { readHexagon } from "../../packages/code-graph/src/hexagon/read.js";
import { workspacePackages } from "../../packages/code-graph/src/layers/resolve-target.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
export const hash = (data) => createHash("sha256").update(data).digest("hex");
const errorView = (error) => ({ name: error.name, message: error.message });
const rawError = (error) => ({
  ...errorView(error),
  stack: error.stack,
  code: error.code,
  path: error.path,
  syscall: error.syscall,
});

export function snapshot(directory) {
  const files = {};
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const absolute = path.join(dir, entry.name),
        relative = path.relative(directory, absolute);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isSymbolicLink())
        files[relative] = { symlink: fs.readlinkSync(absolute) };
      else if (entry.isFile()) {
        const stat = fs.statSync(absolute);
        try {
          files[relative] = {
            base64: fs.readFileSync(absolute).toString("base64"),
            mode: stat.mode & 0o777,
            bytes: stat.size,
          };
        } catch (error) {
          files[relative] = {
            readError: {
              ...errorView(error),
              code: error.code,
              path: error.path,
              syscall: error.syscall,
            },
            mode: stat.mode & 0o777,
            bytes: stat.size,
          };
        }
      }
    }
  }
  visit(directory);
  return Object.fromEntries(
    Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

// Delegate every original builtin unchanged. These are Source-host receipts,
// not a promise that Rust and Go make identical internal filesystem calls.
export function monitor(directory) {
  const events = [],
    originals = new Map(),
    state = { active: false };
  const savedExec = childProcess.execFileSync;
  function local(value) {
    if (typeof value !== "string") return null;
    const absolute = path.resolve(value);
    return absolute === directory || absolute.startsWith(directory + path.sep)
      ? absolute
      : null;
  }
  for (const name of [
    "readFileSync",
    "statSync",
    "existsSync",
    "readdirSync",
    "writeFileSync",
  ]) {
    const original = fs[name];
    originals.set(name, original);
    fs[name] = function (...args) {
      const file = state.active ? local(args[0]) : null;
      const entry = file
        ? { operation: name, path: file, inputPath: args[0] }
        : null;
      if (entry) events.push(entry);
      try {
        const value = Reflect.apply(original, this, args);
        if (entry) {
          entry.ok = true;
          if (name === "readFileSync") {
            const bytes =
              typeof value === "string" ? Buffer.from(value) : value;
            entry.bytes = bytes.length;
            entry.sha256 = hash(bytes);
          } else if (name === "statSync") {
            entry.file = value.isFile();
            entry.directory = value.isDirectory();
            entry.mode = value.mode & 0o777;
          } else if (name === "existsSync") entry.exists = value;
          else if (name === "readdirSync")
            entry.names = value.map((v) =>
              typeof v === "string" ? v : v.name,
            );
          else {
            const bytes =
              typeof args[1] === "string" ? Buffer.from(args[1]) : args[1];
            entry.bytes = bytes.length;
            entry.sha256 = hash(bytes);
          }
        }
        return value;
      } catch (error) {
        if (entry) {
          entry.ok = false;
          entry.error = rawError(error);
        }
        throw error;
      }
    };
  }
  childProcess.execFileSync = function (...args) {
    const entry = state.active
      ? {
          operation: "execFileSync",
          command: args[0],
          args: args[1],
          cwd: args[2]?.cwd ?? process.cwd(),
        }
      : null;
    if (entry) events.push(entry);
    try {
      const value = Reflect.apply(savedExec, this, args);
      if (entry) {
        const bytes = typeof value === "string" ? Buffer.from(value) : value;
        entry.status = 0;
        entry.stdoutHex = bytes.toString("hex");
        entry.stdoutSHA256 = hash(bytes);
      }
      return value;
    } catch (error) {
      if (entry) {
        entry.status = error.status ?? null;
        entry.error = rawError(error);
      }
      throw error;
    }
  };
  syncBuiltinESMExports();
  return {
    events,
    state,
    stop() {
      state.active = false;
      for (const [name, value] of originals) fs[name] = value;
      childProcess.execFileSync = savedExec;
      syncBuiltinESMExports();
    },
  };
}

function loadedView(loaded) {
  const base = loaded;
  return {
    rootAbsolute: base.rootAbsolute,
    sourceFiles: base.sourceFiles.map((unit) => ({
      file: unit.file,
      absolutePath: unit.absolutePath,
      text: unit.syntax.text,
      lineStarts: unit.syntax.lineStarts,
      comments: unit.syntax.comments,
      rootType: unit.syntax.program.type,
      bodyTypes: unit.syntax.program.body.map((node) => node.type),
    })),
    parseFailures: base.parseFailures,
    ...(loaded.tsConfigPath === undefined
      ? {}
      : { tsConfigPath: loaded.tsConfigPath, scope: loaded.scope }),
  };
}

export function reference(input, directory, io) {
  const selected = path.join(directory, input.root ?? "");
  const listing =
    input.listing === undefined
      ? undefined
      : { root: directory, files: input.listing };
  const beforeListing = JSON.stringify(listing),
    calls = [],
    errors = [];
  const call = (name, operation) => {
    calls.push(name);
    return operation();
  };
  const attempt = (name, operation) => {
    try {
      return { ok: true, value: call(name, operation) };
    } catch (error) {
      errors.push(rawError(error));
      return { ok: false, error: errorView(error) };
    }
  };
  let output;
  if (input.mode === "list")
    output = {
      visible: call("listVisibleFiles", () =>
        project.listVisibleFiles(selected, () => true),
      ),
      sources: call("listSourceFiles", () =>
        project
          .listSourceFiles(selected)
          .map((file) => project.toRelative(selected, file)),
      ),
    };
  else if (input.mode === "scope")
    output = input.scopes.map((scope) => ({
      scope,
      files: call("listVisibleFiles", () =>
        project.listVisibleFiles(
          path.join(directory, scope),
          () => true,
          listing,
        ),
      ),
    }));
  else if (input.mode === "predicate") {
    const seen = [];
    output = {
      files: call("listVisibleFiles", () =>
        project.listVisibleFiles(
          selected,
          (file) => {
            const keep = !input.reject.includes(file);
            seen.push({ file, keep });
            io.events.push({ operation: "keep", file, keep });
            return keep;
          },
          listing,
        ),
      ),
      seen,
    };
  } else if (input.mode === "visible")
    output = call("listVisibleFiles", () =>
      project.listVisibleFiles(selected, () => true, listing),
    );
  else if (input.mode === "cheap")
    output = attempt("loadCheapProject", () =>
      loadedView(project.loadCheapProject(selected, listing)),
    );
  else if (input.mode === "edge")
    output = attempt("loadEdgeProject", () =>
      loadedView(
        project.loadEdgeProject(selected, input.scope, directory, listing),
      ),
    );
  else if (input.mode === "edge-scope")
    output = ["deep", "package"].map((scope) => ({
      scope,
      result: attempt("loadEdgeProject", () =>
        loadedView(
          project.loadEdgeProject(selected, scope, directory, listing),
        ),
      ),
    }));
  else if (input.mode === "roots")
    output = call("discoverPackageRoots", () =>
      project.discoverPackageRoots(selected, listing),
    );
  else if (input.mode === "workspaces") {
    const roots = call("discoverPackageRoots", () =>
      project.discoverPackageRoots(selected, listing),
    );
    output = {
      roots,
      packages: call("workspacePackages", () => [
        ...workspacePackages(selected, roots),
      ]),
    };
  } else if (input.mode === "catalog")
    output = {
      files: call("findWranglerConfigs", () =>
        findWranglerConfigs(selected, listing),
      ),
      catalog: attempt("loadBindingCatalog", () =>
        loadBindingCatalog(selected, listing),
      ),
    };
  else if (input.mode === "hexagon") {
    const report = attempt("readHexagon", () => readHexagon(selected));
    const emitted = [],
      reported = [];
    call("runHexagon", () =>
      runHexagon(selected, {
        json: true,
        pretty: false,
        emit: (text) => emitted.push(text),
        report: (error) => reported.push(error),
      }),
    );
    output = { report, emitted, reported };
  } else throw new Error(`unsupported Source mode ${input.mode}`);
  assert.equal(
    JSON.stringify(listing),
    beforeListing,
    "borrowed RepoListing unchanged",
  );
  if (input.expectError)
    assert.ok(JSON.stringify(output).includes(input.expectError));
  return { view: { output, calls, listingUnchanged: true }, errors };
}

const request = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
assert.deepEqual(
  [
    process.version,
    process.versions.v8,
    process.versions.icu,
    Intl.Collator().resolvedOptions().locale,
  ],
  ["v22.21.1", "12.4.254.21-node.33", "77.1", "en-US"],
);
const io = monitor(request.directory);
let response;
try {
  io.state.active = true;
  if (request.action) {
    process.argv = [
      process.execPath,
      path.join(root, "packages/code-graph/src/index.ts"),
      request.directory,
      ...request.action.flags,
    ];
    if (request.action.initial !== undefined)
      process.exitCode = request.action.initial;
    await import(
      pathToFileURL(path.join(root, "packages/code-graph/src/index.ts")).href
    );
    response = {
      view: { kind: "cli", exitCode: process.exitCode ?? 0 },
      errors: [],
    };
  } else response = reference(request.input, request.directory, io);
} finally {
  io.stop();
}
fs.writeFileSync(
  request.response,
  `${JSON.stringify({ ...response, io: io.events })}\n`,
);
