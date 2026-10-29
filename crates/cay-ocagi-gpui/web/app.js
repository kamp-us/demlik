import init, {gpui_snapshot, gpui_source} from './cay_ocagi_gpui.js';

const element = id => document.getElementById(id);
const mount = element('gpui-mount');

// This panel only reads the GPUI-owned host. GPUI owns inputs and its clock.
function placeCanvas() {
  const canvas = document.querySelector('canvas');
  if (!canvas || canvas.parentNode === mount) return;
  mount.append(canvas);
  canvas.tabIndex = 0;
  canvas.setAttribute('aria-label', 'Çay ocağı GPUI. Klavye: 1, 2, 3 sipariş; H ısıt; B demle; S servis; P duraklat; Space adım; R baştan.');
}
const observer = new MutationObserver(placeCanvas);
observer.observe(document.body, {childList: true});

let source, state;
let selected = 'gpui';
let lastEvent = -1;
const sections = [
  ['gpui', 'GPUI', 'GPUI düğmeleri ve klavye aynı Rust dispatch yolunu kullanır.'],
  ['model', 'Model', 'Ocağın durumu: su, yaprak, demlik ve siparişler.'],
  ['messages', 'Msg', 'Bir sipariş veya işin bittiğini söyleyen bir bildirim.'],
  ['update', 'update', 'Kural defteri: Model + Msg → yeni Model ve yapılacak işler.'],
  ['effects', 'Cmd / işler', 'Rust host işi zamanlar. Bitince sonucu tekrar mesaj kutusuna koyar.'],
  ['channel_receive', 'Kutu', 'Rust mesaj kutusundan bir mesaj alınır, gerçek TEA Machine işler.'],
  ['runtime', 'Machine', 'Aynı demlik_tea Machine, tarayıcıda WebAssembly olarak çalışır.'],
  ['channel_send', 'Gönder', 'Sipariş defteri ve mesaj kutusu farklıdır. Duraklatıp bir sipariş vererek gör.'],
];

function renderCode() {
  const item = source[selected];
  element('file').textContent = `${item.path} · ${item.start}`;
  element('lesson').textContent = sections.find(section => section[0] === selected)[2];
  const latest = state?.events?.find(event => event.kind === 'update');
  const needle = latest?.name?.split('::').pop();
  element('code').replaceChildren(...item.code.split('\n').map((line, index) => {
    const span = document.createElement('span');
    span.className = 'line' + (needle && line.includes(needle) ? ' active' : '');
    const number = document.createElement('span');
    number.className = 'num';
    number.textContent = item.start + index;
    span.append(number, document.createTextNode(line || ' '));
    return span;
  }));
  document.querySelectorAll('.tabs button').forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.section === selected));
  });
}

function refresh() {
  const raw = gpui_snapshot();
  if (!raw) return;
  state = JSON.parse(raw);
  element('inbox').textContent = state.pending.length;
  element('ledger').textContent = state.model.orders.length;
  element('pending').textContent = state.pending.length
    ? state.pending.map(pending => pending.name).join(' → ')
    : 'Mesaj kutusu boş. Yeni bir mesajı bekliyor.';
  element('model').textContent = JSON.stringify(state.model, null, 2);
  if (state.event_id === lastEvent) return;
  lastEvent = state.event_id;
  renderCode();
  element('events').replaceChildren(...state.events.slice(0, 8).map(event => {
    const row = document.createElement('li');
    const kind = document.createElement('b');
    const name = document.createElement('span');
    kind.textContent = event.kind;
    name.textContent = event.name;
    row.append(kind, name);
    return row;
  }));
}

try {
  await init();
  placeCanvas();
  // GPUI constructs its window asynchronously after Wasm init returns.
  let sourceText = '';
  for (let attempt = 0; attempt < 600; attempt++) {
    sourceText = gpui_source();
    if (sourceText) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (!sourceText) throw new Error('GPUI ocağı henüz hazır değil. Sayfayı yenileyip tekrar dene.');
  source = JSON.parse(sourceText);
  document.querySelector('.tabs').replaceChildren(...sections.map(([key, label]) => {
    const button = document.createElement('button');
    button.textContent = label;
    button.dataset.section = key;
    button.onclick = () => { selected = key; renderCode(); };
    return button;
  }));
  renderCode();
  refresh();
  setInterval(refresh, 120);
  element('status').textContent = 'GPUI hazır. Bir masadan sipariş al.';
} catch (error) {
  element('status').textContent = `Başlatma sorunu: ${error.message}`;
  console.error(error);
}
