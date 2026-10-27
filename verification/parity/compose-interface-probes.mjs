import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { assertCheckPath, cargoCheckEnvironment } from "./check-worktree.mjs";

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
    {
      id: "compose.empty-order-needs-item-type",
      kind: "inference-annotation",
      source: `${source}\nfn empty_untyped(input:&Query<'_>){let _:Result<&Query<'_>,Infallible>=demlik_tea::read_in_order(input,[],input);}\n`,
      ok: false,
      needles: ["type annotations needed", "type parameter `T`"],
      codes: ["E0283"],
    },
    {
      id: "compose.Ok-only-needs-error-type",
      kind: "inference-annotation",
      source: `${source}\nfn ok_untyped(input:&Query<'_>){let reader=ReadStep{name:"ok".into(),read:Box::new(|_:&Query<'_>|Ok(Some(17u8)))};let _=demlik_tea::read_in_order(input,[reader],0u8);}\n`,
      ok: false,
      needles: ["type annotations needed", "Result<u8, _>"],
      codes: ["E0282"],
    },
  ];
}
export function composeInterfaceProbes({
  check,
  rlib,
  dependencies,
  reportFile,
} = {}) {
  assert(
    check && rlib && dependencies && reportFile,
    "Supply the owning check, immutable actual Cargo library and its dependency directory",
  );
  const sourceFile = assertCheckPath(join(check.root, sourcePath), check.root);
  assertCheckPath(dependencies, check.target);
  mkdirSync(check.target, { recursive: true });
  const source = readFileSync(sourceFile, "utf8"),
    temporary = mkdtempSync(join(check.target, "compose-interface-types-")),
    results = [];
  const evidence = dirname(resolve(reportFile));
  const proofPath = relative(check.root, evidence);
  assert(
    proofPath === ".." ||
      proofPath.startsWith(`..${sep}`) ||
      isAbsolute(proofPath),
    "proof must outlive the check",
  );
  mkdirSync(evidence, { recursive: true });
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
        cwd: check.root,
        env: cargoCheckEnvironment(),
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      });
      let run;
      if (p.ok && compiled.status === 0) {
        const r = spawnSync(executable, [], {
          cwd: check.root,
          env: cargoCheckEnvironment(),
          encoding: "utf8",
        });
        const saved = join(evidence, `${p.id}.bin`);
        copyFileSync(assertCheckPath(executable, check.target), saved);
        run = {
          exit: r.status,
          signal: r.signal,
          error: r.error?.message,
          stdout: r.stdout,
          stderr: r.stderr,
          binary: { path: saved, sha256: hash(readFileSync(saved)) },
        };
      }
      results.push({
        ...p,
        command: [compiler, ...args],
        exit: compiled.status,
        signal: compiled.signal,
        error: compiled.error?.message,
        stdout: compiled.stdout,
        stderr: compiled.stderr,
        run,
      });
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  const failures = results.flatMap((r) => {
    if (r.ok)
      return r.exit === 0 &&
        !r.signal &&
        !r.error &&
        r.run?.exit === 0 &&
        !r.run.signal &&
        !r.run.error
        ? []
        : [r.id];
    return r.exit === 1 &&
      !r.signal &&
      !r.error &&
      r.needles.every((n) => r.stderr.includes(n)) &&
      (!r.codes || r.codes.some((c) => r.stderr.includes(c)))
      ? []
      : [r.id];
  });
  const report = {
    scope:
      "Interface proof only; no Source/native semantic comparison or mutation controls",
    source: {
      path: sourceFile,
      relativePath: sourcePath,
      sha256: hash(source),
    },
    outputDirectory: temporary,
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
  throw new Error(
    "Compose type probes require an owning check; run compose-checks-run.mjs",
  );
}
