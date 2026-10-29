import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertCheckPath,
  cargoCheckEnvironment,
  checkedSpawnSync as spawnSync,
} from "./check-worktree.mjs";

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
  check,
  teaLibrary,
  proptestLibrary,
  dependencies,
  reportFile,
} = {}) {
  assert(
    check && teaLibrary && proptestLibrary && dependencies && reportFile,
    "owning check and immutable actual Cargo Tea/Proptest libraries are required",
  );
  for (const library of [teaLibrary, proptestLibrary])
    assert(
      /^lib.+\.rlib$/.test(path.basename(library)),
      "rustc --extern requires a lib*.rlib filename",
    );
  assertCheckPath(dependencies, check.target);
  const evidence = path.dirname(path.resolve(reportFile));
  const relative = path.relative(path.resolve(check.root), evidence);
  assert(
    relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative),
  );
  fs.mkdirSync(evidence, { recursive: true });
  fs.mkdirSync(check.target, { recursive: true });
  const source = fs.readFileSync(
    assertCheckPath(path.join(check.root, sourcePath), check.root),
    "utf8",
  );
  const temporary = fs.mkdtempSync(
    path.join(check.target, "pbt-constructor-types-"),
  );
  const compiler =
    process.env.RUSTC ??
    (process.env.CARGO
      ? path.join(path.dirname(process.env.CARGO), "rustc")
      : "rustc");
  const results = [];
  try {
    for (const probe of probes(source)) {
      const file = path.join(temporary, `${probe.id}.rs`);
      const executable = path.join(temporary, probe.id);
      fs.writeFileSync(file, probe.source);
      const savedSource = path.join(evidence, `${probe.id}.rs`);
      fs.writeFileSync(savedSource, probe.source);
      const args = [
        "--edition",
        "2024",
        "--crate-name",
        "pbt_constructors_interface_probe",
        file,
        "--error-format=json",
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
        cwd: check.root,
        env: cargoCheckEnvironment(),
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
      });
      const stderr = compiled.stderr ?? "";
      const diagnostics = stderr.split("\n").flatMap((line) => {
        try {
          const row = JSON.parse(line);
          return row.level === "error" && row.code ? [row.code.code] : [];
        } catch {
          return [];
        }
      });
      fs.writeFileSync(path.join(evidence, `${probe.id}.stderr`), stderr);
      fs.writeFileSync(
        path.join(evidence, `${probe.id}.stdout`),
        compiled.stdout ?? "",
      );
      let run;
      if (probe.ok && compiled.status === 0) {
        const r = spawnSync(executable, [], {
          cwd: check.root,
          env: cargoCheckEnvironment(),
          encoding: "utf8",
        });
        const saved = path.join(evidence, `${probe.id}.bin`);
        fs.copyFileSync(assertCheckPath(executable, check.target), saved);
        run = {
          exit: r.status,
          signal: r.signal,
          error: r.error?.message,
          stdout: r.stdout,
          stderr: r.stderr,
          binary: { path: saved, sha256: hash(fs.readFileSync(saved)) },
        };
      }
      results.push({
        ...probe,
        sourceCopy: savedSource,
        sourceSha256: hash(probe.source),
        command: [compiler, ...args],
        cwd: check.root,
        exit: compiled.status,
        signal: compiled.signal,
        error: compiled.error?.message,
        stdout: compiled.stdout,
        stderr,
        diagnostics,
        run,
      });
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
  const failures = results.flatMap((r) => {
    if (r.ok)
      return r.exit === 0 &&
        !r.error &&
        !r.signal &&
        r.run?.exit === 0 &&
        !r.run.error &&
        !r.run.signal
        ? []
        : [r.id];
    return r.exit === 1 &&
      !r.error &&
      !r.signal &&
      r.needles.every((n) => r.stderr.includes(n)) &&
      r.codes.some((c) => r.diagnostics.includes(c))
      ? []
      : [r.id];
  });
  const report = {
    scope:
      "Two-constructor interface/type proof only; no Source/native semantic pairs or mutation controls",
    source: { path: sourcePath, sha256: hash(source) },
    libraries: {
      tea: {
        path: path.resolve(teaLibrary),
        sha256: hash(fs.readFileSync(teaLibrary)),
      },
      proptest: {
        path: path.resolve(proptestLibrary),
        sha256: hash(fs.readFileSync(proptestLibrary)),
      },
      dependencies: path.resolve(dependencies),
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
  fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  throw new Error(
    "Run pbt-constructors-checks-run.mjs: an explicit registered check owns the type inputs/outputs; no standalone fallback",
  );
}
