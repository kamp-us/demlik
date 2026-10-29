import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkedSpawnSync as spawnSync } from "./check-worktree.mjs";
import { projectOrderingCases } from "./project-ordering-cases.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const node = "/Users/cansirin/.volta/tools/image/node/22.21.1/bin/node";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const hashFile = (file) => hash(fs.readFileSync(file));
assert.equal(process.execPath, node);
assert.deepEqual(
  [
    process.version,
    process.versions.v8,
    process.versions.icu,
    Intl.Collator().resolvedOptions().locale,
  ],
  ["v22.21.1", "12.4.254.21-node.33", "77.1", "en-US"],
);
const proof = path.resolve(process.argv[2]);
assert.ok(fs.existsSync(proof));
assert.ok(
  !fs.existsSync(path.join(proof, "source-first.json")),
  "new Source-first record required",
);
const runtime = fs.realpathSync(
  fs.mkdtempSync("/private/tmp/demlik-project-source-"),
);
const fixtureFiles = [
  "project-ordering-cases.mjs",
  "project-ordering-reference.mjs",
  "project-ordering-source.mjs",
];
const sourceFiles = [
  "extract/project.ts",
  "project.ts",
  "extract/wrangler-config.ts",
  "hexagon/read.ts",
  "hexagon/cli.ts",
  "hexagon/ports.ts",
  "layers/resolve-target.ts",
  "schema/core.ts",
  "extract/assemble.ts",
  "extract/edges.ts",
  "syntax/file.ts",
  "engine/oxc.ts",
  "index.ts",
  "cli.ts",
];
const pins = () =>
  Object.fromEntries(
    [
      ...sourceFiles.map((name) => [
        "packages/code-graph/src/" + name,
        path.join(root, "packages/code-graph/src", name),
      ]),
      ...fixtureFiles.map((name) => [
        "verification/parity/" + name,
        path.join(root, "verification/parity", name),
      ]),
    ].map(([name, file]) => [name, hashFile(file)]),
  );
const beforePins = pins();
fs.writeFileSync(
  path.join(proof, "source-before.json"),
  `${JSON.stringify({ engine: { node: process.version, v8: process.versions.v8, icu: process.versions.icu, locale: Intl.Collator().resolvedOptions().locale }, sourceHashes: beforePins, inputs: projectOrderingCases, NativeProjectionStarted: false, CargoSelections: 0, runtime }, null, 2)}\n`,
);

function write(directory, name, text) {
  const file = path.join(directory, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
function snapshot(directory) {
  const out = {};
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const file = path.join(dir, entry.name),
        name = path.relative(directory, file);
      if (entry.isDirectory()) visit(file);
      else if (entry.isSymbolicLink())
        out[name] = { symlink: fs.readlinkSync(file) };
      else {
        const stat = fs.statSync(file);
        try {
          out[name] = {
            base64: fs.readFileSync(file).toString("base64"),
            mode: stat.mode & 0o777,
            bytes: stat.size,
          };
        } catch (error) {
          out[name] = {
            readError: {
              name: error.name,
              message: error.message,
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
    Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}
const rows = [],
  setup = [],
  allProcesses = [];
function execute(input, directory, action = null) {
  const name = `${input.id}${action ? "." + action.id : ""}`;
  const saved = path.join(proof, "processes", name);
  fs.mkdirSync(saved, { recursive: true });
  const response = path.join(saved, "response.json");
  const packet = { input, directory, response, ...(action ? { action } : {}) };
  const request = path.join(saved, "request.json");
  fs.writeFileSync(request, `${JSON.stringify(packet, null, 2)}\n`);
  const command = [
    node,
    "--import",
    path.join(root, "verification/parity/node_modules/tsx/dist/loader.mjs"),
    path.join(root, "verification/parity/project-ordering-reference.mjs"),
    request,
  ];
  const env = {
    ...process.env,
    PATH: `${path.dirname(node)}${path.delimiter}${process.env.PATH}`,
    TMPDIR: "/private/tmp",
    TSX_DISABLE_CACHE: "1",
  };
  for (const key of [
    "CARGO_TARGET_DIR",
    "DEMLIK_MUTATION_TARGET_DIR",
    "CARGO_BUILD_TARGET_DIR",
    "CARGO_BUILD_BUILD_DIR",
  ])
    delete env[key];
  const result = spawnSync(command[0], command.slice(1), {
    cwd: directory,
    env,
    encoding: "utf8",
    timeout: 120000,
    maxBuffer: 32 * 1024 * 1024,
  });
  fs.writeFileSync(path.join(saved, "source.stdout"), result.stdout ?? "");
  fs.writeFileSync(path.join(saved, "source.stderr"), result.stderr ?? "");
  const proc = {
    command,
    cwd: directory,
    status: result.status,
    signal: result.signal,
    error: result.error?.message ?? null,
    request,
    requestSHA256: hashFile(request),
    response,
    stdout: path.join(saved, "source.stdout"),
    stdoutSHA256: hashFile(path.join(saved, "source.stdout")),
    stderr: path.join(saved, "source.stderr"),
    stderrSHA256: hashFile(path.join(saved, "source.stderr")),
  };
  allProcesses.push(proc);
  fs.writeFileSync(
    path.join(saved, "process.json"),
    `${JSON.stringify(proc, null, 2)}\n`,
  );
  assert.equal(result.signal, null);
  assert.ifError(result.error);
  assert.ok(
    fs.existsSync(response),
    `${name}: response absent (exit ${result.status}): ${result.stderr}`,
  );
  const body = JSON.parse(fs.readFileSync(response, "utf8"));
  const expectedStatus = action ? body.view.exitCode : 0;
  assert.equal(
    result.status,
    expectedStatus,
    `${name}: unexpected process status`,
  );
  if (!action) {
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  }
  return { body, process: { ...proc, responseSHA256: hashFile(response) } };
}
function anchors(input, value) {
  const v = value.view.output;
  switch (input.id) {
    case "visible-git-filtering":
      assert.deepEqual(v.sources, [
        "source-link.ts",
        "src/kept.ts",
        "src/next.tsx",
      ]);
      break;
    case "visible-walk-prune":
      assert.deepEqual(v.sources, ["src/a.ts", "src/b.tsx"]);
      break;
    case "visible-predicate-stat-order":
      assert.deepEqual(
        v.seen,
        input.listing.map((file) => ({
          file,
          keep: !input.reject.includes(file),
        })),
      );
      assert.deepEqual(v.files, ["a.ts", "z.ts"]);
      break;
    case "visible-scalar-numeric":
      assert.ok(v.sources.indexOf("a10.ts") < v.sources.indexOf("a2.ts"));
      break;
    case "visible-equivalent-duplicates":
      assert.deepEqual(v, ["a.ts", "é.ts", "e\u0301.ts", "é.ts"]);
      break;
    case "visible-empty":
      assert.deepEqual(v.sources, []);
      break;
    case "visible-singleton":
      assert.deepEqual(v.sources, ["only.ts"]);
      break;
    case "cheap-interleaved-failures":
      assert.deepEqual(v.value.parseFailures, [
        "a10.ts",
        "é.ts",
        "e\u0301.ts",
        "Z.ts",
      ]);
      assert.deepEqual(
        v.value.sourceFiles.map((f) => f.file),
        ["a2.ts", "m.ts"],
      );
      break;
    case "cheap-equivalent-failure-duplicates":
      assert.deepEqual(v.value.parseFailures, ["é.ts", "e\u0301.ts", "é.ts"]);
      break;
    case "cheap-bom-unreadable":
      assert.ok(v.value.parseFailures.includes("bad.ts"));
      assert.ok(
        v.value.sourceFiles
          .find((f) => f.file === "bom.ts")
          .text.startsWith("export"),
      );
      break;
    case "edge-package-no-config":
      assert.equal(v.ok, false);
      assert.ok(v.error.message.includes("no tsconfig.json found"));
      break;
    case "edge-deep-scope-guard":
      assert.equal(v[0].result.ok, false);
      assert.equal(v[1].result.ok, true);
      break;
    case "edge-config-loaded":
      assert.equal(v.ok, true);
      assert.deepEqual(v.value.parseFailures, ["z.ts"]);
      assert.deepEqual(
        v.value.sourceFiles.map((f) => f.file),
        ["a.ts"],
      );
      break;
    case "package-roots-final-utf16":
      assert.deepEqual(v, [
        "",
        "packages/bad",
        "packages/z",
        "packages/𐀀",
        "packages/\ue000",
      ]);
      break;
    case "package-workspace-first-wins":
      assert.equal(
        v.packages.find(([name]) => name === "@fixture/same")[1].dir,
        "packages/𐀀",
      );
      break;
    case "catalog-config-first-error":
      assert.equal(v.catalog.ok, false);
      assert.equal(v.catalog.error.name, "TypeError");
      assert.equal(
        v.catalog.error.message,
        "Cannot read properties of null (reading 'prototype')",
      );
      break;
    case "hexagon-layout-ports-lexical":
      assert.equal(v.report.ok, true);
      assert.deepEqual(
        v.report.value.useCases.map((c) => c.file),
        ["application/bad.ts", "application/𐀀.ts", "application/\ue000.ts"],
      );
      assert.equal(v.report.value.notRead[0].file, "application/bad.ts");
      break;
  }
}
try {
  for (const input of projectOrderingCases) {
    const directory = path.join(runtime, input.id);
    fs.mkdirSync(directory);
    for (const [file, text] of Object.entries(input.files))
      write(directory, file, text);
    for (const [file, target] of Object.entries(input.symlinks ?? {}))
      fs.symlinkSync(target, path.join(directory, file));
    if (input.git) {
      for (const args of [
        ["init", "-q"],
        ["add", "--", ...input.tracked],
      ]) {
        const result = spawnSync("git", args, {
          cwd: directory,
          encoding: "utf8",
        });
        setup.push({
          command: ["git", ...args],
          cwd: directory,
          status: result.status,
          stdout: result.stdout,
          stderr: result.stderr,
          error: result.error?.message ?? null,
        });
        assert.equal(result.status, 0, result.stderr);
      }
    }
    for (const [file, mode] of Object.entries(input.modes ?? {}))
      fs.chmodSync(path.join(directory, file), mode);
    const before = snapshot(directory);
    let observation;
    if (input.mode === "cli") {
      observation = [];
      for (const action of input.actions) {
        for (const file of action.remove ?? [])
          fs.unlinkSync(path.join(directory, file));
        const start = snapshot(directory),
          measured = execute(input, directory, action);
        observation.push({
          id: action.id,
          ...measured.body,
          stdout: fs.readFileSync(measured.process.stdout, "utf8"),
          stderr: fs.readFileSync(measured.process.stderr, "utf8"),
          process: measured.process,
          before: start,
          after: snapshot(directory),
        });
        fs.writeFileSync(
          path.join(proof, `${input.id}.${action.id}.workflow.json`),
          `${JSON.stringify(observation.at(-1), null, 2)}\n`,
        );
      }
      if (input.id === "cli-cheap-load-render") {
        assert.equal(observation[1].view.exitCode, 4);
        assert.ok(
          fs
            .readFileSync(path.join(directory, "plan.txt"), "utf8")
            .endsWith("\n"),
        );
      }
      if (input.id === "cli-edge-late-priority") {
        assert.equal(observation[0].view.exitCode, 0);
        const graph = JSON.parse(observation[0].stdout);
        assert.equal(graph.root, ".");
        assert.equal(graph.provenance.pass, "edges");
        assert.equal(observation[2].view.exitCode, 2);
      }
    } else {
      const measured = execute(input, directory);
      anchors(input, measured.body);
      observation = { ...measured.body, process: measured.process };
    }
    const after = snapshot(directory);
    if (input.mode !== "cli")
      assert.deepEqual(
        after,
        before,
        input.id + ": Source changed input files",
      );
    rows.push({ id: input.id, input, directory, before, after, observation });
    fs.writeFileSync(
      path.join(proof, "source-first.partial.json"),
      `${JSON.stringify({ rows, setup, complete: false, NativeProjectionStarted: false }, null, 2)}\n`,
    );
    console.log(input.id, "PASS");
  }
  assert.equal(rows.length, 20);
  assert.deepEqual(pins(), beforePins);
  const report = {
    SourceGit: "75de37ea01a81cd7949e6275b7ee9cfdeb4e312d",
    base: "7e0c1894ca5f443315fd5b5b7d64872622ef1d71",
    engine: {
      node: process.version,
      v8: process.versions.v8,
      icu: process.versions.icu,
      locale: Intl.Collator().resolvedOptions().locale,
    },
    sourceHashes: beforePins,
    runtime,
    rows,
    setup,
    processes: allProcesses,
    complete: true,
    NativeProjectionStarted: false,
    NativeExecutions: 0,
    CargoSelections: 0,
    IcuPreparations: 0,
    newSharedCredit: 0,
    limits: [
      "Source-host IO receipts are not a syscall-equivalence claim for native or Go.",
      "Typed projection compares the complete declared view; original exception stacks remain retained as Source data.",
      "UTF16/path/permission host scopes remain explicit; no arbitrary comparator or prototype replacement.",
    ],
  };
  fs.writeFileSync(
    path.join(proof, "source-first.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(proof, "fixture-setup.json"),
    `${JSON.stringify({ runtime, setup, retainedSourceFixtures: true }, null, 2)}\n`,
  );
  console.log(
    JSON.stringify({
      SourceWholeviews: 20,
      SourceProcesses: allProcesses.length,
      NativeExecutions: 0,
      newSharedCredit: 0,
    }),
  );
} catch (error) {
  fs.writeFileSync(
    path.join(proof, "source-failure.json"),
    `${JSON.stringify({ name: error.name, message: error.message, stack: error.stack, rows: rows.length, processes: allProcesses, runtime, NativeProjectionStarted: false, newSharedCredit: 0 }, null, 2)}\n`,
  );
  throw error;
}
