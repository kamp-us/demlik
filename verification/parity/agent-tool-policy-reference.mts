import assert from 'node:assert/strict';
import {createInterface} from 'node:readline';
import {agentTurnSchema,createAgent,agentCancelMsg} from '../../packages/tea/src/agent/index.ts';
const wire=(value:unknown)=>JSON.parse(JSON.stringify(value));
const number=(value:unknown)=>typeof value==='string'?Number(value):Number(value??0);
function execute(input:any){
 assert.equal(input.mode,'pure');
 const trace:any[]=[], calls:string[]=[]; let rngIndex=0, config={...input.config};
 const make=()=>createAgent({
  stages:config.stages??[{name:'collect'},{name:'check'},{name:'summarize'}],
  turnOf:(stage:any)=>{const name=stage?.name??'solo';trace.push(['turnOf',name]);return name;},
  payloadOf:(stage:any,conv:any,instructions:any)=>{const payload={stage:stage??null,turnCount:conv.turnCount,instructions};trace.push(['payloadOf',stage?.name??null,conv.turnCount,instructions]);return payload;},
  toolOf:(call:any)=>{trace.push(['toolOf',call.callId]);return {type:'policy_tool',call};},
  schemas:{collect:agentTurnSchema,check:agentTurnSchema,summarize:agentTurnSchema,solo:agentTurnSchema},
  model:()=>({withStructuredOutput:(schema:any)=>({invoke:async()=>schema.parse({content:'unused',toolCalls:[]})})}),
  toolConcurrency:config.concurrency??1,
  ...(config.omitSelector?{}:{toolResilienceOf:(call:any)=>{
   const rules=config.policies??[];
   const selected=rules.find((r:any)=>r.name===call.name&&r.callId===call.callId)??rules.find((r:any)=>r.name===call.name&&r.callId===undefined);
   trace.push(['policy',call.name,call.callId]);
   if(selected===undefined||selected.policy===null)return null;
   const policy=selected.policy;
   return {...(policy.timeoutMs===undefined?{}:{timeoutMs:number(policy.timeoutMs)}),...(policy.retry===undefined?{}:{retry:Object.fromEntries(Object.entries(policy.retry).map(([k,v])=>[k,typeof v==='string'&&k!=='jitter'?number(v):v]))})};
  }}),
  rng:()=>{const values=config.rng??[0.25,0.75,0.5];const value=values[rngIndex++%values.length];trace.push(['rng',value]);return value;},
 });
 let knob=make(),state=knob.init(),commands:any[]=[],lastBrain:any;const frames:any[]=[];
 const snapshot=(op:string,error?:unknown)=>{
  for(const cmd of commands)if(cmd.type==='resilient_run')lastBrain=cmd;
  let subs:any[]=[],subsError:any;
  try{subs=[...knob.subs(state)];calls.push('createAgent.subs');}catch(e){subsError={name:(e as Error).name,message:(e as Error).message};}
  frames.push(wire({op,state,commands,subs,trace:[...trace],...(error===undefined?{}:{error}),...(subsError===undefined?{}:{subsError})}));
 };
 snapshot('init');
 for(const action of input.actions){
  commands=[];let error:any;const at=number(action.at);
  try{
   switch(action.op){
    case 'start':[state,commands]=knob.start(state,action.runId??'invoice-r',at);calls.push('createAgent.start');break;
    case 'turn':[state,commands]=knob.turn(state,action.turn,at);calls.push('createAgent.turn');break;
    case 'toolOk':[state,commands]=knob.toolOk(state,action.id,action.result,at);calls.push('createAgent.toolOk');break;
    case 'toolErr':[state,commands]=knob.toolErr(state,action.id,action.error??action.reason,at);calls.push('createAgent.toolErr');break;
    case 'timer':[state,commands]=knob.onTimer(state,{type:'deadline_exceeded',id:action.id,atMs:at});calls.push('createAgent.onTimer');break;
    case 'boot':[state,commands]=knob.boot(state,at);calls.push('createAgent.boot');break;
    case 'cancel':{const wired=knob.toMachine({toolInterpret:{policy_tool:async()=>[]}});const cell=Reflect.get(wired.machine.update,'agent_cancel');assert.equal(typeof cell,'function');[state,commands]=Reflect.apply(cell,undefined,[state,agentCancelMsg(at)]);calls.push('createAgent.toMachine.update.agent_cancel');break;}
    case 'roundTrip':state=wire(state);break;
    case 'cold':state=wire(state);config={...config,...action.config};rngIndex=0;knob=make();break;
    case 'remaining':state=wire(state);state.toolResilience[action.name].calls[`$tool:${action.name}#${action.id}`].budget.remainingMs=action.value;break;
    case 'readSubs':knob.subs(state);calls.push('createAgent.subs');break;
    default:throw new Error(`unknown action ${action.op}`);
   }
  }catch(e){error={name:(e as Error).name,message:(e as Error).message};}
  snapshot(action.op,error);
 }
 return {view:{frames},observedCalls:calls};
}
for await(const line of createInterface({input:process.stdin,crlfDelay:Infinity})){
 try{const frame=JSON.parse(line);assert.equal(typeof frame.id,'string');const out=execute(frame.input);process.stdout.write(`${JSON.stringify({id:frame.id,...out})}\n`);}
 catch(e){process.stdout.write(`${JSON.stringify({id:null,error:(e as Error).message})}\n`);}
}
