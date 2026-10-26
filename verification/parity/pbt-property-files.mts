import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";

const sourceOutput = z
  .object({
    before: z.array(z.string()),
    after: z.array(z.string()),
    status: z.string(),
    diagnostics: z.unknown(),
  })
  .strict();
const nativeOutput = z
  .object({
    before: z.array(z.string()),
    after: z.array(z.string()),
    sameFiles: z.boolean(),
    actual: z
      .object({
        comparison: z.object({ status: z.string() }).passthrough(),
        observedRustCalls: z.array(z.string()),
      })
      .passthrough(),
  })
  .strict();
export function pbtPropertyFiles(options: {
  binary: string;
  reportFile?: string;
}) {
  const dir = mkdtempSync(join(tmpdir(), "demlik-pbt-files-")),
    sourceDir = join(dir, "source"),
    nativeDir = join(dir, "native");
  mkdirSync(sourceDir);
  mkdirSync(nativeDir);
  try {
    const program = `import {executePbtProperty} from ${JSON.stringify(pathToFileURL(resolve("verification/parity/pbt-property-reference.mts")).href)};import{readdirSync}from'node:fs';const before=readdirSync('.');const actual=executePbtProperty({kind:'property',form:'reducer',initDelta:0,bootCommand:true,terminalRefuses:false,predicate:{kind:'false',at:0},runs:1,messages:[{op:'add',by:1}]});console.log(JSON.stringify({before,after:readdirSync('.'),status:actual.comparison.status,diagnostics:actual.diagnostics}));`;
    const commands = [
      {
        command: [
          process.execPath,
          "--import",
          resolve("verification/parity/node_modules/tsx/dist/loader.mjs"),
          "--input-type=module",
          "-e",
          program,
        ],
        cwd: sourceDir,
      },
      { command: [resolve(options.binary), "--no-files"], cwd: nativeDir },
    ];
    const children = commands.map((c) => {
      const child = spawnSync(c.command[0], c.command.slice(1), {
        cwd: c.cwd,
        encoding: "utf8",
      });
      assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
      return {
        ...c,
        exit: child.status,
        stdout: child.stdout,
        stderr: child.stderr,
      };
    });
    const source = sourceOutput.parse(JSON.parse(children[0].stdout)),
      native = nativeOutput.parse(JSON.parse(children[1].stdout));
    const sourceView = {
        before: source.before,
        after: source.after,
        status: source.status,
      },
      nativeView = {
        before: native.before,
        after: native.after,
        status: native.actual.comparison.status,
      };
    let equal = true;
    try {
      assert.deepEqual(nativeView, sourceView);
    } catch {
      equal = false;
    }
    const report = {
      id: "pbt-property.no-regression-files",
      equal,
      reference: sourceView,
      native: nativeView,
      observedRustCalls: native.actual.observedRustCalls,
      sourceDiagnostics: source.diagnostics,
      commands: children,
      binary: {
        path: options.binary,
        sha256: createHash("sha256")
          .update(readFileSync(options.binary))
          .digest("hex"),
      },
    };
    const file = options.reportFile ?? "target/parity/pbt-property-files.json";
    mkdirSync(dirname(resolve(file)), { recursive: true });
    writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
    return report;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const { values } = parseArgs({
    options: { "native-bin": { type: "string" }, report: { type: "string" } },
    strict: true,
  });
  assert(values["native-bin"]);
  const r = pbtPropertyFiles({
    binary: values["native-bin"],
    reportFile: values.report,
  });
  console.log(JSON.stringify({ equal: r.equal, id: r.id }));
  if (!r.equal) process.exitCode = 1;
}
