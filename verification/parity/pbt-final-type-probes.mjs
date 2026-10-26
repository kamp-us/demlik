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

const source = `#![allow(dead_code)]
use demlik_tea::{Machine,Sub,Tagged,pbt::{self,FoldStep,PropertyOptions}};
use proptest::strategy::Strategy;
use std::{rc::Rc,sync::Arc};
struct Model{local:Rc<()>}impl Tagged for Model{fn tag(&self)->&str{"model"}}
struct Msg{local:Rc<()>}impl Tagged for Msg{fn tag(&self)->&str{"msg"}}
impl std::fmt::Debug for Msg{fn fmt(&self,f:&mut std::fmt::Formatter<'_>)->std::fmt::Result{f.write_str("Msg")}}
struct Cmd{local:Rc<()>}
struct Context<'a>{label:&'a str,local:Rc<()>}
struct Cause<'a>{label:&'a str,capability:Box<dyn Fn()+'a>}
fn run<'a>(machine:&Machine<'_,Model,Msg,Cmd,Sub,Context<'a>>,ctx:&Context<'a>,strategy:&impl Strategy<Value=Vec<Arc<Msg>>>,label:&'a str){
 let terminal=|_:&Model|Err::<bool,_>(Cause{label,capability:Box::new(||{})});
 let trace=|_:&[FoldStep<Model,Msg,Cmd>],_:&Model|Err::<bool,_>(Cause{label,capability:Box::new(||{})});
 let _=pbt::property_terminates(machine,ctx,strategy,||None,terminal,PropertyOptions::default());
 let _=pbt::property_trace(machine,ctx,strategy,||None,trace,PropertyOptions::default());
}
`;
const probes = [
  { id: "pbt-final.opaque-borrowed-positive", source, ok: true },
  {
    id: "pbt-final.terminal-gets-model",
    source: source.replace("let terminal=|_:&Model|", "let terminal=|_:&Msg|"),
    ok: false,
    code: "E0631",
    needle: "Model",
  },
  {
    id: "pbt-final.trace-final-is-model",
    source: source.replace(
      "let trace=|_:&[FoldStep<Model,Msg,Cmd>],_:&Model|",
      "let trace=|_:&[FoldStep<Model,Msg,Cmd>],_:&Msg|",
    ),
    ok: false,
    code: "E0631",
    needle: "Model",
  },
  {
    id: "pbt-final.generated-message-needs-debug",
    source: source.replace(/impl std::fmt::Debug for Msg\{[^\n]*\}\n/, ""),
    ok: false,
    code: "E0277",
    needle: "Debug",
  },
];
const hash = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
export function pbtFinalTypeProbes({
  rlib,
  proptestRlib,
  reportFile = "target/parity/pbt-final-types.json",
} = {}) {
  assert(
    rlib && proptestRlib,
    "Supply both actual Cargo JSON library artifacts",
  );
  const compiler =
    process.env.RUSTC ??
    (process.env.CARGO ? join(dirname(process.env.CARGO), "rustc") : "rustc");
  const dir = mkdtempSync(join(tmpdir(), "demlik-pbt-final-types-")),
    results = [];
  try {
    for (const p of probes) {
      const file = join(dir, `${p.id}.rs`);
      writeFileSync(file, p.source);
      const args = [
        "--edition",
        "2024",
        "--crate-type",
        "lib",
        "--crate-name",
        "pbt_final_probe",
        file,
        "--out-dir",
        dir,
        "-L",
        `dependency=${dirname(rlib)}`,
        "-L",
        `dependency=${dirname(proptestRlib)}`,
        "--extern",
        `demlik_tea=${rlib}`,
        "--extern",
        `proptest=${proptestRlib}`,
      ];
      const run = spawnSync(compiler, args, { encoding: "utf8" });
      assert.equal(run.status, p.ok ? 0 : 1, `${p.id}\n${run.stderr}`);
      if (!p.ok) {
        assert(run.stderr.includes(p.code));
        assert(run.stderr.includes(p.needle));
      }
      results.push({
        ...p,
        command: [compiler, ...args],
        exit: run.status,
        stdout: run.stdout,
        stderr: run.stderr,
      });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const report = {
    libraries: {
      tea: { path: rlib, sha256: hash(rlib) },
      proptest: { path: proptestRlib, sha256: hash(proptestRlib) },
    },
    results,
    semanticCases: 0,
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
      "proptest-rlib": { type: "string" },
      report: { type: "string" },
    },
    strict: true,
  });
  const r = pbtFinalTypeProbes({
    rlib: values.rlib,
    proptestRlib: values["proptest-rlib"],
    reportFile: values.report,
  });
  console.log(
    JSON.stringify({ probes: r.results.length, passed: r.results.length }),
  );
}
