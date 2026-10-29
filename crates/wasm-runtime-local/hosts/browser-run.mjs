import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [
  deliveryArg,
  evidenceArg,
  profileArg,
  playwrightArg,
  chrome,
  baselineArg,
] = process.argv.slice(2);
const delivery = path.resolve(deliveryArg);
const evidence = path.resolve(evidenceArg);
const profile = path.resolve(profileArg);
await mkdir(evidence, { recursive: false });
await mkdir(profile, { recursive: true });
const expected = JSON.parse(await readFile(path.resolve(baselineArg), "utf8"));
const { chromium } = await import(
  pathToFileURL(path.resolve(playwrightArg)).href
);
const write = (name, value) =>
  writeFile(path.join(evidence, name), `${JSON.stringify(value, null, 2)}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const network = [],
  consoleEvents = [],
  pageErrors = [],
  failures = [],
  executions = [],
  lifecycle = [];
const names = {
  "/": "index.html",
  "/index.html": "index.html",
  "/browser.mjs": "browser.mjs",
  "/source-fixture.mjs": "source-fixture.mjs",
  "/runtime.js": "runtime.js",
  "/runtime_bg.wasm": "runtime_bg.wasm",
};
const mime = {
  ".html": "text/html",
  ".mjs": "text/javascript",
  ".js": "text/javascript",
  ".wasm": "application/wasm",
};
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, "http://localhost").pathname;
  const file = names[pathname];
  const bytes = file
    ? await readFile(path.join(delivery, file))
    : Buffer.from("not found");
  const status = file ? 200 : 404;
  const contentType = file ? mime[path.extname(file)] : "text/plain";
  response.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
  });
  response.end(bytes);
  network.push({
    at_ms: Date.now(),
    method: request.method,
    path: pathname,
    status,
    content_type: contentType,
    bytes: bytes.length,
    sha256: hash(bytes),
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const origin = `http://127.0.0.1:${port}`;
let child, browser, cdpPort;
const shutdown = [];
const output = { passed: false, origin, profile, browser: null, executions };
const log = await open(path.join(evidence, "chrome.log"), "w");
const closed = (port) =>
  new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(true));
  });
try {
  const args = [
    "--headless=new",
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--disable-extensions",
    "--disable-features=MediaRouter,OptimizationHints,Translate",
    "about:blank",
  ];
  child = spawn(chrome, args, {
    stdio: ["ignore", log.fd, log.fd],
    detached: true,
  });
  lifecycle.push({
    event: "start",
    pid: child.pid,
    command: [chrome, ...args],
    at_ms: Date.now(),
  });
  let endpoint;
  for (let attempt = 0; attempt < 100; attempt++) {
    assert.equal(child.exitCode, null, "owned Chrome exited during startup");
    try {
      const active = (
        await readFile(path.join(profile, "DevToolsActivePort"), "utf8")
      )
        .trim()
        .split("\n");
      cdpPort = Number(active[0]);
      endpoint = `http://127.0.0.1:${cdpPort}`;
      break;
    } catch {
      await sleep(100);
    }
  }
  assert.ok(endpoint, "Chrome did not expose its owned DevTools endpoint");
  browser = await chromium.connectOverCDP(endpoint);
  const context = browser.contexts()[0];
  await context.route("**/*", (route) =>
    route.request().url().startsWith(origin) ? route.continue() : route.abort(),
  );
  const page = await context.newPage();
  page.on("console", (message) =>
    consoleEvents.push({
      type: message.type(),
      text: message.text(),
      location: message.location(),
    }),
  );
  page.on("pageerror", (error) =>
    pageErrors.push({ message: error.message, stack: error.stack }),
  );
  page.on("requestfailed", (request) =>
    failures.push({ url: request.url(), failure: request.failure() }),
  );
  const session = await context.newCDPSession(page);
  output.browser = await session.send("Browser.getVersion");
  output.browser_command_line = await session
    .send("Browser.getBrowserCommandLine")
    .catch(() => null);
  async function invoke(action, phase) {
    const began = Date.now();
    let timeout;
    const value = await Promise.race([
      page.evaluate(async (action) => {
        const began = Date.now();
        const value = await globalThis.hostProbe[action]();
        return { value, began_ms: began, ended_ms: Date.now() };
      }, action),
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`browser action timed out: ${action}`)),
          20000,
        );
      }),
    ]).finally(() => clearTimeout(timeout));
    const record = {
      action,
      phase,
      sent_ms: began,
      received_ms: Date.now(),
      ...value,
    };
    executions.push(record);
    await write("executions.json", executions);
    return record;
  }
  for (const phase of ["first", "repeat", "fresh-page"]) {
    if (phase !== "repeat") {
      await page.goto(origin, { waitUntil: "networkidle" });
      await page.bringToFront();
      await page.waitForFunction(() => globalThis.hostProbe !== undefined);
    }
    const before = await invoke("health", phase);
    assert.deepEqual(before.value.smoke, { count: 1 });
    assert.ok(
      before.value.ok &&
        before.sent_ms - 2 <= before.value.clock &&
        before.value.clock <= before.received_ms + 2,
    );
    const source = await invoke("source", phase);
    const rust = await invoke("rust", phase);
    assert.deepEqual(source.value, expected);
    assert.deepEqual(rust.value.observations, expected);
    for (const timer of Object.values(rust.value.timers)) {
      assert.deepEqual(timer.active, []);
      assert.deepEqual(timer.errors, []);
    }
    for (const name of ["a", "b"]) {
      assert.deepEqual(rust.value.timers[name].arms, [10000, 4]);
      assert.deepEqual(rust.value.timers[name].clears, [1, 2]);
    }
    assert.deepEqual(rust.value.timers.drain.arms, [15]);
    assert.deepEqual(rust.value.timers.dispose.arms, [15]);
    const seams = await invoke("seams", phase);
    for (const row of Object.values(seams.value)) {
      assert.deepEqual(row.timers.active, []);
      assert.deepEqual(row.timers.errors, []);
    }
    assert.deepEqual(seams.value.dropped_stop.timers.clears, [1]);
    assert.equal(seams.value.drain_arm_failure.original_cause, true);
    assert.equal(seams.value.dispose_arm_failure.original_cause, true);
    assert.equal(seams.value.effect_scope.count, 2);
    assert.equal(seams.value.effect_scope.closed, true);
    const event = seams.value.clock_telemetry.events[0];
    assert.equal(event.seq, 1);
    assert.equal(event.msgType, "add");
    assert.ok(
      seams.sent_ms - 2 <= event.at && event.at <= seams.received_ms + 2,
    );
    const after = await invoke("health", phase);
    assert.deepEqual(after.value.smoke, { count: 1 });
    assert.ok(
      after.value.ok &&
        after.sent_ms - 2 <= after.value.clock &&
        after.value.clock <= after.received_ms + 2,
    );
    assert.deepEqual(pageErrors, []);
    assert.deepEqual(failures, []);
    assert.deepEqual(
      consoleEvents.filter((event) => event.type === "error"),
      [],
    );
  }
  await page.screenshot({ path: path.join(evidence, "host-page.png") });
  output.passed = true;
} finally {
  const before = await readFile(path.join(evidence, "chrome.log"), "utf8");
  const alive = () =>
    child && child.exitCode === null && child.signalCode === null;
  const waitForExit = (ms) =>
    new Promise((resolve) => {
      if (!alive()) {
        resolve();
        return;
      }
      const done = () => {
        clearTimeout(timeout);
        child.off("exit", done);
        resolve();
      };
      const timeout = setTimeout(done, ms);
      child.once("exit", done);
    });
  if (browser) {
    try {
      const control = await browser.newBrowserCDPSession();
      await control.send("Browser.close");
      shutdown.push({ action: "CDP Browser.close", requested: true });
    } catch (error) {
      shutdown.push({ action: "CDP Browser.close", error: String(error) });
    }
  }
  if (alive()) {
    await waitForExit(5000);
  }
  if (browser) await browser.close();
  if (alive()) {
    shutdown.push({ action: "SIGTERM fallback", pid: child.pid });
    process.kill(-child.pid, "SIGTERM");
    await waitForExit(5000);
    if (alive()) {
      shutdown.push({ action: "SIGKILL fallback", pid: child.pid });
      process.kill(-child.pid, "SIGKILL");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  }
  const after = await readFile(path.join(evidence, "chrome.log"), "utf8");
  await write("native-diagnostics.json", {
    before_stop: before,
    during_stop: after.slice(before.length),
    shutdown,
  });
  if (child)
    lifecycle.push({
      event: "stop",
      pid: child.pid,
      code: child.exitCode,
      signal: child.signalCode,
      at_ms: Date.now(),
    });
  await new Promise((resolve) => server.close(resolve));
  await log.close();
  const cleanup = {
    server_port: port,
    server_closed: await closed(port),
    chrome_pid: child?.pid,
    chrome_stopped: child
      ? child.exitCode !== null || child.signalCode !== null
      : true,
    cdp_port: cdpPort,
    cdp_closed: cdpPort ? await closed(cdpPort) : true,
  };
  await Promise.all([
    write("result.json", output),
    write("network.json", network),
    write("console.json", consoleEvents),
    write("page-errors.json", pageErrors),
    write("request-failures.json", failures),
    write("lifecycle.json", lifecycle),
    write("cleanup.json", cleanup),
  ]);
  assert.ok(
    cleanup.server_closed && cleanup.cdp_closed && cleanup.chrome_stopped,
    "owned browser resources remain open",
  );
}
console.log(
  JSON.stringify({ passed: true, browser: output.browser.product, evidence }),
);
