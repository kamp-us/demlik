/**
 * The recipes page: one panel per recipe, all drawn by the SAME helpers.
 *
 * Deliberately plainer than the checkout hero — the point here is breadth, and
 * five bespoke panels would be five times the code for no extra argument. Every
 * panel is chips + facts + buttons + feed, generated from whatever the adapter
 * reports, so adding a recipe is a registry entry and nothing else.
 */

import { RECIPES } from "./registry";

const PANELS = RECIPES.map(
  (r) => `
    <section class="panel" data-recipe="${r.id}">
      <header>
        <h2>${r.title}</h2>
        <span class="pill" data-el="phase">—</span>
      </header>
      <p class="real">${r.realWorld}</p>
      <p class="insight">${r.insight}</p>
      <div class="chips" data-el="chips"></div>
      <div class="facts" data-el="facts"></div>
      <div class="wait" data-el="wait"></div>
      <div class="banner-slot" data-el="banner"></div>
      <div class="buttons" data-el="actions"></div>
      <pre class="feed" data-el="feed"></pre>
      <p class="prod">In production these ⏩ buttons are Durable Object alarms — nobody clicks anything.</p>
    </section>`,
).join("");

export const RECIPES_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Five durable workflows you can click</title>
<style>
  :root {
    color-scheme: dark;
    --bg: #0e1116; --card: #151a21; --line: #232a33; --ink: #d8dee9;
    --dim: #7b8695; --amber: #e5b567; --green: #7ec699; --red: #e07a7a; --blue: #7fb3d5;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 28px 24px 64px;
    font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    background: var(--bg); color: var(--ink);
  }
  main { max-width: 1180px; margin: 0 auto; }
  a { color: #9db4cc; }
  h1 { font-size: 22px; margin: 0 0 6px; letter-spacing: -0.015em; }
  p.lede { margin: 0 0 8px; color: var(--dim); max-width: 74ch; }
  nav.top { margin: 0 0 26px; font-size: 13px; }

  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(430px, 1fr)); gap: 16px; }
  .panel {
    background: var(--card); border: 1px solid var(--line); border-radius: 12px;
    padding: 16px 16px 14px; transition: border-color .2s ease, box-shadow .2s ease;
  }
  .panel.dead { border-color: #7e3232; box-shadow: 0 0 0 1px #7e3232 inset; }
  .panel.revived { border-color: #2f6b46; box-shadow: 0 0 0 1px #2f6b46 inset; }
  .panel header { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
  .panel h2 { font-size: 15px; margin: 0; flex: 1; }
  .pill {
    font-size: 10.5px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase;
    padding: 4px 9px; border-radius: 999px; background: #1b222b; border: 1px solid var(--line); color: var(--dim);
  }
  .pill.busy { background: var(--amber); border-color: var(--amber); color: #0e1116; }
  .pill.good { background: var(--green); border-color: var(--green); color: #0e1116; }
  .pill.bad { background: var(--red); border-color: var(--red); color: #0e1116; }
  .pill.wait { background: #2a2417; border-color: #6b5a2f; color: #e5cf9b; }

  .real { margin: 0 0 6px; font-size: 13px; color: #b3bfcd; }
  .insight { margin: 0 0 12px; font-size: 12.5px; color: var(--dim); border-left: 2px solid var(--line); padding-left: 10px; }

  .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 11px; }
  .chip {
    font-size: 11px; font-weight: 600; padding: 5px 9px; border-radius: 6px;
    border: 1px solid var(--line); background: #11161c; color: #59636f;
  }
  .chip.done { border-color: #2f6b46; background: #17291f; color: #a8dcbc; }
  .chip.active { border-color: var(--amber); background: #2a2417; color: #e5cf9b; }
  .chip.failed { border-color: #7e3232; background: #2a1719; color: #f0a5a5; }
  .chip.cancelled { color: #4d5866; text-decoration: line-through; }

  .facts { display: flex; flex-wrap: wrap; gap: 14px; margin-bottom: 10px; font-size: 12px; color: var(--dim); }
  .facts b { color: var(--ink); font-weight: 600; font-variant-numeric: tabular-nums; }
  .wait { font-size: 12.5px; color: var(--dim); margin-bottom: 10px; min-height: 18px; font-variant-numeric: tabular-nums; }
  .wait b { color: var(--amber); }

  .banner-slot:empty { display: none; }
  .banner {
    border-radius: 7px; padding: 8px 11px; font-size: 12.5px; font-weight: 600; margin-bottom: 10px;
  }
  .banner.good { background: #17291f; border: 1px solid #2f6b46; color: #a8dcbc; }
  .banner.bad { background: #2a1719; border: 1px solid #7e3232; color: #f0a5a5; }
  .banner.wait { background: #2a2417; border: 1px solid #6b5a2f; color: #e5cf9b; }

  .buttons { display: flex; flex-wrap: wrap; gap: 7px; margin-bottom: 11px; }
  button {
    font: inherit; font-size: 12.5px; font-weight: 600; padding: 7px 11px; border-radius: 7px;
    border: 1px solid #2c343f; background: #1b222b; color: var(--ink); cursor: pointer;
  }
  button:hover:not(:disabled) { background: #232c37; }
  button:disabled { opacity: .4; cursor: not-allowed; }
  button.primary { border-color: #2f4a63; background: #16222d; }
  button.time { border-color: #5a4a2a; background: #241f14; color: #e5cf9b; }
  button.danger { border-color: #6d2f2f; background: #2a1719; color: #f0a5a5; }
  button.reset { border-color: #2c343f; background: #14191f; color: var(--dim); }

  .feed {
    background: #0c1015; border: 1px solid var(--line); border-radius: 8px;
    padding: 9px 11px; margin: 0 0 9px; height: 150px; overflow: auto;
    font: 11.5px/1.65 ui-monospace, SFMono-Regular, Menlo, monospace; color: #9fb0c3;
    white-space: pre-wrap;
  }
  .feed .row { display: flex; gap: 9px; }
  .feed .t { color: #4d5866; flex: none; }
  .feed .after { color: #a8dcbc; }
  .feed .boom {
    margin: 6px -11px; padding: 4px 11px; background: #7e3232; color: #fff;
    font-weight: 700; letter-spacing: .05em; text-align: center;
  }
  .prod { margin: 0; font-size: 11.5px; color: #5b6673; }

  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { transition-duration: .001ms !important; animation-duration: .001ms !important; }
  }
</style>
</head>
<body>
<main>
  <h1>Five durable workflows you can click</h1>
  <p class="lede">
    Each of these normally takes days or weeks. Every one of them is a pure state machine
    over a persisted row, so the waits are just timestamps — which means the ⏩ buttons can
    fast-forward them, and the 💥 buttons can destroy the server without losing the work.
  </p>
  <nav class="top"><a href="/">← back to the checkout demo</a></nav>

  <div class="grid">${PANELS}</div>
</main>

<script>
(function () {
  var PANELS = Array.prototype.slice.call(document.querySelectorAll(".panel"));
  var timers = {};

  function ss(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }
  function ssSet(k, v) { try { sessionStorage.setItem(k, v); } catch (e) {} }
  function ssDel(k) { try { sessionStorage.removeItem(k); } catch (e) {} }

  function instKey(recipe) { return "rinst:" + recipe; }
  function crashKey(recipe) { return "rcrash:" + recipe + ":" + inst(recipe); }

  function freshInst() {
    var a = "abcdefghijkmnpqrstuvwxyz23456789", out = "";
    for (var i = 0; i < 4; i++) out += a.charAt(Math.floor(Math.random() * a.length));
    return out;
  }
  function inst(recipe) {
    var v = ss(instKey(recipe));
    if (v === null) { v = freshInst(); ssSet(instKey(recipe), v); }
    return v;
  }
  function crashedAt(recipe) {
    var raw = ss(crashKey(recipe));
    return raw === null ? null : Number(raw);
  }

  function qs(recipe, extra) {
    var s = "recipe=" + encodeURIComponent(recipe) + "&inst=" + encodeURIComponent(inst(recipe));
    return extra ? s + "&" + extra : s;
  }
  function clock(ms) { return new Date(ms).toISOString().slice(5, 19).replace("T", " "); }

  function el(panel, name) { return panel.querySelector('[data-el="' + name + '"]'); }

  function progressed(recipe, s) {
    var c = crashedAt(recipe);
    if (c === null || !s) return false;
    if (s.lastSeenAt && s.lastSeenAt > c) return true;
    return (s.log || []).some(function (l) { return l.at > c; });
  }

  function render(panel, s) {
    var recipe = panel.dataset.recipe;
    var c = crashedAt(recipe);
    var revived = progressed(recipe, s);

    var pill = el(panel, "phase");
    pill.textContent = s.phase;
    pill.className = "pill " + (
      s.terminal
        ? (/fail|reject|downgrad/.test(s.phase) ? "bad" : "good")
        : s.phase === "awaiting-approval" ? "wait"
        : s.phase === "idle" || s.phase === "draft" || s.phase === "unknown" ? ""
        : "busy"
    );

    var chips = el(panel, "chips");
    chips.innerHTML = "";
    (s.chips || []).forEach(function (ch) {
      var d = document.createElement("span");
      d.className = "chip " + ch.status;
      d.textContent = ch.label;
      chips.appendChild(d);
    });

    var facts = el(panel, "facts");
    facts.innerHTML = "";
    (s.facts || []).forEach(function (f) {
      var d = document.createElement("span");
      d.textContent = f.label + " ";
      var b = document.createElement("b");
      b.textContent = f.value;
      d.appendChild(b);
      facts.appendChild(d);
    });

    var wait = el(panel, "wait");
    if (s.terminal) {
      wait.textContent = "finished — nothing further is scheduled";
    } else if (s.dueAt !== null && s.waitInMs !== null) {
      wait.innerHTML = "next deadline in <b>" + fmt(s.waitInMs) + "</b>" +
        (s.skewMs > 0 ? " · clock fast-forwarded " + fmt(s.skewMs) : "");
    } else if (s.phase === "awaiting-approval") {
      wait.textContent = "nothing is scheduled — this waits for a human, indefinitely";
    } else {
      wait.textContent = s.skewMs > 0 ? "clock fast-forwarded " + fmt(s.skewMs) : "";
    }

    // Buttons, straight from the adapter.
    var actions = el(panel, "actions");
    actions.innerHTML = "";
    (s.actions || []).forEach(function (a) {
      var b = document.createElement("button");
      b.textContent = a.label;
      b.className = a.kind === "primary" ? "primary" : a.kind === "time" ? "time"
        : a.kind === "danger" ? "danger" : "";
      b.disabled = !a.enabled;
      b.onclick = function () { act(recipe, a.id); };
      actions.appendChild(b);
    });
    var reset = document.createElement("button");
    reset.textContent = "Reset";
    reset.className = "reset";
    reset.onclick = function () { doReset(recipe); };
    actions.appendChild(reset);

    // Feed, with the crash divider spliced back at its chronological spot.
    var feed = el(panel, "feed");
    var bottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 30;
    feed.innerHTML = "";
    var log = s.log || [];
    if (!log.length && c === null) {
      feed.textContent = "nothing yet";
    } else {
      var wrote = c === null;
      function boom() {
        var b = document.createElement("div");
        b.className = "boom";
        b.textContent = "💥 isolate destroyed — " + clock(c);
        feed.appendChild(b);
        wrote = true;
      }
      log.forEach(function (l) {
        if (!wrote && l.at > c) boom();
        var row = document.createElement("div");
        row.className = "row" + (c !== null && l.at > c ? " after" : "");
        var t = document.createElement("span");
        t.className = "t"; t.textContent = clock(l.at);
        var x = document.createElement("span");
        x.textContent = l.text;
        row.appendChild(t); row.appendChild(x);
        feed.appendChild(row);
      });
      if (!wrote) boom();
    }
    if (bottom) feed.scrollTop = feed.scrollHeight;

    // Crash chrome, derived — so a poll or a reload cannot erase it.
    panel.classList.toggle("dead", c !== null && !revived);
    panel.classList.toggle("revived", c !== null && revived);
    var banner = el(panel, "banner");
    banner.innerHTML = "";
    if (c !== null) {
      var b = document.createElement("div");
      if (revived) {
        b.className = "banner good";
        b.textContent = s.terminal
          ? "✅ resumed from storage after the kill and finished — " + s.phase
          : "✅ resumed from storage after the kill — now " + s.phase;
      } else if (s.phase === "awaiting-approval") {
        b.className = "banner wait";
        b.textContent = "☠️ isolate destroyed. Nothing is scheduled — approve when you like, the run is still there.";
      } else {
        b.className = "banner wait";
        b.textContent = "☠️ isolate destroyed — waiting for the alarm to wake a fresh one (or press ⏩)";
      }
      banner.appendChild(b);
    }
  }

  function fmt(ms) {
    var d = 86400000;
    if (ms >= d) return (ms / d).toFixed(ms % d === 0 ? 0 : 1) + "d";
    if (ms >= 60000) return Math.round(ms / 60000) + "min";
    return (ms / 1000).toFixed(1) + "s";
  }

  function poll(recipe) {
    var panel = document.querySelector('[data-recipe="' + recipe + '"]');
    fetch("/recipe/state?" + qs(recipe))
      .then(function (r) { return r.json(); })
      .then(function (s) {
        render(panel, s);
        clearTimeout(timers[recipe]);
        if (!s.terminal) timers[recipe] = setTimeout(function () { poll(recipe); }, 1000);
      })
      .catch(function () {
        clearTimeout(timers[recipe]);
        timers[recipe] = setTimeout(function () { poll(recipe); }, 2000);
      });
  }

  function act(recipe, action) {
    if (action === "crash") {
      ssSet(crashKey(recipe), String(Date.now()));
      fetch("/recipe/crash?" + qs(recipe), { method: "POST" })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (d && d.at) ssSet(crashKey(recipe), String(d.at));
        })
        .catch(function () {})
        .then(function () { setTimeout(function () { poll(recipe); }, 300); });
      return;
    }
    if (action === "start" || action === "desire@a" || action === "desire@b") {
      // A start is a new story: new instance id, and no stale crash chrome.
      if (action === "start") {
        ssDel(crashKey(recipe));
        ssSet(instKey(recipe), freshInst());
      }
    }
    fetch("/recipe/act?" + qs(recipe, "action=" + encodeURIComponent(action)), { method: "POST" })
      .then(function (r) { return r.json(); })
      .then(function (s) {
        render(document.querySelector('[data-recipe="' + recipe + '"]'), s);
        clearTimeout(timers[recipe]);
        timers[recipe] = setTimeout(function () { poll(recipe); }, 400);
      })
      .catch(function () { poll(recipe); });
  }

  function doReset(recipe) {
    fetch("/recipe/reset?" + qs(recipe), { method: "POST" })
      .then(function () {
        ssDel(crashKey(recipe));
        ssSet(instKey(recipe), freshInst());
        poll(recipe);
      })
      .catch(function () { poll(recipe); });
  }

  PANELS.forEach(function (p) { poll(p.dataset.recipe); });
})();
</script>
</body>
</html>`;
