// Post-build guard: `@demlik/tea/node` must import with NO optional peer
// installed. 0.12.0 shipped a static `import WebSocket from "ws"` in
// dist/node/index.js while declaring `ws` an optional peer, so a consumer who
// followed the tutorial's three-package install line got ERR_MODULE_NOT_FOUND
// on the first line of the only tutorial (#113). The repo's own node_modules
// has `ws`, which is exactly why typecheck, lint, tests and CI all stayed
// green: nothing here ever ran the missing case.
//
// So this runs the missing case for real — pack the tarball, install it into a
// throwaway project that declares only the tutorial's dependencies, and import
// the door. No mock of a clean install; the clean install itself.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));

const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });

const fail = (msg) => {
  console.error(`verify-optional-peer-install: ${msg}`);
  process.exit(1);
};

// ── 1. The static-import check, read straight off the built artifact. ────────
const doorPath = join(pkgDir, "dist/node/index.js");
if (!existsSync(doorPath)) fail(`${doorPath} missing — run \`pnpm build\` first`);
const door = readFileSync(doorPath, "utf8");
if (/^\s*import\s[^;]*?["']ws["']/m.test(door)) {
  fail('dist/node/index.js has a static top-level import of "ws"');
}

// ── 2. The clean install, end to end. ───────────────────────────────────────
const work = mkdtempSync(join(tmpdir(), "tea-clean-install-"));
run("npm", ["pack", "--pack-destination", work], pkgDir);
const tarball = readdirSync(work).find((f) => f.endsWith(".tgz"));
if (!tarball) fail("npm pack produced no tarball");

const project = join(work, "consumer");
mkdirSync(project, { recursive: true });
writeFileSync(
  join(project, "package.json"),
  `${JSON.stringify({ name: "tea-clean-install-consumer", private: true, type: "module" }, null, 2)}\n`,
);

// The tutorial's install line, minus the two packages this check does not need
// to prove anything about. `ws` is an OPTIONAL peer, so npm leaves it out —
// which is the whole condition under test.
run("npm", ["install", "--no-audit", "--no-fund", join(work, tarball)], project);

if (existsSync(join(project, "node_modules/ws"))) {
  fail("the clean install pulled in `ws` — the test proves nothing; is it still an optional peer?");
}

const probe = join(project, "probe.mjs");
writeFileSync(
  probe,
  [
    'import { fileStore, fileJournal } from "@demlik/tea/node";',
    'if (typeof fileStore !== "function") throw new Error("fileStore is not a function");',
    'if (typeof fileJournal !== "function") throw new Error("fileJournal is not a function");',
    "",
  ].join("\n"),
);
run("node", [probe], project);

console.log(
  "verify-optional-peer-install: @demlik/tea/node imports with no `ws` installed",
);
