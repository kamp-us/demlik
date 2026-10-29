import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  checkScratchDirectory,
  checkedSpawnSync as spawnSync,
} from "./check-worktree.mjs";

const prelude = `#![allow(dead_code)]
use demlik_tea::{Machine,Sub,Tagged,testing::{self,BoundMachine,CheckError,ReplayOpts}};
use std::rc::Rc;
struct State{n:u32,local:Rc<()>} impl Tagged for State{fn tag(&self)->&str{"state"}}
struct Msg; impl Tagged for Msg{fn tag(&self)->&str{"msg"}}
struct Cmd{local:Rc<()>}
struct Context{local:Rc<()>}
struct Cause{capability:Box<dyn Fn()>}
`;
const body = `fn channels(machine:&Machine<'_,State,Msg,Cmd,Sub,Context>,ctx:&Context,state:&State,msg:&Msg,cmd:&Cmd){
 let h=testing::bind_machine(machine,ctx);
 let _=h.step(state,msg);
 let _=h.replay(ReplayOpts{loaded:None,msgs:[]});
 let _=h.expect_cmd_emitted(ReplayOpts{loaded:None,msgs:[]},cmd,|_,_|Ok::<_,Cause>(true));
 let cause=Cause{capability:Box::new(||{})};
 let _=h.expect_final_state(ReplayOpts{loaded:None,msgs:[]},state,move|_,_|Err(cause));
}
`;
export function testingHelperTypeProbes({
  rlib,
  dependencyDirectory,
  reportFile = "target/parity/testing-helpers-type-probes.json",
} = {}) {
  assert(rlib, "compiled demlik_tea rlib required");
  rlib = resolve(rlib);
  const rustc =
    process.env.RUSTC ??
    (process.env.CARGO?.startsWith("/")
      ? join(dirname(process.env.CARGO), "rustc")
      : "rustc");
  const temporary = checkScratchDirectory("testing-helpers-type-probes-");
  const programs = [
    { id: "borrowed-opaque-channels", source: prelude + body, expectedExit: 0 },
    {
      id: "wrong-expected-state",
      source:
        prelude + body.replace("msgs:[]},state,move", "msgs:[]},&17_u32,move"),
      expectedCode: "E0308",
    },
    {
      id: "wrong-expected-command",
      source: prelude + body.replace("msgs:[]},cmd,|", "msgs:[]},state,|"),
      expectedCode: "E0308",
    },
    {
      id: "async-comparator",
      source:
        prelude +
        body.replace(
          "move|_,_|Err(cause)",
          "move|_,_|async move {Err::<bool,_>(cause)}",
        ),
      expectedCode: "E0308",
    },
    {
      id: "escaped-borrowed-harness",
      source: `${prelude}fn escape<'a>(machine:&'a Machine<'a,State,Msg,Cmd,Sub,Context>)->BoundMachine<'a,'a,State,Msg,Cmd,Sub,Context>{let ctx=Context{local:Rc::new(())};testing::bind_machine(machine,&ctx)}`,
      expectedCode: "E0515",
    },
  ];
  const results = [];
  const digest = (b) => createHash("sha256").update(b).digest("hex");
  try {
    for (const p of programs) {
      const source = join(temporary, `${p.id}.rs`);
      writeFileSync(source, p.source);
      const r = spawnSync(
        rustc,
        [
          "--edition",
          "2024",
          "--crate-name",
          p.id.replaceAll("-", "_"),
          "--crate-type",
          "lib",
          "--emit",
          "metadata",
          "--extern",
          `demlik_tea=${rlib}`,
          "-L",
          `dependency=${dependencyDirectory ?? dirname(rlib)}`,
          source,
          "-o",
          join(temporary, `${p.id}.rmeta`),
        ],
        { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
      );
      if (p.expectedExit === 0)
        assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
      else {
        assert.notEqual(r.status, 0, p.id);
        assert(r.stderr.includes(p.expectedCode), `${p.id}\n${r.stderr}`);
      }
      results.push({
        ...p,
        sourceSha256: digest(p.source),
        exit: r.status,
        stdout: r.stdout,
        stderr: r.stderr,
      });
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  const version = spawnSync(rustc, ["--version"], { encoding: "utf8" });
  assert.equal(version.status, 0, version.stderr);
  const report = {
    compiler: version.stdout.trim(),
    dependencyDirectory: dependencyDirectory ?? dirname(rlib),
    rlib: { path: rlib, sha256: digest(readFileSync(rlib)) },
    positive: 1,
    negative: 4,
    results,
    qualification:
      "Compiler refusals are typing evidence, not behavioral mutation detections.",
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
      deps: { type: "string" },
      report: { type: "string" },
    },
    strict: true,
  });
  const r = testingHelperTypeProbes({
    rlib: values.rlib,
    dependencyDirectory: values.deps,
    reportFile: values.report,
  });
  console.log(
    JSON.stringify({
      positive: r.positive,
      negative: r.negative,
      compiler: r.compiler,
    }),
  );
}
