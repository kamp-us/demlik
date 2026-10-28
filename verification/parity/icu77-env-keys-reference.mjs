import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseTypeScript } from "../../packages/code-graph/src/engine/oxc.js";
import { scanEnvKeys } from "../../packages/code-graph/src/env-keys/extract.js";
import {
  findEnvKeyMismatches,
  loadEnvKeyReport,
} from "../../packages/code-graph/src/env-keys/query.js";
import { loadCheapProject } from "../../packages/code-graph/src/extract/project.js";
import { loadBindingCatalog } from "../../packages/code-graph/src/extract/wrangler-config.js";
import { renderEnvKeys } from "../../packages/code-graph/src/render/analysis.js";
import { SyntaxFile } from "../../packages/code-graph/src/syntax/file.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const require = createRequire(import.meta.url);
export const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const sourcePaths = [
  "env-keys/extract.ts",
  "env-keys/query.ts",
  "env-keys/read-site-owner.ts",
  "render/analysis.ts",
  "extract/project.ts",
  "extract/wrangler-config.ts",
  "syntax/file.ts",
  "engine/oxc.ts",
  "cli.ts",
  "index.ts",
];
export const sourcePins = () =>
  Object.fromEntries(
    sourcePaths.map((f) => [
      f,
      hash(fs.readFileSync(path.join(root, "packages/code-graph/src", f))),
    ]),
  );
export function snapshot(dir) {
  const rows = [];
  for (const file of fs.readdirSync(dir, { recursive: true })) {
    const absolute = path.join(dir, file);
    if (!fs.statSync(absolute).isFile()) continue;
    rows.push([
      file,
      {
        base64: fs.readFileSync(absolute).toString("base64"),
        mode: fs.statSync(absolute).mode & 0o777,
      },
    ]);
  }
  rows.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return Object.fromEntries(rows);
}
export function restore(dir, files) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const [file, value] of Object.entries(files)) {
    const absolute = path.join(dir, file);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, Buffer.from(value.base64, "base64"), {
      mode: value.mode,
    });
    fs.chmodSync(absolute, value.mode);
  }
}
export function view(report) {
  return {
    report,
    text: renderEnvKeys(report, false, false),
    json: renderEnvKeys(report, true, false),
    pretty: renderEnvKeys(report, true, true),
  };
}
export function reference(input, directory) {
  try {
    if (input.mode === "load") {
      const report = loadEnvKeyReport(directory, directory);
      return { ok: true, output: view(report) };
    }
    const units = input.units.map((u) => {
      if (u.alias !== undefined) return null;
      const parsed = parseTypeScript(path.join(directory, u.file), u.text);
      assert.equal(parsed.ok, true, u.file);
      return {
        file: u.file,
        absolutePath: path.join(directory, u.file),
        syntax: new SyntaxFile(u.text, parsed.program, parsed.comments),
      };
    });
    for (const [i, u] of input.units.entries())
      if (u.alias !== undefined) {
        assert(u.alias < i);
        units[i] = units[u.alias];
      }
    const identities = units.map((u) =>
      units.flatMap((other, i) => (other === u ? [i] : [])),
    );
    const before = [...units];
    const catalog =
      input.mode === "query" ? loadBindingCatalog(directory) : null;
    const candidates =
      catalog === null
        ? input.candidates
        : catalog.manifests.flatMap((m) => [...m.envKeys, ...m.devVarsKeys]);
    const scan = scanEnvKeys(units, new Set(candidates));
    assert(units.every((u, i) => u === before[i]));
    const output = {
      scan: { reads: scan.reads, occursIn: [...scan.occursIn] },
      identity: {
        groups: identities,
        unchanged: units.every((u, i) => u === before[i]),
      },
    };
    if (catalog !== null)
      output.report = view(findEnvKeyMismatches(catalog, scan));
    return { ok: true, output };
  } catch (error) {
    return { ok: false, error: { name: error.name, message: error.message } };
  }
}
export function cliReference(input, directory, files, saved) {
  const results = [];
  let state = files;
  for (const action of input.actions) {
    restore(directory, state);
    const before = snapshot(directory);
    const packet = path.join(saved, `${action.id}.packet.json`);
    fs.writeFileSync(
      packet,
      JSON.stringify({
        index: path.join(root, "packages/code-graph/src/index.ts"),
        argv: [directory, "--env-keys", ...action.flags],
        ...(action.initial === undefined ? {} : { initial: action.initial }),
      }),
    );
    const p = spawnSync(
      process.execPath,
      [
        "--import",
        require.resolve("tsx"),
        path.join(root, "verification/parity/icu77-env-keys-source-cli.mjs"),
        packet,
      ],
      {
        cwd: directory,
        env: { ...process.env, PATH: "/nonexistent" },
        encoding: "utf8",
        maxBuffer: 16 << 20,
      },
    );
    const after = snapshot(directory);
    fs.writeFileSync(
      path.join(saved, `${action.id}.source-process.json`),
      JSON.stringify(
        {
          status: p.status,
          signal: p.signal,
          stdout: p.stdout,
          stderr: p.stderr,
          before,
          after,
        },
        null,
        2,
      ),
    );
    assert.ifError(p.error);
    assert.equal(p.signal, null);
    assert.equal(p.status, action.code ?? action.initial ?? 0, action.id);
    results.push({
      id: action.id,
      process: {
        status: p.status,
        signal: p.signal,
        stdout: p.stdout,
        stderr: p.stderr,
      },
      before,
      after,
    });
    state = after;
  }
  return { ok: true, output: results };
}
export function sourceOnly() {
  const via = ["env", "process-env"],
    reasons = [
      "occurs-elsewhere-in-source",
      "read-site-owner-unknown",
      "read-site-owner-unparsed",
    ];
  const pairs = (values) =>
    values.flatMap((a) =>
      values.map((b) => ({
        a,
        b,
        locale: Math.sign(a.localeCompare(b)),
        ordinal: a < b ? -1 : a > b ? 1 : 0,
      })),
    );
  const closed = { via: pairs(via), reasons: pairs(reasons) };
  assert(
    Object.values(closed)
      .flat()
      .every((p) => p.locale === p.ordinal),
  );
  const catalog = {
    manifests: [
      {
        service: "worker",
        dir: "worker",
        configFile: "worker/wrangler.jsonc",
        main: null,
        bindings: [],
        dataBindings: [],
        envKeys: [],
        bindingNames: [],
        devVarsKeys: [],
        devVarsFiles: [],
      },
    ],
    unparsedConfigs: [],
  };
  const numbers = [NaN, Infinity, -Infinity, -0, 1];
  const report = findEnvKeyMismatches(catalog, {
    reads: numbers.map((line) => ({
      name: "KEY",
      file: "worker/a.ts",
      line,
      via: "env",
    })),
    occursIn: new Map(),
  });
  let malformed;
  try {
    findEnvKeyMismatches(catalog, { reads: null, occursIn: new Map() });
  } catch (error) {
    malformed = { name: error.name, message: error.message };
  }
  return {
    closed,
    rawNumbers: {
      input: numbers.map((n) => (Object.is(n, -0) ? "-0" : String(n))),
      output: report.readNotDeclared.map((r) =>
        Object.is(r.line, -0) ? "-0" : String(r.line),
      ),
      NativePaired: false,
    },
    malformed: { ...malformed, NativePaired: false },
    NativeCredit: 0,
  };
}
