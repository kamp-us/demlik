'use strict';
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const people = ['','Kemal amca','Elif','Deniz'];
async function fetchJson(path, options) {
 const response = await fetch(path, options);
 const value = await response.json();
 if (!response.ok) throw new Error(value.error || 'İşlem başarısız.');
 return value;
}
const transport = window.teaTransport || {
 profile: 'native', ready: Promise.resolve(),
 action: value => fetchJson('/api/action', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)}),
 state: () => fetchJson('/api/state'), source: () => fetchJson('/api/source')
};
const isBrowser = transport.profile === 'browser-wasm';
const phases = {cold:'Semaver soğuk',heating:'Su ısınıyor',hot:'Su kaynadı',brewing:'Çay demleniyor',ready:'Çaylar hazır'};
const concepts = {
 model:'<b>Model = ocağın durumu.</b> Su, çay, siparişler. Rust’ın <code>struct</code> kelimesi bu bilgileri tek bir defterde toplar.',
 messages:'<b>Msg = olan bir şey.</b> Sipariş geldi, su kaynadı. <b>Cmd = yapılacak iş.</b> Rust’ın <code>enum</code> kelimesi olasılıkları adlandırır.',
 update:'<b>update = kural defteri.</b> Mevcut durumu ve mesajı alır; yeni durum + yapılacak işleri döndürür. Çay yapmaz, karar verir.',
 effects:'<b>Interpreter = işi yapan.</b> Cmd’yi alır, bir timer task başlatır ve sonucu aynı inbox’a Msg olarak yollar. <code>async / await</code> beklerken başka işlere yer açar.',
 runtime:'<b>Host = makineyi çalıştıran.</b> Model + update aynı kalır. Native host Tokio kullanır; tarayıcı host’u Wasm içindeki Machine ve kendi saatini sürer.',
 channel:'<b>Channel = mesaj kutusu.</b> <code>tx</code> gönderir, <code>rx</code> alır. Sipariş defterinden ayrı: burada işlenmeyi bekleyen mesajlar var.'
};
if (isBrowser) concepts.effects = '<b>Effect = yapılacak iş.</b> Rust işi kendi saatine kaydeder. Tarayıcı yalnızca geçen süreyi bildirir; tamamlanma kararını Rust verir ve Msg inbox’a döner.';
let state, sources = {}, tab = 'model', follow = true, quantity = 2, selectedTable = 1, lastEvent = 0, lastModel = '', lastPending = '', lastOrders = '', lastEffects = '', sourceKey = '', selectedEvent = null, tour = false, connected = false;
let lastReceivedAt = performance.now();
const escape = (value) => String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const time = (seconds) => `${String(Math.floor(seconds/60)).padStart(2,'0')}:${String(Math.floor(seconds%60)).padStart(2,'0')}`;
function toast(message) { $('#toast').textContent = message; $('#toast').hidden = false; clearTimeout(toast.timeout); toast.timeout = setTimeout(()=>$('#toast').hidden=true,4500); }
window.addEventListener('tea-host-error', event => toast(`Rust host durdu: ${event.detail}`));
async function action(action, data = {}) {
 try { await transport.ready; await transport.action({action,...data}); await poll(); return true; }
 catch(error) { toast(`Rust’a ulaşılamadı: ${error.message}`); return false; }
}
function selectTab(name, manual = true, event = null) {
 tab = name; if(manual){follow=false; selectedEvent=event;}
 $$('.code-tabs button').forEach(b=>b.setAttribute('aria-selected',String(b.dataset.tab === name)));
 $('#concept').innerHTML = concepts[name];
 $('#follow').setAttribute('aria-pressed', String(follow));
 sourceKey=''; renderSource(event || selectedEvent);
}
function highlight(line) {
 // Highlight tokens only after escaping, so source is always rendered as text.
 const tokens = line.match(/\/\/.*|"(?:[^"\\]|\\.)*"|\b(?:pub|enum|struct|fn|impl|for|let|mut|match|if|else|return|async|move|await|type|use|self|Some|None|Ok|Err|vec|true|false)\b|\b(?:Model|Msg|Cmd|Step|Phase|Order|OrderStatus|Effects|Interpreter|CommandWork|Machine|Update|Options|Profile|Envelope)\b|[^]/g) || [];
 return tokens.map(t=>t.startsWith('//')?`<span class="tok-comment">${escape(t)}</span>`:t.startsWith('"')?`<span class="tok-string">${escape(t)}</span>`:/^(Model|Msg|Cmd|Step|Phase|Order|OrderStatus|Effects|Interpreter|CommandWork|Machine|Update|Options|Profile|Envelope)$/.test(t)?`<span class="tok-type">${t}</span>`:/^[a-zA-Z]{2,}$/.test(t)?`<span class="tok-key">${t}</span>`:escape(t)).join('');
}
function renderSource(event) {
 let section = tab;
 if(tab === 'channel') section = event?.kind === 'channel' ? 'channel_send' : 'channel_create';
 const parts = tab === 'channel' ? [section, ...(section==='channel_create'?['channel_send','channel_receive']:['channel_create','channel_receive'])] : [section];
 const key = `${parts.join(',')}:${event?.name||''}`;
 if(key===sourceKey || !sources[section])return; sourceKey=key;
 let focused = false;
 $('#source').innerHTML = parts.map(part=> {
  const data=sources[part];
  return data.code.split('\n').map((line,i)=>{
   const focus = Boolean(event && (tab==='update'||tab==='effects') && line.includes(`${tab==='effects'?'Cmd':'Msg'}::${event.name}`));
   if(focus)focused=true;
   return `<span class="source-line${focus?' focus-line':''}" data-line="${data.start+i}"><span class="line-number" aria-hidden="true">${data.start+i}</span>${highlight(line)}</span>`;
  }).join('');
 }).join('<span class="source-line"><span class="line-number">·</span></span>');
 $('#code-file').textContent = sources[section].path || (sources[section].file === 'domain.rs' ? 'cay_ocagi/domain.rs' : sources[section].file);
 $('#code-caption').textContent = event ? `${event.name} · çalışan kaynak kodu` : 'Bu, uygulamanın derlenen kaynak kodu.';
 if(focused){const line=$('.focus-line');$('#source-wrap').scrollTop=line.offsetTop-$('#source').offsetTop-55;}else $('#source-wrap').scrollTop=0;
}
function formatSummary(event) {
 const p=event.payload;
 if(p.table)return `masa ${p.table} · ${p.glasses} çay`;
 if(p.id)return `#${p.id}`;
 if(p.result?.Err)return 'Err · su yok';
 if(p.result && 'Ok' in p.result)return 'Ok · tamam';
 if(event.kind==='effect')return 'başladı';
 if(event.model)return event.model.phase;
 return 'kuyruğa girdi';
}
function renderEvents() {
 if(state.event_id===lastEvent)return;
 lastEvent=state.event_id;
 $('#events').innerHTML = state.events.slice(0,30).map(e=>`<button class="event" data-event="${e.seq}" title="${escape(e.name)} olayını ve gerçek payload değerini incele"><span class="event-time">${time(e.at)}</span><span class="event-kind ${e.kind}">${e.kind==='update'?'update':e.kind==='effect'?'effect':'inbox'}</span><span class="event-name">${escape(e.name)}</span><span class="event-summary">${escape(formatSummary(e))}</span></button>`).join('') || '<p class="empty-events">İlk mesajını bekliyoruz. Rust hazır.</p>';
 if(follow && state.events.length) {
  const event=state.events[0]; selectedEvent=event;
  selectTab(event.kind==='channel'?'channel':event.kind==='effect'?'effects':'update',false,event);
 }
}
function renderOrders() {
 const signature=JSON.stringify(state.model.orders); if(signature===lastOrders)return; lastOrders=signature;
 const orders=[...state.model.orders].reverse();
 const active=orders.filter(o=>o.status==='waiting'||o.status==='serving');
 $('#order-count').textContent=active.length;
 $('#orders').innerHTML=orders.length?orders.map(o=>`<div class="order-row ${o.status}"><span class="order-number">#${String(o.id).padStart(2,'0')}</span><div class="order-info"><b>${people[o.table]}</b><span>Masa ${o.table}${o.status==='cancelled'?' · iptal edildi':''}</span></div><span class="order-glasses">${o.glasses} × çay</span>${o.status==='waiting'?`<button class="serve" data-serve="${o.id}">Servis et ↗</button><button class="cancel" data-cancel="${o.id}" aria-label="Sipariş ${o.id} iptal">×</button>`:`<span class="order-status">${o.status==='served'?'✓ Afiyet olsun':o.status==='serving'?'Tepsi yolda…':'İptal'}</span>`}</div>`).join(''):'<div class="empty-ledger"><span>〰</span><p>Henüz kimse çay söylemedi.<small>Masalardan birine tıklayarak başla.</small></p></div>';
 for(let table=1;table<=3;table++) {
  const waiting=active.filter(o=>o.table===table), served=orders.some(o=>o.table===table&&o.status==='served');
  $(`[data-table="${table}"]`).classList.toggle('has-order',waiting.length>0);
  $(`#table-art-${table}`).classList.toggle('has-tea',served);
  $(`#table-state-${table}`).textContent=waiting.some(o=>o.status==='serving')?'Çay geliyor!':waiting.length?`${waiting.reduce((s,o)=>s+o.glasses,0)} çay bekliyor`:served?'Eline sağlık!':['','Bir çay?','Mola vakti','Kod & çay'][table];
 }
}
function render() {
 const m=state.model; connected=true; lastReceivedAt=performance.now();
 $('#connection').classList.remove('offline');$('#connection span').textContent=isBrowser?'Rust / Wasm · bu sekmede':'Native Rust · bağlı';
 $('#clock').textContent=time(state.now);$('#pause').textContent=state.paused?'▶':'Ⅱ';$('#pause').setAttribute('aria-label',state.paused?'Simülasyonu sürdür':'Simülasyonu duraklat');$('#speed').value=state.speed;
 $('#scene').classList.toggle('is-paused',state.paused);
 $('#inbox-count').textContent=`${state.pending.length} bekliyor`;$('#active-count').textContent=`${state.effects.length} çalışıyor`;
 $('.pipe[data-tab="channel"]').classList.toggle('active',state.pending.length>0);$('.pipe[data-tab="effects"]').classList.toggle('active',state.effects.length>0);
 const pending=JSON.stringify(state.pending);if(lastPending!==pending){lastPending=pending;$('#pending').style.display=state.pending.length?'flex':'none';$('#pending').innerHTML='<span>Rust inbox →</span>'+state.pending.map(p=>`<code>${escape(p.name)}</code>`).join('');}
 const signature=JSON.stringify(m);if(signature!==lastModel){lastModel=signature;
  $('#note').textContent=m.error || m.note;$('.narrator').classList.toggle('error',Boolean(m.error));
  $('#served').textContent=m.served;$('#water-count').textContent=m.water;$('#leaf-count').textContent=m.leaves;$('#tea-count').textContent=m.tea;
  $('#model-phase').textContent=m.phase[0].toUpperCase()+m.phase.slice(1);$('#model-tea').textContent=m.tea;$('#model-orders').textContent=`[${m.orders.length}]`;
  $('#phase-pill span').textContent=phases[m.phase];$('#phase-pill').classList.toggle('busy',['heating','brewing'].includes(m.phase));
  $('#kettle-art').classList.toggle('is-heating',m.phase==='heating');$('#kettle-art').classList.toggle('is-hot',['hot','brewing','ready'].includes(m.phase));
  $('#pot-art').classList.toggle('is-brewing',m.phase==='brewing');$('#pot-art').classList.toggle('is-ready',m.phase==='ready');$('#ready-glasses').style.opacity=m.tea?'1':'0';
  $('#heat').disabled=$('#heat-scene').disabled=m.phase!=='cold';$('#heat').textContent=m.phase==='heating'?'Isınıyor…':m.phase==='cold'?'Ateşi yak':'Su sıcak ✓';
  $('#brew').disabled=$('#brew-scene').disabled=!['hot','ready'].includes(m.phase)||m.tea>0;$('#brew').textContent=m.phase==='brewing'?'Demleniyor…':'Demle';
  $('#heat-scene .hotspot-label').innerHTML=m.phase==='cold'?'Ateşi yak ↗':m.phase==='heating'?'Isınıyor…':'Su sıcak ✓';
  $('#brew-scene .hotspot-label').innerHTML=m.phase==='brewing'?'Demleniyor…':m.tea?`${m.tea} çay hazır`:'Çayı demle ↗';
  $('#keeper-speech').textContent=m.error?'Bir sorun var.':m.phase==='ready'?'Çaylar hazır!':m.phase==='brewing'?'Sabır, az kaldı.':m.phase==='heating'?'Ateş yandı.':'Çaylar benden,';
  $('#keeper-speech-2').textContent=m.error?'Birlikte çözeriz.':m.phase==='ready'?'Tavşan kanı.':m.phase==='brewing'?'Demini alsın.':m.phase==='heating'?'Suyu bekliyoruz.':'mesajlar senden.';
 }
 renderOrders();renderEvents();renderTour();
}
function animate() {
 if(state){
  const now=state.now+(state.paused?0:Math.min((performance.now()-lastReceivedAt)/1000,.5)*state.speed);
  const main=state.effects.find(e=>['HeatWater','SteepTea'].includes(e.command.type)&&e.command.generation===state.model.generation);
  $('#effect-progress').style.display=main?'block':'none';
  if(main){const progress=Math.min(1,Math.max(0,(now-main.start)/main.duration));$('#effect-bar').value=progress;$('#effect-label').textContent=main.command.type==='HeatWater'?'Su ısınıyor':'Çay demleniyor';$('#effect-time').textContent=`${Math.max(0,main.duration-(now-main.start)).toFixed(1)}s`;}
  const delivery=state.effects.find(e=>e.command.type==='DeliverTea'&&e.command.generation===state.model.generation);
  $('#delivery-tray').style.opacity=delivery?'1':'0';
  if(delivery){const order=state.model.orders.find(o=>o.id===delivery.command.id);const p=Math.max(0,Math.min(1,(now-delivery.start)/delivery.duration));const x=[0,136,380,626][order?.table||1];$('#delivery-tray').setAttribute('transform',`translate(${310+(x-310)*p} ${280+145*p-35*Math.sin(p*Math.PI)})`);}
 }
 requestAnimationFrame(animate);
}
let polling=false;
async function poll() {
 if(polling)return;polling=true;
 try{await transport.ready; state=await transport.state();render();}
 catch(error){connected=false;$('#connection').classList.add('offline');$('#connection span').textContent='Rust bağlantısı yok';}
 finally{polling=false;}
}
function openOrder(table=1){selectedTable=table;quantity=2;$('#quantity').textContent=quantity;$('#order-person').textContent=`${people[table]} · Masa ${table}`;$(`#order-form input[value="${table}"]`).checked=true;$('#order-dialog').showModal();}
function showDetail(title,description,code){$('#detail-title').textContent=title;$('#detail-description').textContent=description;$('#detail-code').textContent=code;$('#detail-dialog').showModal();}
function renderTour(){
 if(!tour||!state)return;$('#tour').hidden=false;const m=state.model;
 let step,description,label,act;
 if(m.served>0){step=4;description='Afiyet olsun! Aynı döngü: Msg → update → Cmd → Msg. Şimdi duraklatıp kutuya birkaç mesaj bırakabilirsin.';label='Anladım ✓';act=()=>{tour=false;$('#tour').hidden=true;};}
 else if(!m.orders.some(o=>o.status==='waiting'||o.status==='serving')){step=1;description='Bir sipariş fişi gönder. Channel bu mesajı Rust’a taşıyacak.';label='İki çay söyle';act=()=>action('order',{table:1,glasses:2});}
 else if(m.phase==='cold'){step=2;description='Sipariş defterde. Şimdi semaveri yak: update bir HeatWater komutu çıkaracak.';label='Ateşi yak';act=()=>action('heat');}
 else if(m.phase==='heating'){step=2;description=isBrowser?'Rust effect adapter suyu ısıtıyor. Tamamlanınca HeatFinished inbox’a geri gelecek.':'Interpreter suyu ısıtıyor. Tamamlanınca HeatFinished mesajı update’e geri gelecek.';label='Isınıyor…';}
 else if(m.phase==='hot'){step=3;description='Su kaynadı. Çayı demle; beklemek interpreter’ın işi.';label='Çayı demle';act=()=>action('brew');}
 else if(m.phase==='brewing'){step=3;description='Çay demlenirken Rust yeni siparişleri almaya devam edebilir. Bekleyen iş ile karar veren update ayrıdır.';label='Demleniyor…';}
 else {step=4;description='Çay hazır. Servis bir komut, tepsinin masaya varışı yeni bir mesaj.';label='Servis et';const order=m.orders.find(o=>o.status==='waiting');act=order?()=>action('serve',{id:order.id}):undefined;if(!order)label='Tepsi yolda…';}
 $('#tour-step').textContent=`0${step} / 04`;$('#tour-text').textContent=description;$('#tour-action').textContent=label;$('#tour-action').disabled=!act;$('#tour-action').onclick=act;
}
$$('[data-close]').forEach(b=>b.onclick=()=>b.closest('dialog').close());
$$('dialog').forEach(dialog=>dialog.addEventListener('click',e=>{if(e.target===dialog){const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)dialog.close();}}));
$$('[data-tab]').forEach(b=>b.onclick=()=>selectTab(b.dataset.tab));
$$('[data-table]').forEach(b=>b.onclick=()=>openOrder(Number(b.dataset.table)));
$('#new-order').onclick=()=>openOrder();$('#guide-open').onclick=()=>$('#guide-dialog').showModal();
$('#guided-start').onclick=()=>{$('#guide-dialog').close();tour=true;renderTour();};$('#tour-close').onclick=()=>{tour=false;$('#tour').hidden=true;};
$('#less').onclick=()=>{$('#quantity').textContent=quantity=Math.max(1,quantity-1);};$('#more').onclick=()=>{$('#quantity').textContent=quantity=Math.min(6,quantity+1);};
$$('#order-form input').forEach(input=>input.onchange=()=>{selectedTable=Number(input.value);$('#order-person').textContent=`${people[selectedTable]} · Masa ${selectedTable}`;});
$('#order-form').onsubmit=async e=>{e.preventDefault();if(await action('order',{table:selectedTable,glasses:quantity}))$('#order-dialog').close();};
for(const [selector,name] of [['#heat','heat'],['#heat-scene','heat'],['#brew','brew'],['#brew-scene','brew'],['#refill','refill'],['#restock','restock']])$(selector).onclick=()=>action(name);
$('#pause').onclick=()=>action('pause',{paused:!state?.paused});$('#step').onclick=()=>action('step');$('#speed').onchange=e=>action('speed',{speed:Number(e.target.value)});
$('#reset').onclick=async()=>{await action('reset');toast('Yeni vardiya mesajı kuyruğa girdi.');};
$('#experiment').onclick=()=>{if(state?.model.phase!=='cold'){toast('Önce “Yeni vardiya” ile semaveri soğut. Sonra bu deneyi aç.');return;} action('empty_water').then(ok=>{if(ok)toast('Su boşalınca ateşi yak. HeatFinished → Err göreceksin. Sonra SU + ile doldur, tekrar dene.');});};
$('#orders').onclick=e=>{const serve=e.target.closest('[data-serve]'),cancel=e.target.closest('[data-cancel]');if(serve)action('serve',{id:Number(serve.dataset.serve)});if(cancel)action('cancel',{id:Number(cancel.dataset.cancel)});};
$('#events').onclick=e=>{const button=e.target.closest('[data-event]');if(!button)return;const event=state.events.find(e=>e.seq===Number(button.dataset.event));if(!event)return;selectedEvent=event;selectTab(event.kind==='channel'?'channel':event.kind==='effect'?'effects':'update',true,event);showDetail(event.name,`${time(event.at)} · ${event.kind==='channel'?'Gerçek Rust inbox’a gönderilen mesaj':event.kind==='effect'?'Rust effect adapter tarafından başlatılan komut':'Rust update sonrası sonuç'}`,JSON.stringify({payload:event.payload,...(event.model?{model:event.model}:{})},null,2));};
$('#model-open').onclick=()=>showDetail('Ocağın durumu','Bu JSON, Rust makinesinin gerçek Model değeridir. JavaScript yalnızca görüntüyü çizer.',JSON.stringify(state?.model,null,2));
$('#expand-source').onclick=()=>{const names=tab==='channel'?['channel_create','channel_send','channel_receive']: [tab];showDetail(`${tab} · derlenen Rust kodu`,'Buradaki satırlar çalışan binary içine include_str! ile gömülen gerçek kaynaktan gelir.',names.map(n=>sources[n]?.code||'').join('\n\n'));};
$('#follow').onclick=()=>{follow=!follow;$('#follow').setAttribute('aria-pressed',String(follow));if(follow){lastEvent=0;renderEvents();}};
// Native tab keys remain usable, with arrow navigation between Rust concepts.
$('.code-tabs').onkeydown=e=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;e.preventDefault();const buttons=$$('.code-tabs button');const index=buttons.indexOf(document.activeElement);const next=e.key==='Home'?0:e.key==='End'?buttons.length-1:(index+(e.key==='ArrowRight'?1:-1)+buttons.length)%buttons.length;buttons[next].focus();selectTab(buttons[next].dataset.tab);};
(async()=>{try{await transport.ready; sources=await transport.source();selectTab('model',false);}catch(e){toast('Rust kaynak kodu yüklenemedi.');}await poll();setInterval(poll,180);requestAnimationFrame(animate);})();
