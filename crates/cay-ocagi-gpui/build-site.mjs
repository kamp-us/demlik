import {execFileSync} from 'node:child_process';
import {mkdir,copyFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const here=dirname(fileURLToPath(import.meta.url));
const dist=resolve(process.argv[2]||`${here}/dist`);
await mkdir(dist,{recursive:true});
execFileSync(process.env.WASM_BINDGEN||'wasm-bindgen',[
 `${here}/target/wasm32-unknown-unknown/release/cay_ocagi_gpui.wasm`,
 '--target','web','--out-dir',`${here}/target/web`,'--out-name','cay_ocagi_gpui'
],{stdio:'inherit'});
for(const file of ['cay_ocagi_gpui.js','cay_ocagi_gpui_bg.wasm'])await copyFile(`${here}/target/web/${file}`,`${dist}/${file}`);
for(const file of ['GPUI-LICENSE-APACHE.txt','IBM-Plex-LICENSE.txt','IBMPlexSans-Regular.ttf'])await copyFile(`${here}/assets/${file}`,`${dist}/${file}`);
console.log(`GPUI static assets: ${dist}`);

for(const file of ['index.html','style.css','app.js'])await copyFile(`${here}/web/${file}`,`${dist}/${file}`);
