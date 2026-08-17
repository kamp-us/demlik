/** One inline HTML string. No build step, no framework, no CDN. */
export const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>What happens to your retries when the server dies</title>
<style>
  :root {
    color-scheme: dark;
    --bg: #0e1116; --card: #151a21; --line: #232a33; --ink: #d8dee9;
    --dim: #7b8695; --amber: #e5b567; --green: #7ec699; --red: #e07a7a;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 28px 24px 64px;
    font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    background: var(--bg); color: var(--ink);
  }
  main { max-width: 1080px; margin: 0 auto; }
  h1 { font-size: 22px; margin: 0 0 6px; letter-spacing: -0.015em; }
  p.lede { margin: 0 0 24px; color: var(--dim); max-width: 68ch; }

  /* ── controls ─────────────────────────────────────────────────────────── */
  .bar { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-bottom: 10px; }
  button {
    font: inherit; font-weight: 600; padding: 10px 16px; border-radius: 8px;
    border: 1px solid #2c343f; background: #1b222b; color: var(--ink); cursor: pointer;
  }
  button:hover:not(:disabled) { background: #222b35; }
  button:disabled { opacity: .55; cursor: not-allowed; }
  button.kill {
    border-color: #7e3232; background: #35181c; color: #ffb4b4; font-size: 16px; padding: 10px 20px;
  }
  button.kill:hover:not(:disabled) { background: #4a1f24; }
  button.kill.spent { border-color: #4a2b2b; background: #221417; color: #8a6a6a; }
  input {
    font: inherit; padding: 10px 12px; border-radius: 8px;
    border: 1px solid #2c343f; background: #11161c; color: var(--ink); width: 140px;
  }
  #notice { min-height: 22px; margin: 0 0 18px; font-size: 13px; font-weight: 600; color: var(--amber); }

  /* ── lanes ────────────────────────────────────────────────────────────── */
  .lanes { display: grid; grid-template-columns: repeat(auto-fit, minmax(400px, 1fr)); gap: 18px; }
  .lane {
    background: var(--card); border: 1px solid var(--line); border-radius: 12px;
    padding: 18px 18px 16px; transition: border-color .2s ease, box-shadow .2s ease, opacity .2s ease;
  }
  .lane.dead {
    border-color: #7e3232; box-shadow: 0 0 0 1px #7e3232 inset, 0 0 28px -12px #e07a7a;
  }
  .lane.dead .stack, .lane.dead .dots, .lane.dead .facts { opacity: .45; }
  .lane h2 { font-size: 15px; margin: 0 0 3px; letter-spacing: -0.005em; }
  .lane .sub { margin: 0 0 14px; font-size: 13px; color: var(--dim); min-height: 36px; }
  .lane.dead .sub.hardened { color: #f0a5a5; font-weight: 600; }

  .stack { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 14px; }
  .st {
    flex: 1 1 auto; padding: 8px 6px; border-radius: 7px; border: 1px solid var(--line);
    background: #11161c; text-align: center; font-size: 10.5px; font-weight: 700;
    letter-spacing: .06em; text-transform: uppercase; color: #59636f; transition: all .18s ease;
  }
  .st.on { color: #0e1116; }
  .st.on[data-s="idle"] { background: #7f8b99; border-color: #7f8b99; }
  .st.on[data-s="paying"], .st.on[data-s="reserving"], .st.on[data-s="refunding"] {
    background: var(--amber); border-color: var(--amber);
  }
  .st.on[data-s="settled"] { background: var(--green); border-color: var(--green); }
  .st.on[data-s="failed"] { background: var(--red); border-color: var(--red); }

  /* ── retry ladder ─────────────────────────────────────────────────────── */
  .ladder { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; flex-wrap: wrap; }
  .dots { display: flex; gap: 7px; }
  .dot {
    width: 22px; height: 22px; border-radius: 50%; border: 2px solid #2c343f;
    background: #11161c; display: grid; place-items: center;
    font-size: 10px; font-weight: 700; color: #59636f; transition: all .2s ease;
  }
  .dot.failed { border-color: var(--red); background: #2a1719; color: #f0a5a5; }
  .dot.ok { border-color: var(--green); background: #17291f; color: #a8dcbc; }
  .dot.pending { border-color: var(--amber); color: var(--amber); animation: pulse 1.1s ease-in-out infinite; }
  @keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: .35 } }
  .countdown { font-size: 13px; color: var(--dim); font-variant-numeric: tabular-nums; }
  .countdown b { color: var(--amber); font-variant-numeric: tabular-nums; }

  .facts { display: flex; flex-wrap: wrap; gap: 16px; margin-bottom: 12px; font-size: 12px; color: var(--dim); }
  .facts b { color: var(--ink); font-weight: 600; font-variant-numeric: tabular-nums; }

  .banner { border-radius: 8px; padding: 9px 12px; font-size: 13px; font-weight: 600; margin-bottom: 12px; }
  .banner.good { background: #17291f; border: 1px solid #2f6b46; color: #a8dcbc; }
  .banner.bad  { background: #2a1719; border: 1px solid #7e3232; color: #f0a5a5; }

  .feed {
    background: #0c1015; border: 1px solid var(--line); border-radius: 9px;
    padding: 10px 12px; margin: 0; height: 220px; overflow: auto;
    font: 12px/1.65 ui-monospace, SFMono-Regular, Menlo, monospace; color: #9fb0c3;
  }
  .feed .row { display: flex; gap: 10px; }
  .feed .t { color: #4d5866; flex: none; }
  .feed .boom {
    margin: 8px -12px; padding: 5px 12px; background: #7e3232; color: #fff;
    font-weight: 700; letter-spacing: .06em; text-align: center; border-radius: 2px;
  }

  .shake { animation: shake .45s cubic-bezier(.36,.07,.19,.97); }
  @keyframes shake {
    10%,90% { transform: translateX(-2px) } 20%,80% { transform: translateX(4px) }
    30%,50%,70% { transform: translateX(-7px) } 40%,60% { transform: translateX(7px) }
  }
  #flash {
    position: fixed; inset: 0; background: #e07a7a; opacity: 0;
    pointer-events: none; z-index: 9; transition: opacity .38s ease;
  }
  #flash.on { opacity: .3; transition: opacity .04s ease; }
  .hint { color: #6b7685; font-size: 13px; margin-top: 20px; }
  code { color: #b6c2d1; }
</style>
</head>
<body>
<div id="flash"></div>
<main>
  <h1>What happens to your retries when the server dies</h1>
  <p class="lede">
    Two copies of the same checkout. The card issuer declines the first two attempts,
    so both have to wait and retry. Start them, then press the red button to destroy
    the machine they are running on. One of them finishes anyway.
  </p>

  <div class="bar">
    <input id="order" value="order-1" aria-label="order id" />
    <button id="start">Start both orders</button>
    <button id="kill" class="kill">💥 Kill the server</button>
    <button id="reset">Reset</button>
  </div>
  <p id="notice"></p>

  <div class="lanes">
    <section class="lane" id="lane-naive">
      <h2>A · The ordinary way</h2>
      <p class="sub" id="sub-naive">
        The retry is a timer held in the server's memory — a sleep inside a running function.
      </p>
      <div class="stack" data-stack="naive"></div>
      <div class="ladder">
        <div class="dots" data-dots="naive"></div>
        <span class="countdown" data-cd="naive">—</span>
      </div>
      <div class="facts">
        <span>attempt <b data-f="naive-attempt">—</b></span>
        <span>last progress <b data-f="naive-seen">—</b></span>
        <span>payment <b data-f="naive-ref">—</b></span>
      </div>
      <div data-banner="naive"></div>
      <div class="feed" data-feed="naive"></div>
    </section>

    <section class="lane" id="lane-tea">
      <h2>B · With demlik/tea</h2>
      <p class="sub" id="sub-tea">
        The retry is written down — which attempt, and when the next one is due — so anything can pick it up.
      </p>
      <div class="stack" data-stack="tea"></div>
      <div class="ladder">
        <div class="dots" data-dots="tea"></div>
        <span class="countdown" data-cd="tea">—</span>
      </div>
      <div class="facts">
        <span>attempt <b data-f="tea-attempt">—</b></span>
        <span>last progress <b data-f="tea-seen">—</b></span>
        <span>payment <b data-f="tea-ref">—</b></span>
      </div>
      <div data-banner="tea"></div>
      <div class="feed" data-feed="tea"></div>
    </section>
  </div>

  <p class="hint">
    An order id containing <code>oos</code> is out of stock — that runs the refund path instead.
  </p>
</main>

<script>
(function () {
  var PHASES = ["idle", "paying", "reserving", "refunding", "settled", "failed"];
  var LANES = ["naive", "tea"];
  var MAX_ATTEMPTS = 4;

  var q = function (s) { return document.querySelector(s); };
  var crashAt = null;         // client-side instant of the explosion
  var killed = false;
  var last = { naive: null, tea: null };
  var pollTimer = null;

  LANES.forEach(function (lane) {
    var stack = document.querySelector('[data-stack="' + lane + '"]');
    PHASES.forEach(function (p) {
      var d = document.createElement("div");
      d.className = "st"; d.dataset.s = p; d.textContent = p;
      d.id = "st-" + lane + "-" + p;
      stack.appendChild(d);
    });
    var dots = document.querySelector('[data-dots="' + lane + '"]');
    for (var i = 1; i <= MAX_ATTEMPTS; i++) {
      var dot = document.createElement("div");
      dot.className = "dot"; dot.textContent = String(i);
      dot.id = "dot-" + lane + "-" + i;
      dots.appendChild(dot);
    }
  });

  function order() { return q("#order").value.trim() || "order-1"; }
  function notice(text, color) {
    var el = q("#notice");
    el.textContent = text || "";
    el.style.color = color || "var(--amber)";
  }
  function clock(ms) { return new Date(ms).toISOString().slice(11, 19); }

  // ── the explosion, client-side and INSTANT ───────────────────────────────
  function detonate() {
    crashAt = Date.now();
    killed = true;

    var flash = q("#flash");
    flash.classList.add("on");
    setTimeout(function () { flash.classList.remove("on"); }, 60);
    document.querySelector("main").classList.add("shake");
    setTimeout(function () { document.querySelector("main").classList.remove("shake"); }, 460);

    var kill = q("#kill");
    kill.disabled = true;
    kill.classList.add("spent");
    kill.textContent = "💥 killing…";
    setTimeout(function () { kill.textContent = "☠️ isolate destroyed"; }, 500);

    LANES.forEach(function (lane) {
      q("#lane-" + lane).classList.add("dead");
      var feed = document.querySelector('[data-feed="' + lane + '"]');
      var boom = document.createElement("div");
      boom.className = "boom";
      boom.textContent = "💥 isolate destroyed — " + clock(crashAt);
      feed.appendChild(boom);
      feed.scrollTop = feed.scrollHeight;
      setBanner(lane, "bad", "☠️ isolate destroyed — waiting to see who comes back");
    });
    notice("Server destroyed. Watch which order keeps moving.", "#f0a5a5");
  }

  function setBanner(lane, kind, text) {
    var host = document.querySelector('[data-banner="' + lane + '"]');
    host.innerHTML = "";
    if (!text) return;
    var b = document.createElement("div");
    b.className = "banner " + kind;
    b.textContent = text;
    host.appendChild(b);
  }

  // ── rendering ────────────────────────────────────────────────────────────
  function renderLane(lane, s) {
    if (!s) return;
    last[lane] = s;

    PHASES.forEach(function (p) {
      q("#st-" + lane + "-" + p).classList.toggle("on", s.phase === p);
    });

    for (var i = 1; i <= MAX_ATTEMPTS; i++) {
      var dot = q("#dot-" + lane + "-" + i);
      dot.className = "dot";
      if (i < s.attempt) dot.classList.add("failed");
      else if (i === s.attempt) {
        if (s.paymentRef) dot.classList.add("ok");
        else if (s.nextRetryAt !== null) dot.classList.add("failed");
        else if (!s.terminal) dot.classList.add("pending");
        else dot.classList.add("failed");
      }
    }

    var cd = document.querySelector('[data-cd="' + lane + '"]');
    if (s.terminal) {
      cd.textContent = s.phase === "settled" ? "done" : "finished (failed)";
    } else if (s.nextRetryAt !== null) {
      var left = Math.max(0, s.nextRetryAt - Date.now());
      cd.innerHTML = s.frozen
        ? "next retry was due <b>" + (left === 0 ? "already" : "in " + (left / 1000).toFixed(1) + "s") + "</b> — but no one is holding it"
        : "next retry in <b>" + (left / 1000).toFixed(1) + "s</b>";
    } else if (s.phase === "idle") {
      cd.textContent = "not started";
    } else {
      cd.textContent = "working…";
    }

    q('[data-f="' + lane + '-attempt"]').textContent = s.attempt || "—";
    q('[data-f="' + lane + '-seen"]').textContent =
      s.staleForMs === null ? "—" : (s.staleForMs / 1000).toFixed(1) + "s ago";
    q('[data-f="' + lane + '-ref"]').textContent = s.paymentRef || "—";

    // Event feed: server log, with the client-side crash divider spliced in.
    var feed = document.querySelector('[data-feed="' + lane + '"]');
    var atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 30;
    feed.innerHTML = "";
    var wroteBoom = crashAt === null;
    (s.log || []).forEach(function (l) {
      if (!wroteBoom && l.at > crashAt) {
        var boom = document.createElement("div");
        boom.className = "boom";
        boom.textContent = "💥 isolate destroyed — " + clock(crashAt);
        feed.appendChild(boom);
        wroteBoom = true;
      }
      var row = document.createElement("div");
      row.className = "row";
      var t = document.createElement("span");
      t.className = "t"; t.textContent = clock(l.at);
      var x = document.createElement("span");
      x.textContent = l.text;
      row.appendChild(t); row.appendChild(x);
      feed.appendChild(row);
    });
    if (!wroteBoom) {
      var tail = document.createElement("div");
      tail.className = "boom";
      tail.textContent = "💥 isolate destroyed — " + clock(crashAt);
      feed.appendChild(tail);
    }
    if (!s.log || !s.log.length) feed.textContent = "no events yet";
    if (atBottom) feed.scrollTop = feed.scrollHeight;

    // Post-crash verdict.
    var card = q("#lane-" + lane);
    var sub = q("#sub-" + lane);
    if (crashAt === null) return;

    var movedSince = (s.log || []).some(function (l) { return l.at > crashAt; });
    if (lane === "tea") {
      if (movedSince || s.terminal) {
        card.classList.remove("dead");
        setBanner("tea", "good",
          s.terminal
            ? "✅ resumed from storage and finished — " + s.phase + " on attempt " + s.attempt
            : "✅ resumed from storage at attempt " + s.attempt);
      }
    } else {
      if (s.frozen) {
        card.classList.add("dead");
        sub.classList.add("hardened");
        sub.textContent = "Nothing is coming. The retry died with the process — the order says \\u201cretrying\\u2026\\u201d and will say it forever.";
        setBanner("naive", "bad", "☠️ frozen at attempt " + s.attempt + " — no timer, no alarm, nobody scheduled to continue");
      } else if (s.terminal) {
        card.classList.remove("dead");
        setBanner("naive", "good", "finished — " + s.phase);
      }
    }
  }

  function inFlight(s) { return s && s.phase !== "idle" && !s.terminal && !s.frozen; }
  function settledOrDead(s) { return s && (s.terminal || s.frozen); }

  // ── polling ──────────────────────────────────────────────────────────────
  function tick() {
    fetch("/both/state?order=" + encodeURIComponent(order()))
      .then(function (r) { return r.json(); })
      .then(function (d) {
        renderLane("naive", d.naive);
        renderLane("tea", d.tea);

        var a = d.naive, b = d.tea;
        if (settledOrDead(a) && settledOrDead(b)) {
          // Both lanes are done moving. Stop polling entirely — the quiet is
          // part of the story.
          clearTimeout(pollTimer); pollTimer = null;
          if (killed) {
            notice("Lane B finished after the crash. Lane A never will. Polling stopped.", "var(--green)");
          }
          return;
        }
        schedule(inFlight(a) || inFlight(b) ? 500 : 2000);
      })
      .catch(function () { schedule(2000); });
  }
  function schedule(ms) {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(tick, ms);
  }

  // ── controls ─────────────────────────────────────────────────────────────
  q("#start").onclick = function () {
    fetch("/both/start?order=" + encodeURIComponent(order()), { method: "POST" })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        notice("Both orders started. First two payment attempts will be declined.", "var(--dim)");
        renderLane("naive", d.naive); renderLane("tea", d.tea);
        schedule(300);
      })
      .catch(function () { notice("Could not start the order.", "#f0a5a5"); });
  };

  q("#kill").onclick = function () {
    if (!inFlight(last.naive) && !inFlight(last.tea)) {
      notice("Start an order first — there is nothing in flight to interrupt.", "#f0a5a5");
      return;
    }
    // Fire the visuals BEFORE the request. The explosion is not something the
    // viewer should have to wait for a poll to believe.
    detonate();
    fetch("/both/crash?order=" + encodeURIComponent(order()), { method: "POST" })
      .then(function () { schedule(250); })
      .catch(function () {
        notice("The kill request failed — the server may already be gone. Still polling.", "#f0a5a5");
        schedule(250);
      });
  };

  q("#reset").onclick = function () {
    fetch("/both/reset?order=" + encodeURIComponent(order()), { method: "POST" })
      .then(function () { location.reload(); })
      .catch(function () { location.reload(); });
  };

  schedule(0);
})();
</script>
</body>
</html>`;
