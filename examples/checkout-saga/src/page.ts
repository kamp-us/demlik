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
  button:disabled { cursor: not-allowed; }
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
    padding: 18px 18px 16px; transition: border-color .2s ease, box-shadow .2s ease;
  }
  .lane.dead {
    border-color: #7e3232; box-shadow: 0 0 0 1px #7e3232 inset, 0 0 28px -12px #e07a7a;
  }
  .lane.dead .stack, .lane.dead .dots, .lane.dead .facts { opacity: .45; }
  .lane.revived { border-color: #2f6b46; box-shadow: 0 0 0 1px #2f6b46 inset, 0 0 28px -12px #7ec699; }
  .lane h2 { font-size: 15px; margin: 0 0 3px; letter-spacing: -0.005em; }
  .lane .sub { margin: 0 0 14px; font-size: 13px; color: var(--dim); min-height: 36px; }
  .lane .sub.hardened { color: #f0a5a5; font-weight: 600; }

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
  .banner.wait { background: #2a2417; border: 1px solid #6b5a2f; color: #e5cf9b; }
  .banner.wait .spin { animation: pulse 1.4s ease-in-out infinite; display: inline-block; }

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
  .feed .after { color: #a8dcbc; }

  .hint { color: #6b7685; font-size: 13px; margin-top: 20px; }
  code { color: #b6c2d1; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .92em; }

  /* ── implementation notes ─────────────────────────────────────────────── */
  .notes { margin-top: 34px; border-top: 1px solid var(--line); padding-top: 22px; }
  .notes h2 { font-size: 15px; margin: 0 0 12px; color: var(--dim); font-weight: 600; }
  .notes details {
    background: var(--card); border: 1px solid var(--line);
    border-radius: 10px; margin-bottom: 8px;
  }
  .notes summary {
    cursor: pointer; padding: 12px 16px; font-weight: 600; font-size: 14px;
    list-style: none; display: flex; align-items: center; gap: 9px;
  }
  .notes summary::-webkit-details-marker { display: none; }
  .notes summary::before {
    content: "+"; color: var(--dim); font-weight: 700; font-size: 15px;
    width: 12px; flex: none; text-align: center;
  }
  .notes details[open] summary::before { content: "\\2013"; }
  .notes summary:hover { background: #1a212a; border-radius: 10px; }
  .notes details[open] summary { border-bottom: 1px solid var(--line); border-radius: 10px 10px 0 0; }
  .notes .body, .notes details > p, .notes details > pre { margin: 0; }
  .notes details > p {
    padding: 12px 16px 0; color: #b3bfcd; font-size: 13.5px; line-height: 1.62; max-width: 78ch;
  }
  .notes details > p:last-child { padding-bottom: 15px; }
  .notes details > pre {
    margin: 12px 16px 4px; padding: 12px 14px; background: #0c1015;
    border: 1px solid var(--line); border-radius: 8px; overflow-x: auto;
    font: 12px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; color: #9fb0c3;
  }
  footer {
    margin-top: 30px; padding-top: 18px; border-top: 1px solid var(--line);
    color: #6b7685; font-size: 13px;
  }
  footer a { color: #9db4cc; }

  /*
   * The kill is deliberately UNDRAMATIC: no shake, no flash, no animation on
   * click. The information does the work — the button relabels, the cards go
   * dead, the divider lands in the feed. The only motion left is the slow
   * pulse marking "something is still pending", and it yields on request.
   */
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
      animation-duration: .001ms !important; animation-iteration-count: 1 !important;
      transition-duration: .001ms !important;
    }
  }
</style>
</head>
<body>
<main>
  <h1>What happens to your retries when the server dies</h1>
  <p class="lede">
    Two copies of the same checkout. The card issuer declines the first three attempts,
    so both have to wait and retry — about 20 seconds of it. Start them, then press the
    red button to destroy the machine they are running on. One of them finishes anyway.
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
      <p class="sub" id="sub-naive"></p>
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
      <p class="sub" id="sub-tea"></p>
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
    Each <strong>Start</strong> mints a fresh order id, so every run begins on a clean
    Durable Object. Type your own id to reuse one — an id containing <code>oos</code>
    is out of stock, which runs the refund path instead.
    <strong>Reset</strong> wipes the state of the id currently in the box.
  </p>

  <section class="notes">
    <h2>How this works</h2>

    <details>
      <summary>What the two lanes actually are</summary>
      <p>
        Both lanes run the same three steps — take the payment, reserve the stock, settle —
        and both talk to the same fake card processor, which declines the first three
        attempts and then accepts.
      </p>
      <p>
        <strong>Lane A</strong> keeps its retry ladder in memory. Which attempt it is on is a
        loop variable, and the wait before the next attempt is a <code>sleep</code> inside a
        function that is still running. It writes a status row to storage so a dashboard can
        read it, but the row is a report about the work, not the work itself.
      </p>
      <p>
        <strong>Lane B</strong> keeps the ladder in its state: the attempt number and the
        timestamp the next attempt is due are ordinary fields, and every change to them is
        saved to Durable Object storage before anything else happens. The wait is not a sleep
        — it is a Durable Object alarm set for that timestamp. Nothing is holding the retry
        in memory, because nothing needs to.
      </p>
    </details>

    <details>
      <summary>What the kill button really does</summary>
      <p>
        It calls <code>ctx.abort()</code> inside the Durable Object. That is not a simulated
        failure or a thrown error — it destroys the isolate immediately. Running functions do
        not get to finish, pending timers never fire, and nothing gets a chance to clean up
        or flush.
      </p>
      <p>
        Lane A loses the only thing that was going to continue the order, so its status row
        stays at "retrying…" forever. Lane B loses nothing that mattered: the state was
        already saved and the alarm was already registered with the platform. When the alarm
        comes due, the platform starts a brand new isolate, that isolate loads the saved state
        back through the Store, and the saga carries on from the attempt it was on.
      </p>
      <p>
        This is why the two lanes diverge from one button press. The difference is not
        reliability engineering — it is where the retry was written down.
      </p>
    </details>

    <details>
      <summary>Where Effect fits in</summary>
      <p>
        Lane B's side effects are Effect programs. Taking the payment is an
        <code>Effect.gen</code> that pulls a <code>Payments</code> service out of the context,
        calls it, and folds the typed failure into a message the state machine understands:
      </p>
      <pre>Effect.gen(function* () {
  const payments = yield* Payments
  const ref = yield* payments.charge({ orderId, amountCents, attempt })
  return { type: "payment_ok", ref, at: Date.now() }
}).pipe(
  Effect.catchTag("PaymentDeclined", (e) =>
    Effect.succeed({ type: "payment_failed", reason: e.reason, at: Date.now() })
  )
)</pre>
      <p>
        The services come from a <code>Layer</code>, and the Durable Object builds one
        <code>ManagedRuntime</code> from that Layer per instance.
        <code>toInterpret</code> from <code>@demlik/tea/effect</code> lowers the whole
        dictionary of these programs into the handler table tea already knows how to run. The
        bridge insists every handler's error channel is discharged inside the effect, which is
        why <code>catchTag</code> is there: a declined card is not an exception, it is a
        transition.
      </p>
      <p>
        What Effect does <em>not</em> own here is the retrying. There is no
        <code>Schedule</code>, no <code>retry</code> combinator, no long-lived fiber holding
        the ladder — because all of those live in the process, and the whole point of the demo
        is the process dying. The decision to retry, the attempt count and the due time are
        state in a pure reducer; Effect is used for the one thing it is genuinely better at,
        which is describing a single effectful call and its typed failures.
      </p>
    </details>
  </section>

  <footer>
    Source: <a href="https://github.com/kamp-us/demlik">github.com/kamp-us/demlik</a>
    — the demo lives in <code>examples/checkout-saga</code>, built on
    <code>@demlik/tea</code> and its <code>/effect</code> bridge.
  </footer>
</main>

<script>
(function () {
  var PHASES = ["idle", "paying", "reserving", "refunding", "settled", "failed"];
  var LANES = ["naive", "tea"];
  var MAX_ATTEMPTS = 5;

  var SUB_BASE = {
    naive: "The retry is a timer held in the server's memory — a sleep inside a running function.",
    tea: "The retry is written down — which attempt, and when the next one is due — so anything can pick it up."
  };
  var SUB_DEAD = "Nothing is coming. The retry died with the process — the order says \\u201cretrying\\u2026\\u201d and will say it forever.";

  var q = function (s) { return document.querySelector(s); };
  var last = { naive: null, tea: null };
  var pollTimer = null;

  // ── the crash is a FACT, not a transient ─────────────────────────────────
  // It used to live in a closure variable, which meant every re-render (and
  // every reload) forgot the explosion ever happened — the exact bug this demo
  // is about, reproduced in the UI. So it gets written down, keyed by order,
  // and every visual below is derived from it rather than set imperatively.
  var crashedAt = null;
  var killingUntil = 0;

  function crashKey() { return "crash:" + order(); }
  function ss(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }
  function ssSet(k, v) { try { sessionStorage.setItem(k, v); } catch (e) {} }

  /**
   * Every run gets a FRESH order id.
   *
   * Reusing an id meant inheriting the previous run's Durable Object — its
   * persisted saga, its armed alarm, and (across a wrangler restart) its
   * leftover .wrangler state. That made every second demo start from a
   * half-dead order instead of from nothing. A new id is a new object, which
   * is the only reliably clean slate.
   *
   * The id is persisted so a RELOAD keeps showing the run you were watching
   * (crash chrome included); only pressing Start mints a new one.
   */
  function freshOrderId() {
    var alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
    var out = "";
    for (var i = 0; i < 4; i++) {
      out += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
    }
    return "order-" + out;
  }
  function loadCrash() {
    var raw = null;
    try { raw = sessionStorage.getItem(crashKey()); } catch (e) { raw = null; }
    crashedAt = raw === null ? null : Number(raw);
    if (crashedAt !== null && !isFinite(crashedAt)) crashedAt = null;
  }
  function saveCrash(ts) {
    crashedAt = ts;
    try { sessionStorage.setItem(crashKey(), String(ts)); } catch (e) {}
  }
  function forgetCrash() {
    crashedAt = null;
    try { sessionStorage.removeItem(crashKey()); } catch (e) {}
  }

  LANES.forEach(function (lane) {
    q("#sub-" + lane).textContent = SUB_BASE[lane];
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

  /** Has this lane produced any progress since the explosion? */
  function progressedSinceCrash(s) {
    if (crashedAt === null || !s) return false;
    if (s.lastSeenAt && s.lastSeenAt > crashedAt) return true;
    return (s.log || []).some(function (l) { return l.at > crashedAt; });
  }

  // ── the kill: recorded immediately, reported calmly ─────────────────────
  // No shake, no flash. The viewer is told what happened in words and colour,
  // and the telling survives every subsequent render.
  function detonate(serverAt) {
    // Anchor on the SERVER's clock — the same clock that stamps the event log,
    // so the divider lands exactly between the last pre-crash event and the
    // first post-crash one. The old anchor ("newest event I had polled") put
    // anything that happened between the last poll and the kill on the wrong
    // side of the divider.
    saveCrash(serverAt || Date.now());
    killingUntil = Date.now() + 600;
    setTimeout(renderChrome, 650);

    LANES.forEach(function (lane) { renderLane(lane, last[lane]); });
    notice("Server destroyed. Watch which order keeps moving.", "#f0a5a5");
  }

  /**
   * Kill-button state, DERIVED — so neither a poll re-render nor a reload can
   * revert it. killingUntil is the only transient, and it is a timestamp
   * rather than a one-shot mutation, so recomputing is always safe.
   */
  function renderChrome() {
    var kill = q("#kill");
    if (crashedAt !== null) {
      kill.disabled = true;
      kill.classList.add("spent");
      kill.textContent =
        Date.now() < killingUntil ? "💥 killing…" : "☠️ isolate destroyed";
    } else {
      kill.disabled = false;
      kill.classList.remove("spent");
      kill.textContent = "💥 Kill the server";
    }
  }

  function setBanner(lane, kind, html) {
    var host = document.querySelector('[data-banner="' + lane + '"]');
    host.innerHTML = "";
    if (!html) return;
    var b = document.createElement("div");
    b.className = "banner " + kind;
    b.innerHTML = html;
    host.appendChild(b);
  }

  // ── rendering: a pure function of (crashedAt, server state) ──────────────
  function renderLane(lane, s) {
    if (!s) return;
    last[lane] = s;
    var revived = progressedSinceCrash(s);

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
    } else if (crashedAt !== null && !revived && s.phase !== "idle") {
      cd.textContent =
        lane === "tea" ? "waiting for a fresh isolate…" : "no one is holding this";
    } else if (s.nextRetryAt !== null) {
      var left = Math.max(0, s.nextRetryAt - Date.now());
      cd.innerHTML = s.frozen
        ? "next retry was due <b>" +
          (left === 0 ? "already" : "in " + (left / 1000).toFixed(1) + "s") +
          "</b> — but no one is holding it"
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

    renderFeed(lane, s);

    // ── card state + banner, both derived ─────────────────────────────────
    var card = q("#lane-" + lane);
    var sub = q("#sub-" + lane);
    var dead = crashedAt !== null && !revived;
    card.classList.toggle("dead", dead);
    card.classList.toggle("revived", crashedAt !== null && revived && lane === "tea");

    var frozenForGood = s.frozen && crashedAt !== null;
    sub.classList.toggle("hardened", frozenForGood);
    sub.textContent = frozenForGood ? SUB_DEAD : SUB_BASE[lane];

    if (crashedAt === null) { setBanner(lane, "good", null); return; }

    if (lane === "tea") {
      if (revived && s.terminal) {
        setBanner("tea", "good",
          "✅ resumed from storage and finished — " + s.phase + " on attempt " + s.attempt);
      } else if (revived) {
        setBanner("tea", "good", "✅ resumed from storage at attempt " + s.attempt);
      } else if (s.terminal) {
        setBanner("tea", "good", "finished before the crash — " + s.phase);
      } else {
        // The gap between the kill and the alarm is real (~10-15s locally).
        // Name it, so the silence reads as suspense rather than breakage.
        setBanner("tea", "wait",
          '<span class="spin">⏳</span> isolate destroyed — waiting for the Durable Object alarm to wake a fresh one…');
      }
      return;
    }

    if (s.frozen) {
      setBanner("naive", "bad",
        "☠️ frozen at attempt " + s.attempt + " — no timer, no alarm, nobody scheduled to continue");
    } else if (s.terminal) {
      setBanner("naive", revived ? "good" : "bad",
        revived ? "finished — " + s.phase : "finished before the crash — " + s.phase);
    } else {
      setBanner("naive", "bad", "☠️ isolate destroyed");
    }
  }

  /** The feed, with the crash divider spliced back in at its real position. */
  function renderFeed(lane, s) {
    var feed = document.querySelector('[data-feed="' + lane + '"]');
    var atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 30;
    feed.innerHTML = "";

    var log = s.log || [];
    if (!log.length && crashedAt === null) {
      feed.textContent = "no events yet";
      return;
    }

    var wroteBoom = crashedAt === null;
    function boom() {
      var b = document.createElement("div");
      b.className = "boom";
      b.textContent = "💥 isolate destroyed — " + clock(crashedAt);
      feed.appendChild(b);
      wroteBoom = true;
    }

    log.forEach(function (l) {
      if (!wroteBoom && l.at > crashedAt) boom();
      var row = document.createElement("div");
      row.className = "row" + (crashedAt !== null && l.at > crashedAt ? " after" : "");
      var t = document.createElement("span");
      t.className = "t"; t.textContent = clock(l.at);
      var x = document.createElement("span");
      x.textContent = l.text;
      row.appendChild(t); row.appendChild(x);
      feed.appendChild(row);
    });
    if (!wroteBoom) boom();

    if (atBottom) feed.scrollTop = feed.scrollHeight;
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
        renderChrome();

        var a = d.naive, b = d.tea;
        if (settledOrDead(a) && settledOrDead(b)) {
          // Both lanes are done moving. Stop polling entirely — the quiet is
          // part of the story.
          clearTimeout(pollTimer); pollTimer = null;
          if (crashedAt !== null) {
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
    // Mint a fresh id unless the viewer typed their own (the oos- path). The
    // last id we set is remembered, so "unchanged" is exactly "not typed over".
    if (order() === (ss("order") || "")) {
      q("#order").value = freshOrderId();
    }
    ssSet("order", order());
    forgetCrash();
    killingUntil = 0;
    renderChrome();
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
    // viewer should have to wait for a poll to believe. The provisional anchor
    // is the browser clock; the server's own instant replaces it a moment
    // later, and since every visual is derived, re-anchoring is free.
    detonate(null);
    renderChrome();
    fetch("/both/crash?order=" + encodeURIComponent(order()), { method: "POST" })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var at = (d && d.tea && d.tea.at) || (d && d.naive && d.naive.at);
        if (at) {
          saveCrash(at);
          LANES.forEach(function (lane) { renderLane(lane, last[lane]); });
        }
        schedule(250);
      })
      .catch(function () {
        notice("The kill request failed — the server may already be gone. Still polling.", "#f0a5a5");
        schedule(250);
      });
  };

  q("#reset").onclick = function () {
    forgetCrash();
    fetch("/both/reset?order=" + encodeURIComponent(order()), { method: "POST" })
      .then(function () { location.reload(); })
      .catch(function () { location.reload(); });
  };

  // Switching order id switches which crash we remember.
  q("#order").oninput = function () {
    loadCrash();
    renderChrome();
    schedule(0);
  };

  // Restore the run we were watching, so a reload keeps its crash chrome.
  // With nothing to restore, start from a fresh id rather than a hardcoded one
  // that may already carry a previous session's Durable Object.
  var savedOrder = ss("order");
  q("#order").value = savedOrder || freshOrderId();
  ssSet("order", order());

  loadCrash();
  renderChrome();
  schedule(0);
})();
</script>
</body>
</html>`;
