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

const sourcePath = "crates/tea/examples/pbt_constructors_interface.rs";
const hash = (value) => createHash("sha256").update(value).digest("hex");
function probes(source) {
  return [
    { id: "pbt-constructors.borrowed-opaque-positive", source, ok: true },
    {
      id: "pbt-constructors.wrong-constructor-input",
      source: `${source}\nfn wrong_input(){let _=demlik_tea::pbt::record_msg(proptest::strategy::Just(7u8),|_:String|Msg::Start);}\n`,
      ok: false,
      codes: ["E0631"],
      needles: ["u8", "String", "record_msg"],
    },
    {
      id: "pbt-constructors.wrong-constructor-output",
      source: `${source}\nfn wrong_output(){let _=demlik_tea::pbt::record_msg::<_,Msg<'static>>(proptest::strategy::Just(7u8),|_|17u8);}\n`,
      ok: false,
      codes: ["E0308"],
      needles: ["Msg", "u8", "expected"],
    },
    {
      id: "pbt-constructors.generated-message-needs-debug",
      source: `${source}\nstruct NotDebug;impl demlik_tea::Tagged for NotDebug{fn tag(&self)->&str{"opaque"}}fn wrong_debug(){let _=demlik_tea::pbt::constant_msg(NotDebug);let _=demlik_tea::pbt::record_msg(proptest::strategy::Just(7u8),|_|NotDebug);}\n`,
      ok: false,
      codes: ["E0277"],
      needles: ["NotDebug", "Debug", "constant_msg", "record_msg"],
    },
    {
      id: "pbt-constructors.FnMut-constructor-refused",
      source: `${source}\nfn wrong_fn_mut(){let mut total=0u8;let build=|at:u8|{total+=at;Msg::Start};let _=demlik_tea::pbt::record_msg(proptest::strategy::Just(7u8),build);}\n`,
      ok: false,
      codes: ["E0525"],
      needles: ["FnMut", "Fn", "record_msg"],
    },
  ];
}
export function pbtConstructorsInterfaceProbes({
  teaLibrary,
  proptestLibrary,
  dependencies,
  reportFile = "target/parity/pbt-constructors-interface-probes.json",
} = {}) {
  assert(
    teaLibrary && proptestLibrary && dependencies,
    "Supply immutable tea/proptest libraries selected from actual Cargo JSON, and their dependency directory",
  );
  const source = readFileSync(sourcePath, "utf8"),
    temporary = mkdtempSync(join(tmpdir(), "demlik-pbt-constructors-types-")),
    results = [];
  const compiler =
    process.env.RUSTC ??
    (process.env.CARGO ? join(dirname(process.env.CARGO), "rustc") : "rustc");
  try {
    for (const probe of probes(source)) {
      const file = join(temporary, `${probe.id}.rs`),
        executable = join(temporary, probe.id);
      writeFileSync(file, probe.source);
      const args = [
        "--edition",
        "2024",
        "--crate-name",
        "pbt_constructors_interface_probe",
        file,
        "-C",
        "debuginfo=0",
        "-L",
        `dependency=${dependencies}`,
        "--extern",
        `demlik_tea=${teaLibrary}`,
        "--extern",
        `proptest=${proptestLibrary}`,
        "-o",
        executable,
      ];
      const compiled = spawnSync(compiler, args, {
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
      });
      let run;
      if (probe.ok && compiled.status === 0) {
        const r = spawnSync(executable, [], { encoding: "utf8" });
        run = { exit: r.status, stdout: r.stdout, stderr: r.stderr };
      }
      results.push({
        ...probe,
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
  const failures = results.flatMap((result) => {
    if (result.ok)
      return result.exit === 0 && result.run?.exit === 0 ? [] : [result.id];
    return result.exit === 1 &&
      result.needles.every((n) => result.stderr.includes(n)) &&
      result.codes.some((code) => result.stderr.includes(code))
      ? []
      : [result.id];
  });
  const report = {
    scope:
      "Two-constructor interface/type proof only; no Source/native semantic pairs or mutation controls",
    source: { path: sourcePath, sha256: hash(source) },
    libraries: {
      tea: {
        path: resolve(teaLibrary),
        sha256: hash(readFileSync(teaLibrary)),
      },
      proptest: {
        path: resolve(proptestLibrary),
        sha256: hash(readFileSync(proptestLibrary)),
      },
      dependencies: resolve(dependencies),
    },
    results,
    failures,
    semanticPairs: 0,
    qualifications: [
      "Generated M and fields strategy values need Debug at the Proptest boundary; opaque payloads/context/typed predicate E need no Debug/Clone/serde/Send/static.",
      "Native authored enum constructors own tags; no JS record reflection/UTF16 tag/global clone protocol or weighted-table claim.",
      "Proptest seed/shrink/current/diagnostic behavior remains its backend profile; this positive uses fixed fields and actual evaluated owners.",
    ],
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
      "tea-rlib": { type: "string" },
      "proptest-rlib": { type: "string" },
      dependencies: { type: "string" },
      report: { type: "string" },
    },
    strict: true,
  });
  const report = pbtConstructorsInterfaceProbes({
    teaLibrary: values["tea-rlib"],
    proptestLibrary: values["proptest-rlib"],
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
