import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {resolve, dirname} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const encoder = new TextEncoder(), decoder = new TextDecoder();
let instanceId = 0;
async function instance() {
 const {default:init} = await import(`${pathToFileURL(`${root}/target/cay-web/cay_ocagi_web.js`)}?instance=${++instanceId}`);
 const wasm = await init({module_or_path:await readFile(`${root}/target/cay-web/cay_ocagi_web_bg.wasm`)});
 return value => {
  const input=encoder.encode(JSON.stringify(value)), p=wasm.tea_alloc(input.length);
  new Uint8Array(wasm.memory.buffer,p,input.length).set(input);
  const result=wasm.tea_request(p,input.length);
  const output=JSON.parse(decoder.decode(new Uint8Array(wasm.memory.buffer,result,wasm.tea_output_len())));
  if(output.error)throw new Error(output.error);
  return output.ok;
 };
}
const success = [
 ...[1,2,3].map(table=>({type:'OrderPlaced',table,glasses:2})),
 {type:'HeatRequested'},{type:'HeatFinished',generation:0,result:{Ok:null}},
 {type:'BrewRequested'},{type:'BrewFinished',generation:0,glasses:6},
 ...[1,2,3].flatMap(id=>[{type:'ServeRequested',id},{type:'ServeFinished',generation:0,id}])
];
const failure = [
 {type:'WaterEmptied'},{type:'HeatRequested'},
 {type:'HeatFinished',generation:0,result:{Err:'Semaverde su yok. Su ekleyip ateşi yeniden yak.'}},
 {type:'WaterRefilled'},{type:'HeatRequested'},{type:'HeatFinished',generation:0,result:{Ok:null}},
 {type:'BrewRequested'},{type:'BrewFinished',generation:0,glasses:6}
];
const boundaries = [
 {type:'BrewRequested'},{type:'OrderPlaced',table:2,glasses:3},{type:'ServeRequested',id:1},
 {type:'OrderCancelled',id:1},{type:'ServeRequested',id:1},{type:'LeavesRestocked'},
 {type:'ResetRequested'},{type:'BrewFinished',generation:0,glasses:6},
 {type:'ServeFinished',generation:0,id:1},{type:'HeatFinished',generation:0,result:{Ok:null}}
];
const request = await instance();
let messages=0;
for(const [name,fixture] of Object.entries({success,failure,boundaries})) {
 const native = JSON.parse(execFileSync(`${root}/target/debug/native_trace`,{input:JSON.stringify(fixture),encoding:'utf8'}));
 const wasm = request({op:'replay',messages:fixture});
 assert.deepEqual(wasm,native,`${name}: complete Model and Cmd at every transition`);
 messages+=fixture.length;
 console.log(`PASS native/Wasm ${name}: ${fixture.length} complete Model + Cmd transitions match`);
}
const independent = await instance();
const action=(action,fields={})=>request({op:'action',action:{action,...fields}});
const state=()=>request({op:'state'});
const tick=(count=1)=>{for(let i=0;i<count;i++)request({op:'advance',elapsed_ms:25});};
const until=predicate=>{for(let i=0;i<1000;i++){if(predicate(state()))return state();tick();}throw new Error('Expected state not reached');};
action('pause',{paused:true});
for(const table of [1,2,3]) action('order',{table,glasses:2});
tick(10);assert.equal(state().pending.length,3);assert.equal(state().model.orders.length,0);
action('step');tick();assert.equal(state().pending.length,2);assert.equal(state().model.orders.length,1);
action('pause',{paused:false});until(s=>s.model.orders.length===3);
action('heat');until(s=>s.model.phase==='heating');
action('order',{table:1,glasses:1});until(s=>s.model.orders.length===4);assert.equal(state().model.phase,'heating');
action('cancel',{id:4});until(s=>s.model.orders[3].status==='cancelled');
until(s=>s.model.phase==='hot');action('brew');until(s=>s.model.phase==='ready');
for(const id of [1,2,3])action('serve',{id});
let completed=until(s=>s.model.served===6);
assert.deepEqual([completed.model.water,completed.model.leaves,completed.model.tea],[6,3,0]);
assert.equal(independent({op:'state'}).model.orders.length,0);
assert.equal(independent({op:'state'}).model.served,0);
console.log('PASS Wasm journey: paused real inbox, stepping, concurrency, three-table six-glass service, instance isolation');
action('reset');until(s=>s.model.generation===1);action('empty_water');until(s=>s.model.water===0);
action('heat');until(s=>s.model.error!==null);assert.equal(state().model.phase,'cold');
action('refill');until(s=>s.model.water===12);action('heat');until(s=>s.model.phase==='hot');assert.equal(state().model.error,null);
console.log('PASS Wasm empty-water Err, refill and retry');
assert.throws(()=>action('order',{table:9,glasses:2}),/Choose table/);
const source=request({op:'source'});assert.match(source.runtime.code,/Machine/);assert.match(source.channel_create.code,/sync_channel/);assert.match(source.effects.code,/finish_due_effects/);
console.log(`PASS ${messages} bounded native/Wasm transitions; actual embedded browser source and boundary validation`);
