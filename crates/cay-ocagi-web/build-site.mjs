import {readFile, writeFile, copyFile, mkdir} from 'node:fs/promises';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const destination = resolve(process.argv[2] || `${root}/crates/cay-ocagi-web/dist`);
const demo = `${root}/crates/tea/examples/cay_ocagi`;
await mkdir(destination,{recursive:true});
let html = await readFile(`${demo}/index.html`,'utf8');
html = html.replace('<script src="/app.js" defer>', '<script src="/wasm-host.js" defer></script><script src="/app.js" defer>')
 .replace('a living Rust example','Rust · browser edition')
 .replace('Rust’a bağlanıyor','Wasm yükleniyor')
 .replace('RUST <i>','WASM <i>')
 .replace('Çalışan native runtime','Çalışan Rust / Wasm makinesi')
 .replace('Tarayıcı → gerçek Rust işlemi','Bu sekme → gerçek Rust / Wasm')
 .replace('Demlik TEA · Native Rust runtime · 127.0.0.1','Demlik TEA · Rust / Wasm · Her ziyaretçiye ayrı ocak')
 .replace('data-tab="channel">Channel</button>','data-tab="channel">Channel</button><button role="tab" aria-selected="false" data-tab="runtime">Host</button>')
 .replace('<div class="eyebrow" id="detail-eyebrow">NATIVE RUST</div>','<div class="eyebrow" id="detail-eyebrow">BROWSER RUST / WASM</div>')
 .replace('Interpreter bekler ve sonucu yeni bir Msg olarak getirir.','Tarayıcı host’u Rust saatini ilerletir; Rust, iş bitince sonucu Msg olarak inbox’a yollar.')
 .replace('<button id="guided-start"','<p class="private-note">Bu ocak yalnızca bu sekmede yaşar. Diğer ziyaretçilerin siparişleri seninkilerle karışmaz. Sayfayı yenilemek yeni bir vardiya açar.</p><button id="guided-start"');
await writeFile(`${destination}/index.html`,html);
for(const file of ['style.css','app.js']) await copyFile(`${demo}/${file}`,`${destination}/${file}`);
await copyFile(`${root}/crates/cay-ocagi-web/web/wasm-host.js`,`${destination}/wasm-host.js`);
execFileSync(process.env.WASM_BINDGEN || 'wasm-bindgen', [`${root}/target/wasm32-unknown-unknown/release/cay_ocagi_web.wasm`, '--target','web','--out-dir',`${root}/target/cay-web`,'--out-name','cay_ocagi_web']);
for (const file of ['cay_ocagi_web.js','cay_ocagi_web_bg.wasm']) await copyFile(`${root}/target/cay-web/${file}`,`${destination}/${file}`);
console.log(`Static Rust / Wasm site: ${destination}`);
