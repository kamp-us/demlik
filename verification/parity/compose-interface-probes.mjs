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

const sourcePath = "crates/tea/examples/compose_interface.rs";
const hash = (value) => createHash("sha256").update(value).digest("hex");
function probes(source) {
  assert.equal(source.split("Model::with_cache").length, 2);
  return [
    { id: "compose.borrowed-opaque-positive", source, ok: true },
    {
      id: "compose.other-slice-refused",
      source: source.replace("Model::with_cache", "Model::with_pending"),
      ok: false,
      needles: ["Pending", "Cache"],
      codes: ["E0631"],
    },
    {
      id: "compose.read-member-keeps-input",
      source: `${source}\nfn wrong_input<'a>(reader:&ReadStep<'a,'a,Query<'a>,&'a Query<'a>,AppError<'a>>){let _=(reader.read)(&17u8);}\n`,
      ok: false,
      needles: ["Query", "u8"],
      codes: ["E0308"],
    },
    {
      id: "compose.read-keeps-output",
      source: `${source}\nfn wrong_output<'a>(input:&'a Query<'a>,reader:&ReadStep<'a,'a,Query<'a>,&'a Query<'a>,AppError<'a>>)->Result<&'a str,AppError<'a>>{demlik_tea::read_in_order(input,[reader],input)}\n`,
      ok: false,
      needles: ["Query", "str"],
      codes: ["E0308", "E0277"],
    },
    {
      id: "compose.read-keeps-error",
      source: `${source}\nfn wrong_error<'a>(input:&'a Query<'a>,reader:&ReadStep<'a,'a,Query<'a>,&'a Query<'a>,AppError<'a>>)->Result<&'a Query<'a>,&'a str>{demlik_tea::read_in_order(input,[reader],input)}\n`,
      ok: false,
      needles: ["AppError", "str"],
      codes: ["E0308", "E0277"],
    },
    {
      id: "compose.output-cannot-outlive-input",
      source: `${source}\nfn wrong_lifetime<'input,'value>(input:&'input Query<'value>)->&'static Query<'value>{echo(input,&RefCell::new(vec![]))}\n`,
      ok: false,
      needles: ["lifetime may not live long enough", "'input", "'static"],
    },
  ];
}
export function composeInterfaceProbes({
  rlib,
  dependencies,
  reportFile = "target/parity/compose-interface-probes.json",
} = {}) {
  assert(
    rlib && dependencies,
    "Supply an immutable library copied from the actual Cargo JSON artifact and its dependency directory",
  );
  const source = readFileSync(sourcePath, "utf8"),
    temporary = mkdtempSync(join(tmpdir(), "demlik-compose-interface-types-")),
    results = [];
  const compiler =
    process.env.RUSTC ??
    (process.env.CARGO ? join(dirname(process.env.CARGO), "rustc") : "rustc");
  try {
    for (const p of probes(source)) {
      const file = join(temporary, `${p.id}.rs`),
        executable = join(temporary, p.id);
      writeFileSync(file, p.source);
      const args = [
        "--edition",
        "2024",
        "--crate-name",
        "compose_interface_probe",
        file,
        "-C",
        "debuginfo=0",
        "-L",
        `dependency=${dependencies}`,
        "--extern",
        `demlik_tea=${rlib}`,
        "-o",
        executable,
      ];
      const compiled = spawnSync(compiler, args, {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      });
      let run;
      if (p.ok && compiled.status === 0) {
        const r = spawnSync(executable, [], { encoding: "utf8" });
        run = { exit: r.status, stdout: r.stdout, stderr: r.stderr };
      }
      results.push({
        ...p,
        command: [compiler, ...args],
        exit: compiled.status,
        stdout: compiled.stdout,
        stderr: compiled.stderr,
        run,
      });
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  const failures = results.flatMap((r) => {
    if (r.ok) return r.exit === 0 && r.run?.exit === 0 ? [] : [r.id];
    return r.exit === 1 &&
      r.needles.every((n) => r.stderr.includes(n)) &&
      (!r.codes || r.codes.some((c) => r.stderr.includes(c)))
      ? []
      : [r.id];
  });
  const report = {
    scope:
      "Interface proof only; no Source/native semantic comparison or mutation controls",
    source: { path: sourcePath, sha256: hash(source) },
    library: {
      path: resolve(rlib),
      sha256: hash(readFileSync(rlib)),
      dependencies: resolve(dependencies),
    },
    results,
    failures,
    semanticPairs: 0,
  };
  mkdirSync(dirname(resolve(reportFile)), { recursive: true });
  writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const { values } = parseArgs({
    options: {
      rlib: { type: "string" },
      dependencies: { type: "string" },
      report: { type: "string" },
    },
    strict: true,
  });
  const report = composeInterfaceProbes({
    rlib: values.rlib,
    dependencies: values.dependencies,
    reportFile: values.report,
  });
  console.log(
    JSON.stringify({
      probes: report.results.length,
      failures: report.failures,
    }),
  );
  if (report.failures.length) process.exitCode = 1;
}
