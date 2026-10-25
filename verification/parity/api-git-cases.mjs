import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export function gitCases(parent) {
  const cases = [],
    repos = [],
    recipes = [];
  const git = (root, ...args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const put = (root, file, body) => {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
  };
  function repo(
    name,
    {
      base = {},
      now = {},
      packageJson = '{"name":"demo"}',
      workspace = true,
      unborn = false,
    } = {},
  ) {
    const root = path.join(parent, name);
    fs.mkdirSync(root);
    git(root, "init", "-q");
    git(root, "config", "user.name", "Fixture");
    git(root, "config", "user.email", "fixture@example.test");
    git(root, "config", "commit.gpgsign", "false");
    const pkg = path.join(root, "packages/demo");
    fs.mkdirSync(pkg, { recursive: true });
    put(root, "packages/demo/package.json", packageJson);
    if (workspace) put(root, "pnpm-workspace.yaml", "packages: [packages/*]\n");
    for (const [file, body] of Object.entries(base)) put(root, file, body);
    let sha = "HEAD",
      tree = "HEAD^{tree}";
    if (!unborn) {
      git(root, "add", ".");
      git(root, "commit", "-qm", "fixture");
      sha = git(root, "rev-parse", "HEAD");
      tree = git(root, "rev-parse", "HEAD^{tree}");
    }
    for (const [file, body] of Object.entries(now)) put(root, file, body);
    const value = { root, pkg, sha, tree };
    repos.push(value);
    recipes.push({ name, base, now, packageJson, workspace, unborn });
    return value;
  }
  function add(id, operation, input, qualification) {
    cases.push({
      id: `api-git.${id}`,
      operation,
      input,
      ...(qualification ? { qualification } : {}),
    });
  }
  const header = (name, bump, body = "body") =>
    `---\n"${name}": ${bump}\n---\n${body}`;
  const main = repo("main", {
    base: {
      ".changeset/old.md": "old",
      ".changeset/line\nname.md": "newline",
      ".changeset/tab\tname.md": "tab",
      "packages/demo/.changeset/local.md": "local",
    },
    now: {
      ".changeset/old.md": "changed invalid old",
      ".changeset/z.md": header("demo", "major", "\nZ\n"),
      ".changeset/a.md": header("demo", "minor", "A"),
      ".changeset/none.md": header("demo", "none"),
      ".changeset/other.md": header("other", "patch"),
      ".changeset/README.md": "invalid README",
      ".changeset/nested/child.md": "invalid nested",
      ".changeset/\u{10000}.md": header("demo", "patch", "astral sorted"),
      ".changeset/\ue000.md": header("demo", "patch", "BMP sorted"),
    },
  });
  fs.symlinkSync("README.md", path.join(main.root, ".changeset/symlink.md"));
  fs.symlinkSync("packages/demo", path.join(main.root, "package-link"));
  const notRepo = path.join(parent, "not-repo");
  fs.mkdirSync(notRepo);
  for (const [name, root] of [
    ["package", main.pkg],
    ["root", main.root],
    ["dotdot", `${main.pkg}/../demo`],
    ["symlink", path.join(main.root, "package-link")],
    ["missing", path.join(parent, "missing")],
    ["not-repo", notRepo],
    ["raw-refusal", `${notRepo}/\ud800`],
  ])
    add(`checkout.${name}`, "checkout", { root });
  const rawDir = path.join(main.root, "\ufffd");
  fs.mkdirSync(rawDir);
  add("checkout.raw-alias", "checkout", { root: `${main.root}/\ud800` });
  add("read.raw-root-missing-name", "read", {
    root: `${main.root}/\ud800`,
    base: main.sha,
  });
  git(main.root, "tag", "plain");
  git(main.root, "tag", "-am", "annotated", "annotated");
  for (const [name, revision] of [
    ["head", "HEAD"],
    ["sha", main.sha],
    ["tag", "plain"],
    ["annotated", "annotated"],
    ["tree", "HEAD^{tree}"],
    ["unknown", "absent-base"],
    ["option", "--help"],
    ["empty", ""],
    ["raw", "\ud800"],
    ["nul", "x\0\ud800"],
  ])
    add(
      `resolve.${name}`,
      "resolve",
      { top: main.root, packagePath: "packages/demo", revision },
      name === "nul" ? "argumentDiagnostic" : undefined,
    );
  add(
    "resolve.cwd-nul",
    "resolve",
    { top: `${main.root}\0\ud800`, packagePath: "", revision: "HEAD" },
    "argumentDiagnostic",
  );
  add(
    "resolve.both-nul",
    "resolve",
    { top: `${main.root}\0`, packagePath: "", revision: "x\0" },
    "argumentDiagnostic",
  );
  const unborn = repo("unborn", { unborn: true });
  add("resolve.unborn", "resolve", {
    top: unborn.root,
    packagePath: "packages/demo",
    revision: "HEAD",
  });
  for (const [name, sha, dir, cwd] of [
    ["root", main.sha, ".changeset/", main.root],
    ["directory", main.sha, ".changeset", main.root],
    ["missing", main.sha, "absent/", main.root],
    ["subdir", main.sha, ".changeset/", main.pkg],
    ["tree", main.tree, ".changeset/", main.root],
    ["unknown", "absent", ".changeset/", main.root],
    ["option", "--help", ".changeset/", main.root],
    ["nul-sha", "x\0", ".changeset/", main.root],
    ["nul-path", main.sha, "x\0\ud800", main.root],
    ["cwd-nul", main.sha, ".changeset/", `${main.root}\0`],
  ])
    add(
      `names.${name}`,
      "names",
      { cwd, sha, dir },
      name.includes("nul") ? "argumentDiagnostic" : undefined,
    );
  add("read.default", "read", { root: main.pkg, base: main.sha });
  add("read.override", "read", {
    root: main.pkg,
    base: main.sha,
    repoRoot: main.root,
  });
  add("read.no-workspace-default-subdir", "read", {
    root: main.pkg,
    base: main.sha,
    repoRoot: main.pkg,
  });
  add("read.symlink-root", "read", {
    root: path.join(main.root, "package-link"),
    base: main.sha,
  });
  add("read.invalid-base", "read", { root: main.pkg, base: "absent" });
  for (const [name, json, files, extra] of [
    ["empty-name", '{"name":""}', {}, {}],
    ["bom-json", '\ufeff{"name":"demo"}', {}, {}],
    [
      "readme-case",
      '{"name":"demo"}',
      { ".changeset/ReadMe.md": header("demo", "patch") },
      {},
    ],
    ["missing-name", "{}", {}, {}],
    ["number-name", '{"name":17}', {}, {}],
    ["null-json", "null", {}, {}],
    ["invalid-json", "{", {}, {}],
    ["primitive-json", '"demo"', {}, {}],
    ["array-json", "[]", {}, {}],
    ["proto-only", '{"__proto__":{"name":"demo"}}', {}, {}],
    [
      "proto-name",
      '{"name":"__proto__"}',
      { ".changeset/new.md": header("__proto__", "minor") },
      {},
    ],
    [
      "whitespace-name",
      '{"name":" "}',
      { ".changeset/new.md": header(" ", "patch") },
      {},
    ],
    [
      "lone-name",
      '{"name":"\\ud800"}',
      { ".changeset/new.md": header("\\ud800", "patch") },
      {},
    ],
    [
      "duplicate",
      '{"name":"demo"}',
      { ".changeset/new.md": "---\ndemo: patch\ndemo: major\n---\nbody" },
      {},
    ],
    [
      "bad-unrelated",
      '{"name":"demo"}',
      { ".changeset/0bad.md": "---\nother: PATCH\n---\n" },
      {},
    ],
    [
      "bad-before-good",
      '{"name":"demo"}',
      {
        ".changeset/0bad.md": "invalid",
        ".changeset/zgood.md": header("demo", "minor"),
      },
      {},
    ],
    [
      "only-none",
      '{"name":"demo"}',
      { ".changeset/new.md": header("demo", "none") },
      {},
    ],
    ["no-directory", '{"name":"demo"}', {}, {}],
    [
      "directory-is-file",
      '{"name":"demo"}',
      { ".changeset": "not a directory" },
      {},
    ],
    ["unborn", '{"name":"demo"}', {}, { unborn: true }],
    [
      "no-workspace",
      '{"name":"demo"}',
      { ".changeset/new.md": header("demo", "patch") },
      { workspace: false },
    ],
  ]) {
    const r = repo(`reader-${name}`, {
      packageJson: json,
      now: files,
      ...extra,
    });
    add(`read.${name}`, "read", { root: r.pkg, base: r.sha });
  }
  for (const kind of ["missing-package-json", "directory-package-json"]) {
    const r = repo(kind);
    fs.rmSync(path.join(r.pkg, "package.json"));
    if (kind.startsWith("directory"))
      fs.mkdirSync(path.join(r.pkg, "package.json"));
    add(`read.${kind}`, "read", { root: r.pkg, base: "absent-base" });
  }
  add("read.root-missing", "read", {
    root: path.join(parent, "missing"),
    base: "absent",
  });
  add("read.root-file", "read", {
    root: path.join(main.pkg, "package.json"),
    base: "absent",
  });
  const rawPackage = repo("reader-invalid-utf8", {
    packageJson: Buffer.from([
      123, 34, 110, 97, 109, 101, 34, 58, 34, 255, 34, 125,
    ]),
    now: {
      ".changeset/new.md": Buffer.from([
        45, 45, 45, 10, 34, 255, 34, 58, 32, 112, 97, 116, 99, 104, 10, 45, 45,
        45, 10, 255,
      ]),
    },
  });
  add("read.invalid-utf8", "read", {
    root: rawPackage.pkg,
    base: rawPackage.sha,
  });
  const invalidBeforeBase = repo("reader-invalid-before-base", {
    packageJson: "{",
  });
  add("read.invalid-package-before-invalid-base", "read", {
    root: invalidBeforeBase.pkg,
    base: "absent-base",
  });
  for (const kind of ["symlink", "directory"]) {
    const r = repo(`reader-base-${kind}`);
    fs.mkdirSync(path.join(r.root, ".changeset"));
    const old = path.join(r.root, ".changeset/old.md");
    if (kind === "symlink") fs.symlinkSync("absent", old);
    else {
      fs.mkdirSync(old);
      fs.writeFileSync(path.join(old, "inside"), "directory entry");
    }
    git(r.root, "add", ".");
    git(r.root, "commit", "-qm", "old entry");
    const base = git(r.root, "rev-parse", "HEAD");
    fs.rmSync(old, { recursive: true, force: true });
    fs.writeFileSync(old, header("demo", "major"));
    add(`read.base-${kind}-still-existing`, "read", { root: r.pkg, base });
  }
  const directoryAlias = repo("reader-directory-alias");
  fs.mkdirSync(path.join(directoryAlias.root, "actual"));
  fs.writeFileSync(
    path.join(directoryAlias.root, "actual/new.md"),
    header("demo", "patch"),
  );
  fs.symlinkSync("actual", path.join(directoryAlias.root, ".changeset"));
  add("read.changeset-directory-alias", "read", {
    root: directoryAlias.pkg,
    base: directoryAlias.sha,
  });
  const unreadable = repo("reader-unreadable", {
    now: { ".changeset/new.md": header("demo", "patch") },
  });
  fs.chmodSync(path.join(unreadable.root, ".changeset/new.md"), 0o000);
  add(
    "read.unreadable-file",
    "read",
    { root: unreadable.pkg, base: unreadable.sha },
    "filesystemDiagnostic",
  );
  const large = repo("names-limit");
  for (let index = 0; index < 4200; index++)
    put(
      large.root,
      `.changeset/${String(index).padStart(4, "0")}-${"x".repeat(244)}.md`,
      "",
    );
  git(large.root, "add", ".");
  git(large.root, "commit", "-qm", "long names");
  large.sha = git(large.root, "rev-parse", "HEAD");
  add(
    "names.output-limit",
    "names",
    { cwd: large.root, sha: large.sha, dir: ".changeset/" },
    "captureDiagnostic",
  );
  for (const [name, base, now, pkg] of [
    [
      "links",
      { "packages/demo/version.txt": "base" },
      {
        "packages/demo/version.txt": "working",
        "packages/demo/node_modules/pkg/index.js": "current package",
        "node_modules/root/index.js": "current root",
      },
      "packages/demo",
    ],
    [
      "absent-deps",
      { "packages/demo/version.txt": "base" },
      {},
      "packages/demo",
    ],
    [
      "archived-deps",
      { "packages/demo/node_modules/archived.txt": "archived" },
      { "packages/demo/node_modules/current.txt": "current" },
      "packages/demo",
    ],
    [
      "root",
      { "version.txt": "base" },
      { "node_modules/dep/index.js": "root current" },
      "",
    ],
    [
      "missing-package",
      {},
      { "packages/new/node_modules/dep/index.js": "current" },
      "packages/new",
    ],
  ]) {
    const r = repo(`export-${name}`, { base, now });
    add(`export.${name}`, "export", {
      top: r.root,
      packagePath: pkg,
      revision: r.sha,
    });
    if (name === "links")
      add("export.tree", "export", {
        top: r.root,
        packagePath: pkg,
        revision: r.tree,
      });
  }
  const broken = repo("export-broken");
  fs.symlinkSync("absent", path.join(broken.pkg, "node_modules"));
  git(broken.root, "add", ".");
  git(broken.root, "commit", "-qm", "broken");
  broken.sha = git(broken.root, "rev-parse", "HEAD");
  fs.unlinkSync(path.join(broken.pkg, "node_modules"));
  put(broken.root, "packages/demo/node_modules/current.js", "current");
  add(
    "export.broken-archived-link",
    "export",
    { top: broken.root, packagePath: "packages/demo", revision: broken.sha },
    "filesystemDiagnostic",
  );
  const readonly = repo("export-readonly", {
    now: { "packages/demo/node_modules/current.js": "current" },
  });
  git(readonly.root, "config", "tar.umask", "0222");
  add(
    "export.operation-and-cleanup",
    "export",
    {
      top: readonly.root,
      packagePath: "packages/demo",
      revision: readonly.sha,
    },
    "cleanupDiagnostic",
  );
  add(
    "export.invalid",
    "export",
    { top: main.root, packagePath: "packages/demo", revision: "absent-base" },
    "archiveDiagnostic",
  );
  add(
    "export.nul",
    "export",
    { top: main.root, packagePath: "packages/demo", revision: "bad\0\ud800" },
    "archiveArgumentDiagnostic",
  );
  const removes = path.join(parent, "removes");
  fs.mkdirSync(removes);
  for (const kind of ["missing", "file", "directory", "symlink"]) {
    const target = path.join(removes, kind);
    if (kind === "file") fs.writeFileSync(target, "file");
    if (kind === "directory") {
      fs.mkdirSync(target);
      fs.writeFileSync(path.join(target, "child"), "child");
    }
    if (kind === "symlink") fs.symlinkSync(main.root, target);
    add(`remove.${kind}`, "remove", { temp: target });
  }
  add("remove.nul", "remove", { temp: "raw\0\ud800" }, "argumentDiagnostic");
  const safety = repo("archive-safety");
  return { cases, repos, recipes, put, git, safety };
}
