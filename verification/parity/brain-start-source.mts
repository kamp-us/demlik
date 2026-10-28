import assert from "node:assert/strict";
import fs from "node:fs";
import { Effect, Exit } from "effect";
import { z } from "zod";
import { brainHandler, plainModel, type BrainPorts, type MessageLoader, type ModelFactory } from "../../packages/tea/src/agent/model.ts";
import { run } from "../../packages/tea/src/effect/run.ts";
import { createLlmCall, type LlmCall, type LlmFailMsg, type LlmRunCmd, type LlmSucceedMsg, type Schema } from "../../packages/tea/src/internal/llm-call/index.ts";
import type { Machine, Sub } from "../../packages/tea/src/pure/core.ts";
import { definePort, refuse, type Store, type RuntimeErrorContext } from "../../packages/tea/src/runtime-types.ts";

const expectedSchema = z.object({loads:z.number(),invokes:z.number(),parses:z.number(),cleanups:z.number(),state:z.number(),saves:z.number(),reports:z.number(),outcome:z.enum(["Ok","Err"]),output:z.number().optional(),loadBeforeStop:z.boolean().optional(),bindAfterStopCalled:z.boolean().optional(),cleanupBeforeBind:z.boolean().optional(),bindAfterStopReturned:z.boolean().optional(),bindBeforeStop:z.boolean().optional(),hostInvokeBeforeParse:z.boolean().optional()}).strict();
const caseSchema = z.object({id:z.string(),loader:z.boolean(),pending:z.boolean(),plain:z.boolean(),stopAtEntry:z.boolean(),expected:expectedSchema}).strict();
const cases = z.array(caseSchema).length(4).parse(JSON.parse(fs.readFileSync(new URL("./brain-start-source-cases.json",import.meta.url),"utf8")));
assert.deepEqual({node:process.version,v8:process.versions.v8},{node:"v22.21.1",v8:"12.4.254.21-node.33"});
type P = "invoice";
type Answer = { readonly value:number };
type Answers = { invoice:Answer };
type Message = {readonly call:LlmCall<P>};
function latch<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>{resolve=yes;});return{promise,resolve};}
class OriginalFailure extends Error {readonly owner={};override readonly name="OriginalFailure";}
const rows:unknown[]=[];
let failures=0;
for(const spec of cases){
 const trace:unknown[][]=[];const record=(...event:unknown[])=>trace.push(event);
 const original=new OriginalFailure(spec.id),marker={id:spec.id};
 const port=definePort<{readonly owner:object;readonly phase:string}>(`brain-start-${spec.id}`);
 const entered=latch<void>(),invoked=latch<void>(),controlled=latch<readonly Message[]>(),outcomeDone=latch<void>(),committedDone=latch<void>();
 let stopped=false,loads=0,invokes=0,parses=0,cleanups=0,binds=0;
 let emit:(phase:string)=>void=()=>{throw new Error("emitter before ready");};
 const raw:Answer={value:17};const products:Answer[]=[];const factoryIds:(string|null)[]=[];
 const messages:Message[]=[];const reports:{phase:string;name:string;message:string;sameCause:boolean;stack?:string}[]=[];
 const outcomes:{kind:"Ok"|"Err";value:number|null;sameCause:boolean}[]=[];
 const commits:string[]=[];const saved:string[]=[];
 const rawSchema=z.object({value:z.number()});
 const schema:Schema<Answer>={parse(value:unknown){
   const prior=products.at(-1);const parsed=rawSchema.parse(value);const result={value:parsed.value+1};
   parses++;record("parse",parsed.value,result.value,Object.is(value,raw),Object.is(value,prior),stopped);products.push(result);return result;
 }};
 const llm=createLlmCall<P,Answers>({schemas:{invoice:schema}},()=>0);
 const input:LlmCall<P>={purpose:"invoice",model:null,payload:marker};messages.push({call:input});
 const loader:MessageLoader<P,Message>=(call)=>{
   loads++;record("load:call",Object.is(call,input),Object.is(call.payload,marker),stopped);emit("loader");entered.resolve();
   const promise=spec.pending?controlled.promise:Promise.resolve(messages);record("load:return",stopped);return promise;
 };
 const invokePrefix=(actual:readonly Message[])=>{
   invokes++;record("invoke:call",actual.length,Object.is(actual,messages),actual[0]?Object.is(actual[0].call,input):null,stopped);
   emit("invoke");invoked.resolve();if(!spec.loader)entered.resolve();
 };
 const factory:ModelFactory<Message>=(id)=>{
   factoryIds.push(id);record("modelOf",id,stopped);
   return{withStructuredOutput<T>(active:Schema<T>){
     binds++;record("bind",Object.is(active,schema),stopped);
     return{invoke:async(actual:readonly Message[]):Promise<T>=>{
       invokePrefix(actual);if(spec.pending)throw original;return active.parse(raw);
     }};
   }};
 };
 const ports:BrainPorts<P,Answers,Message>={model:spec.plain?plainModel<Message,Answer>(async actual=>{invokePrefix(actual);return raw;}):factory,...(spec.loader?{loadMessages:loader}:{})};
 const handle=brainHandler<P,Answers,Message>(llm,ports);
 type Msg={readonly type:"go"}|LlmSucceedMsg<P,Answers>|LlmFailMsg<P>;
 type State={readonly n:number;readonly call:ReturnType<typeof llm.init>;readonly settled:Answer|null;readonly causeSame:boolean};
 type Cmd=LlmRunCmd<P>;
 const machine:Machine<State,Msg,Cmd,Sub<never>,undefined>={
   cmds:[llm.run],
   init:()=>[{n:0,call:llm.init(),settled:null,causeSame:false},[]],
   update:{
     go:(state:State)=>{const[call,commands]=llm.attempt(state.call,input,17.25);return[{...state,n:1,call},commands];},
     resilient_run_ok:(state:State,msg:LlmSucceedMsg<P,Answers>)=>{const[call,commands]=llm.succeed(state.call,msg);return[{n:2,call,settled:msg.value.output,causeSame:false},commands];},
     resilient_run_err:(state:State,msg:LlmFailMsg<P>)=>{const[call,commands]=llm.fail(state.call,msg);return[{n:2,call,settled:null,causeSame:Object.is(llm.errOf(msg).error,original)},commands];},
   },
 };
 const store:Store<State>={load:async()=>null,migrate:value=>value===null?null:refuse("fresh-only probe"),save:async state=>{saved.push(JSON.stringify(state));record("save",state.n,stopped);}};
 const onError=(cause:unknown,ctx:RuntimeErrorContext)=>{
   reports.push({phase:ctx.phase,name:cause instanceof Error?cause.name:typeof cause,message:cause instanceof Error?cause.message:String(cause),sameCause:Object.is(cause,original),...(cause instanceof Error?{stack:cause.stack}:{})});record("report",ctx.phase,Object.is(cause,original),stopped);
 };
 const output=await Effect.runPromise(Effect.scoped(Effect.gen(function*(){
   const boot=yield*run(machine,{ctx:undefined,store,clock:()=>17.25,onError,interpret:{
     resilient_run:(cmd:Cmd)=>Effect.promise(signal=>{
       record("effect:factory",signal.aborted,stopped);signal.addEventListener("abort",()=>record("effect:abort",stopped),{once:true});
       const promise=handle(cmd);
       void promise.then(out=>{
         const view=out._tag==="Ok"?{kind:"Ok" as const,value:out.value.output.value,sameCause:false}:{kind:"Err" as const,value:null,sameCause:Object.is(out.error.cause,original)};
         outcomes.push(view);record("brain:outcome",view,stopped);outcomeDone.resolve();
       });
       record("handler:return",stopped);return promise;
     }).pipe(Effect.flatMap(out=>out._tag==="Ok"?Effect.succeed(out.value):Effect.fail(out.error)),Effect.ensuring(Effect.sync(()=>{cleanups++;record("cleanup",stopped);}))),
   }});
   const live=yield*boot.ready;
   emit=phase=>{record("port:attempt",phase,stopped);live.emitPort(port,{owner:marker,phase});};
   const unsubscribe=live.subscribePort(port,value=>record("port:received",value.phase,Object.is(value.owner,marker),stopped));
   live.observe(msg=>{commits.push(msg.type);record("commit",msg.type,stopped);if(msg.type!=="go")committedDone.resolve();});
   return yield*Effect.promise(async()=>{
     void invoked.promise.then(()=>record("host:invoke-entered",stopped));
     const dispatch=Effect.runPromiseExit(live.dispatch({type:"go"}));
     await entered.promise;record("host:entry",stopped);
     let afterStop:unknown=null;
     if(spec.stopAtEntry){
       record("stop:called");await Effect.runPromise(live.stop());stopped=true;record("stop:returned");
       afterStop={state:live.getState(),saves:saved.length,loads,invokes,parses,cleanups,outcomes:outcomes.length};
       if(spec.pending){record("controller:release-after-stop");controlled.resolve(messages);}
     }
     await outcomeDone.promise;
     if(!spec.stopAtEntry)await committedDone.promise;
     const exit=await dispatch;await Effect.runPromise(live.idle());
     if(!spec.stopAtEntry){record("stop:called");await Effect.runPromise(live.stop());stopped=true;record("stop:returned");}
     const semanticFailures:string[]=[];
     const check=(name:string,fn:()=>void)=>{try{fn();}catch(error){semanticFailures.push(`${name}: ${error instanceof Error?error.message:String(error)}`);}};
     const index=(name:string)=>trace.findIndex(row=>row[0]===name);
     check("loads",()=>assert.equal(loads,spec.expected.loads));check("invokes",()=>assert.equal(invokes,spec.expected.invokes));check("parses",()=>assert.equal(parses,spec.expected.parses));
     check("cleanup",()=>assert.equal(cleanups,spec.expected.cleanups));check("state",()=>assert.equal(live.getState().n,spec.expected.state));check("saves",()=>assert.equal(saved.length,spec.expected.saves));check("reports",()=>assert.equal(reports.length,spec.expected.reports));
     check("outcome",()=>assert.equal(outcomes[0]?.kind,spec.expected.outcome));
     check("original cause",()=>{if(spec.pending)assert.equal(outcomes[0]?.sameCause,true);});
     check("transformed output",()=>{if(spec.expected.output!==undefined)assert.equal(live.getState().settled?.value,spec.expected.output);});
     check("load prefix",()=>{if(spec.expected.loadBeforeStop)assert.ok(index("load:call")<index("stop:called"));});
     check("ready await defers bind",()=>{if(spec.expected.bindAfterStopCalled)assert.ok(index("stop:called")<index("bind"));});
     check("cleanup before bind",()=>{if(spec.expected.cleanupBeforeBind)assert.ok(index("cleanup")<index("bind"));});
     check("pending bind after stop",()=>{if(spec.expected.bindAfterStopReturned)assert.ok(index("stop:returned")<index("bind"));});
     check("absent loader starts invoke before await",()=>{if(spec.expected.bindBeforeStop)assert.ok(index("bind")<index("invoke:call")&&index("invoke:call")<index("stop:called"));});
     check("plain-model ready await",()=>{if(spec.expected.hostInvokeBeforeParse)assert.ok(index("host:invoke-entered")<index("parse"));});
     check("fresh parse objects",()=>{if(products.length===2)assert.notEqual(products[0],products[1]);});
     check("dispatch",()=>assert.ok(Exit.isSuccess(exit)));
     unsubscribe();
     return{id:spec.id,input:spec,trace,counters:{loads,binds,invokes,parses,cleanups},factoryIds,afterStop,finalState:live.getState(),savedBytes:saved,commits,outcomes,reports,dispatch:Exit.isSuccess(exit)?"Success":"Failure",semanticFailures,publishedHandler:true,SourceOnly:true,newParityCredit:0};
   });
 })));
 rows.push(output);failures+=output.semanticFailures.length;console.log(JSON.stringify(output));
}
const report={engine:{node:process.version,v8:process.versions.v8,icu:process.versions.icu},cases:4,literalFailures:failures,rows,SourceOnly:true,newParityCredit:0};
fs.writeFileSync(process.argv[2]??new URL("./brain-start-source-results.json",import.meta.url),JSON.stringify(report,null,2)+"\n");
if(failures)process.exitCode=1;
