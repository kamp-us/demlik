/** One inline HTML string. No build step, no framework, no CDN. */
export const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Durable checkout saga</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 32px;
    font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    background: #0e1116; color: #d8dee9;
  }
  main { max-width: 880px; margin: 0 auto; }
  h1 { font-size: 20px; margin: 0 0 4px; letter-spacing: -0.01em; }
  p.lede { margin: 0 0 28px; color: #8b96a5; max-width: 62ch; }
  .states { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 22px; }
  .state {
    flex: 1 1 120px; min-width: 110px; padding: 14px 12px; border-radius: 10px;
    border: 1px solid #232a33; background: #151a21; text-align: center;
    font-weight: 600; font-size: 13px; letter-spacing: .04em;
    text-transform: uppercase; color: #59636f; transition: all .18s ease;
  }
  .state.on { color: #0e1116; transform: translateY(-2px); }
  .state.on[data-s="paying"], .state.on[data-s="reserving"], .state.on[data-s="refunding"] {
    background: #e5b567; border-color: #e5b567;
  }
  .state.on[data-s="settled"] { background: #7ec699; border-color: #7ec699; }
  .state.on[data-s="failed"] { background: #e07a7a; border-color: #e07a7a; }
  .state.on[data-s="idle"] { background: #7f8b99; border-color: #7f8b99; }
  .facts {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 12px; margin-bottom: 22px;
  }
  .fact { background: #151a21; border: 1px solid #232a33; border-radius: 10px; padding: 12px 14px; }
  .fact dt { margin: 0 0 4px; font-size: 11px; letter-spacing: .07em; text-transform: uppercase; color: #6b7685; }
  .fact dd { margin: 0; font-size: 17px; font-variant-numeric: tabular-nums; }
  .bar { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 22px; }
  button {
    font: inherit; font-weight: 600; padding: 10px 16px; border-radius: 8px;
    border: 1px solid #2c343f; background: #1b222b; color: #d8dee9; cursor: pointer;
  }
  button:hover { background: #222b35; }
  button.danger { border-color: #6d2f2f; background: #2a1719; color: #f0a5a5; }
  button.danger:hover { background: #391c1f; }
  input {
    font: inherit; padding: 10px 12px; border-radius: 8px;
    border: 1px solid #2c343f; background: #11161c; color: #d8dee9; width: 150px;
  }
  #log {
    background: #11161c; border: 1px solid #232a33; border-radius: 10px;
    padding: 14px 16px; margin: 0; min-height: 160px; max-height: 340px; overflow: auto;
    font: 12.5px/1.7 ui-monospace, SFMono-Regular, Menlo, monospace; color: #9fb0c3;
    white-space: pre-wrap;
  }
  .hint { color: #6b7685; font-size: 13px; margin-top: 18px; }
</style>
</head>
<body>
<main>
  <h1>Durable checkout saga</h1>
  <p class="lede">
    The retry ladder lives in the reducer, so it lives in storage. Start an order,
    wait for the payment to be declined, then kill the Durable Object mid-retry.
    The isolate dies; the saga does not.
  </p>

  <div class="states" id="states"></div>

  <dl class="facts">
    <div class="fact"><dt>Order</dt><dd id="f-order">—</dd></div>
    <div class="fact"><dt>Attempt</dt><dd id="f-attempt">—</dd></div>
    <div class="fact"><dt>Next retry in</dt><dd id="f-retry">—</dd></div>
    <div class="fact"><dt>Payment ref</dt><dd id="f-ref">—</dd></div>
  </dl>

  <div class="bar">
    <input id="order" value="order-1" aria-label="order id" />
    <button id="start">Start order</button>
    <button id="crash" class="danger">💥 Kill the Durable Object</button>
    <button id="reset">Reset</button>
  </div>

  <pre id="log">no events yet</pre>
  <p class="hint">Order ids containing <code>oos</code> are out of stock — that runs the refund compensation path.</p>
</main>
<script>
  var PHASES = ["idle", "paying", "reserving", "refunding", "settled", "failed"];
  var statesEl = document.getElementById("states");
  PHASES.forEach(function (p) {
    var d = document.createElement("div");
    d.className = "state"; d.dataset.s = p; d.textContent = p; d.id = "s-" + p;
    statesEl.appendChild(d);
  });

  function order() { return document.getElementById("order").value || "order-1"; }
  function post(path) {
    return fetch(path + "?order=" + encodeURIComponent(order()), { method: "POST" })
      .then(function (r) { return r.json(); })
      .catch(function () { return null; });
  }

  document.getElementById("start").onclick = function () { post("/order/start").then(render); };
  document.getElementById("crash").onclick = function () { post("/order/crash").then(function () { poll(); }); };
  document.getElementById("reset").onclick = function () { post("/order/reset").then(render); };

  function render(s) {
    if (!s) return;
    PHASES.forEach(function (p) {
      document.getElementById("s-" + p).classList.toggle("on", s.phase === p);
    });
    document.getElementById("f-order").textContent = s.orderId || "—";
    document.getElementById("f-attempt").textContent = s.attempt || "—";
    document.getElementById("f-retry").textContent =
      s.retryInMs === null || s.retryInMs === undefined ? "—" : (s.retryInMs / 1000).toFixed(1) + "s";
    document.getElementById("f-ref").textContent = s.paymentRef || "—";
    var log = document.getElementById("log");
    log.textContent = (s.log || []).length
      ? s.log.map(function (l) {
          return new Date(l.at).toISOString().slice(11, 23) + "  " + l.text;
        }).join("\\n")
      : "no events yet";
    log.scrollTop = log.scrollHeight;
  }

  function poll() {
    fetch("/order/state?order=" + encodeURIComponent(order()))
      .then(function (r) { return r.json(); })
      .then(render)
      .catch(function () {});
  }
  poll();
  setInterval(poll, 500);
</script>
</body>
</html>`;
