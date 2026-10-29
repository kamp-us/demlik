'use strict';
// Transport only: copy JSON bytes, call Wasm, supply elapsed time.
// Model, messages, inbox, clock, commands and completion decisions live in Rust.
(() => {
 const encoder = new TextEncoder(), decoder = new TextDecoder();
 let exports;
 function request(value) {
  const input = encoder.encode(JSON.stringify(value));
  const pointer = exports.tea_alloc(input.length);
  new Uint8Array(exports.memory.buffer, pointer, input.length).set(input);
  const resultPointer = exports.tea_request(pointer, input.length);
  const result = JSON.parse(decoder.decode(new Uint8Array(exports.memory.buffer, resultPointer, exports.tea_output_len())));
  if (result.error) throw new Error(result.error);
  return result.ok;
 }
 const ready = (async () => {
  const {default: init} = await import('./cay_ocagi_web.js');
  exports = await init();
  let previous = performance.now();
  const heartbeat = setInterval(() => {
   const now = performance.now();
   try { request({op:'advance', elapsed_ms:now-previous}); }
   catch (error) { clearInterval(heartbeat); window.dispatchEvent(new CustomEvent('tea-host-error',{detail:error.message})); }
   previous = now;
  },25);
 })();
 window.teaTransport = {
  profile:'browser-wasm', ready,
  action: async action => { await ready; return request({op:'action',action}); },
  state: async () => { await ready; return request({op:'state'}); },
  source: async () => { await ready; return request({op:'source'}); }
 };
})();
