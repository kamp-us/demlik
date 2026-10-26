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

const prelude = `#![allow(dead_code)]
use demlik_tea::{Machine,Sub,Tagged,pbt::{self,PropertyOptions,SequenceOptions}};
use proptest::strategy::Strategy;
use std::{rc::Rc,sync::Arc};
struct Model{local:Rc<()>} impl Tagged for Model{fn tag(&self)->&str{"model"}}
struct Msg{local:Rc<()>} impl Tagged for Msg{fn tag(&self)->&str{"msg"}}
impl std::fmt::Debug for Msg{fn fmt(&self,f:&mut std::fmt::Formatter<'_>)->std::fmt::Result{f.write_str("Msg")}}
struct Cmd{local:Rc<()>}
struct Context<'a>{borrowed:&'a str,local:Rc<()>}
struct Cause<'a>{borrowed:&'a str,capability:Box<dyn Fn()+'a>}
fn run<'a>(machine:&Machine<'_,Model,Msg,Cmd,Sub,Context<'a>>,ctx:&Context<'a>,messages:&impl Strategy<Value=Vec<Arc<Msg>>>,label:&'a str){
 let result=pbt::property_invariant(machine,ctx,messages,||None,|_|Err(Cause{borrowed:label,capability:Box::new(||{})}),PropertyOptions::default());
 let _=format!("{:?}",result.unwrap_err());
 }
struct BorrowedMsg<'a>{text:&'a str,local:Rc<()>}
impl Tagged for BorrowedMsg<'_>{fn tag(&self)->&str{"borrowed"}}
impl std::fmt::Debug for BorrowedMsg<'_>{fn fmt(&self,f:&mut std::fmt::Formatter<'_>)->std::fmt::Result{f.write_str(self.text)}}
fn borrowed_sequence(text:&str){let strategy=proptest::strategy::Just(Arc::new(BorrowedMsg{text,local:Rc::new(())}));let _=pbt::msg_sequence(strategy,SequenceOptions::default());}
`;
const probes = [
  { id: "pbt.opaque-borrowed-positive", source: prelude, ok: true },
  {
    id: "pbt.generated-message-needs-debug",
    source: prelude.replace(/impl std::fmt::Debug for Msg\{[^\n]*\}\n/, ""),
    ok: false,
    needle: "Debug",
    code: "E0277",
  },
  {
    id: "pbt.strategy-needs-shared-message-values",
    source: prelude.replace(
      "Strategy<Value=Vec<Arc<Msg>>>",
      "Strategy<Value=Vec<Msg>>",
    ),
    ok: false,
    needle: "Vec<Arc<Msg>>",
    code: "E0271",
  },
  {
    id: "pbt.sequence-payload-type-is-preserved",
    source: `${prelude}impl std::fmt::Debug for Model{fn fmt(&self,f:&mut std::fmt::Formatter<'_>)->std::fmt::Result{f.write_str("Model")}}
fn bad(message:impl Strategy<Value=Arc<Msg>>){let _:proptest::strategy::BoxedStrategy<Vec<Arc<Model>>>=pbt::msg_sequence(message,SequenceOptions::default()).boxed();}\n`,
    ok: false,
    needle: "Arc<Model>",
    code: "E0308",
  },
];
const digest = (x) => createHash("sha256").update(x).digest("hex");
export function pbtPropertyTypeProbes({
  rlib,
  proptestRlib,
  reportFile = "target/parity/pbt-property-type-probes.json",
} = {}) {
  assert(
    rlib && proptestRlib,
    "Actual feature-enabled Cargo artifact rlibs must be supplied explicitly",
  );
  const compiler =
    process.env.RUSTC ??
    (process.env.CARGO ? join(dirname(process.env.CARGO), "rustc") : "rustc");
  const dir = mkdtempSync(join(tmpdir(), "demlik-pbt-types-"));
  const results = [];
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
        "pbt_type_probe",
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
      const child = spawnSync(compiler, args, { encoding: "utf8" });
      assert.equal(child.status === 0, p.ok, `${p.id}\n${child.stderr}`);
      if (p.code)
        assert(
          child.stderr.includes(`error[${p.code}]`),
          `${p.id}: wrong diagnostic code\n${child.stderr}`,
        );
      if (p.needle)
        assert(
          child.stderr.includes(p.needle),
          `${p.id}: wrong refusal\n${child.stderr}`,
        );
      results.push({
        ...p,
        command: [compiler, ...args],
        exit: child.status,
        stdout: child.stdout,
        stderr: child.stderr,
        sourceSha256: digest(p.source),
      });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const report = {
    rlib: { path: rlib, sha256: digest(readFileSync(rlib)) },
    proptestRlib: {
      path: proptestRlib,
      sha256: digest(readFileSync(proptestRlib)),
    },
    results,
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
  const r = pbtPropertyTypeProbes({
    rlib: values.rlib,
    proptestRlib: values["proptest-rlib"],
    reportFile: values.report,
  });
  console.log(
    JSON.stringify({
      probes: r.results.length,
      positive: r.results.filter((p) => p.ok).length,
      refusals: r.results.filter((p) => !p.ok).length,
    }),
  );
}
