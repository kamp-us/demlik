import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createCheckWorktree } from "./check-worktree.mjs";

const repository = fileURLToPath(new URL("../..", import.meta.url));
const realGit = process.env.PATH.split(path.delimiter)
  .map((directory) => path.join(directory, "git"))
  .find((file) => fs.existsSync(file) && fs.statSync(file).isFile());
const git = (root, args, input) =>
  execFileSync(realGit, args, { cwd: root, encoding: "utf8", input });

function fixture() {
  const parent = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "demlik-cleanup-fixture-")),
  );
  const root = path.join(parent, "source");
  fs.mkdirSync(root);
  git(root, ["init", "--quiet"]);
  git(root, ["config", "core.hooksPath", path.join(parent, "no-hooks")]);
  const body = git(repository, ["cat-file", "commit", "HEAD"]);
  const author = body.match(/^author .+$/m)[0];
  const committer = body.match(/^committer .+$/m)[0];
  const blob = git(root, ["hash-object", "-w", "--stdin"], "fixture\n").trim();
  const tree = git(
    root,
    ["mktree"],
    `100644 blob ${blob}\ttracked.txt\n`,
  ).trim();
  const commit = git(
    root,
    ["hash-object", "-w", "-t", "commit", "--stdin"],
    `tree ${tree}\n${author}\n${committer}\n\ncleanup fixture\n`,
  ).trim();
  git(root, ["update-ref", "HEAD", commit]);
  const bin = path.join(parent, "bin");
  fs.mkdirSync(bin);
  const script = path.join(parent, "git-shim.cjs");
  fs.writeFileSync(
    script,
    `const cp=require('node:child_process'),fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2), mode=process.env.DEMLIK_CLEANUP_FAULT;
const run=()=>{const result=cp.spawnSync(process.env.DEMLIK_CLEANUP_REAL_GIT,args,{stdio:'inherit'});if(result.error)throw result.error;return result.status??99;};
if(args[0]==='worktree'&&args[1]==='add'&&mode!=='normal'){
 const root=args[3];
 if(mode==='partial-directory'){fs.mkdirSync(path.join(root,'target'),{recursive:true});fs.writeFileSync(path.join(root,'target','owned'),'partial');}
 else if(mode!=='before-add'){
  const status=run();if(status!==0)process.exit(status);
  fs.mkdirSync(path.join(root,'target'),{recursive:true});fs.writeFileSync(path.join(root,'target','owned'),'partial');
  if(mode==='registry-only')fs.rmSync(root,{recursive:true,force:true});
 }
 process.stderr.write('controlled worktree-add failure');process.exit(42);
}
if(args[0]==='worktree'&&args[1]==='remove'&&mode==='cleanup-failure'){process.stderr.write('controlled worktree-remove failure');process.exit(43);}
process.exit(run());
`,
  );
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  fs.writeFileSync(
    path.join(bin, "git"),
    `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`,
    { mode: 0o755 },
  );
  return { parent, root, bin };
}

for (const mode of [
  "normal",
  "before-add",
  "partial-directory",
  "registered-directory",
  "registry-only",
  "cleanup-failure",
]) {
  test(
    `check worktree retires owned setup state: ${mode}`,
    { skip: process.platform === "win32" },
    () => {
      const own = fixture();
      const evidence = path.join(own.parent, "evidence");
      fs.mkdirSync(evidence);
      const kept = path.join(evidence, "keep.txt");
      fs.writeFileSync(kept, "proof must survive cleanup\n");
      const previous = Object.fromEntries(
        ["PATH", "DEMLIK_CLEANUP_REAL_GIT", "DEMLIK_CLEANUP_FAULT"].map(
          (key) => [key, process.env[key]],
        ),
      );
      const name = `cleanup-${mode}`;
      const receiptFile = path.join(evidence, `${name}-worktree.json`);
      let thrown;
      try {
        process.env.PATH = `${own.bin}${path.delimiter}${process.env.PATH}`;
        process.env.DEMLIK_CLEANUP_REAL_GIT = realGit;
        process.env.DEMLIK_CLEANUP_FAULT = mode;
        try {
          const check = createCheckWorktree(own.root, name, evidence);
          assert.equal(mode, "normal", "fault must be observed by caller");
          fs.mkdirSync(check.target);
          fs.writeFileSync(path.join(check.target, "owned"), "built");
          check.remove();
        } catch (error) {
          thrown = error;
        }
        const receipt = JSON.parse(fs.readFileSync(receiptFile, "utf8"));
        assert.equal(
          fs.readFileSync(kept, "utf8"),
          "proof must survive cleanup\n",
        );
        if (mode === "normal") assert.equal(thrown, undefined);
        else if (mode === "cleanup-failure") {
          assert.ok(thrown instanceof AggregateError);
          assert.equal(thrown.errors.length, 2);
          assert.equal(thrown.errors[0].status, 42);
          assert.match(
            thrown.errors[1].message,
            /controlled worktree-remove failure/,
          );
          assert.equal(receipt.removed, false);
          assert.match(
            receipt.cleanupFailure,
            /controlled worktree-remove failure/,
          );
          return;
        } else assert.equal(thrown.status, 42, "original setup error survives");
        assert.equal(receipt.removed, true);
        assert.equal(fs.existsSync(receipt.worktree), false);
        assert.equal(fs.existsSync(receipt.target), false);
        const registry = git(own.root, [
          "worktree",
          "list",
          "--porcelain",
          "-z",
        ]);
        assert.ok(
          !registry.split("\0").includes(`worktree ${receipt.worktree}`),
        );
      } finally {
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
        if (fs.existsSync(receiptFile)) {
          const receipt = JSON.parse(fs.readFileSync(receiptFile, "utf8"));
          const registry = git(own.root, [
            "worktree",
            "list",
            "--porcelain",
            "-z",
          ]);
          if (registry.split("\0").includes(`worktree ${receipt.worktree}`))
            git(own.root, ["worktree", "remove", "--force", receipt.worktree]);
          const parent = path.dirname(receipt.worktree);
          assert.ok(path.basename(parent).startsWith(`demlik-check-${name}-`));
          fs.rmSync(parent, { recursive: true, force: true });
        }
        fs.rmSync(own.parent, { recursive: true, force: true });
      }
    },
  );
}
