import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  inFolder,
  legOf,
  outermost,
  plan,
  READS,
  ROOT_LEG,
  readChanges,
  readDependents,
  readPackages,
  render,
  validSha,
  WHOLE_LEG,
} from "./changes.mjs";

/** @typedef {import("./changes.mjs").Change} Change */

// Covers changes.mjs: which test jobs one build starts. Each law names the rule it holds from the
// header of changes.mjs.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SCRIPT = fileURLToPath(new URL("./changes.mjs", import.meta.url));

// A workspace shaped like this one, for the pure laws: code-graph is read by tea (a devDependency)
// and by structure-sweep; tea is read by both sweeps. `reach` plays pnpm's `...{dir}`.
const PACKAGES = [
  "packages/backlog-sweep",
  "packages/code-graph",
  "packages/structure-sweep",
  "packages/tea",
];
const READERS = {
  "packages/code-graph": [
    "packages/tea",
    "packages/structure-sweep",
    "packages/backlog-sweep",
  ],
  "packages/tea": ["packages/structure-sweep", "packages/backlog-sweep"],
  "packages/structure-sweep": [],
  "packages/backlog-sweep": [],
};
/** @param {readonly string[]} dirs */
const reach = (dirs) =>
  outermost(dirs.flatMap((dir) => [dir, ...READERS[dir]]));

/**
 * A path is a modified file; `[status, path]` says otherwise.
 * @param {readonly (string | [string, string])[] | null} paths
 */
const changed = (paths) =>
  paths === null
    ? null
    : paths.map((entry) =>
        typeof entry === "string"
          ? { status: "M", path: entry }
          : { status: entry[0], path: entry[1] },
      );

/** @param {{ event?: string, paths: readonly (string | [string, string])[] | null }} input */
const decide = ({ event = "pull_request", paths }) =>
  plan({
    event,
    changes: changed(paths),
    packages: PACKAGES,
    dependents: reach,
  });

/** @param {ReturnType<typeof plan>} chosen */
const names = (chosen) => chosen.legs.map((leg) => leg.name).sort();

const ALL = [...PACKAGES, "scripts"].sort();

describe("which package a change reaches", () => {
  it("tea alone starts tea, the packages that read tea, and the root leg, never code-graph", () => {
    const chosen = decide({
      paths: [
        "packages/tea/src/machine/update.ts",
        "packages/tea/docs/how-to/x.md",
      ],
    });
    expect(names(chosen)).toEqual([
      "packages/backlog-sweep",
      "packages/structure-sweep",
      "packages/tea",
      "scripts",
    ]);
    expect(render(chosen)).toContain("test=true\n");
  });

  it("code-graph alone starts code-graph and every package that reads it", () => {
    expect(
      names(decide({ paths: ["packages/code-graph/src/api.ts"] })),
    ).toEqual(ALL);
  });

  it("structure-sweep alone starts structure-sweep and the root leg", () => {
    expect(
      names(decide({ paths: ["packages/structure-sweep/test/move.test.ts"] })),
    ).toEqual(["packages/structure-sweep", "scripts"]);
  });

  it("backlog-sweep alone starts backlog-sweep and the root leg", () => {
    expect(
      names(decide({ paths: ["packages/backlog-sweep/src/index.ts"] })),
    ).toEqual(["packages/backlog-sweep", "scripts"]);
  });

  it("a package's own Markdown starts its tests: tea's docs are tested", () => {
    expect(names(decide({ paths: ["packages/tea/README.md"] }))).toContain(
      "packages/tea",
    );
    expect(
      names(decide({ paths: ["packages/code-graph/docs/reference/cli.md"] })),
    ).toContain("packages/code-graph");
  });

  it("a package folder is matched whole: packages/tea-x is not packages/tea", () => {
    const chosen = decide({ paths: ["packages/tea-x/src/a.ts"] });
    expect(names(chosen)).toEqual(ALL);
    expect(chosen.why).toContain("packages/tea-x/src/a.ts");
  });

  it("tea's React and fast-check peer packages belong to tea's leg", () => {
    const peers = [
      "packages/tea/react-peers/18.2.0/package.json",
      "packages/tea/fast-check-peers/4.0.0/package.json",
    ];
    // pnpm lists the peers too; outermost() leaves tea alone.
    expect(
      outermost([...PACKAGES, ...peers.map((file) => path.dirname(file))]),
    ).toEqual(PACKAGES);
    expect(names(decide({ paths: peers }))).toContain("packages/tea");
    expect(names(decide({ paths: peers }))).not.toContain(
      "packages/code-graph",
    );
  });

  it("a deleted package's files match no package and run everything", () => {
    expect(names(decide({ paths: ["packages/gone/src/a.ts"] }))).toEqual(ALL);
  });
});

describe("files that no test can see change", () => {
  it.each([
    [["A", ".decisions/0036-one-build-per-event.md"]],
    [["M", ".decisions/0036-one-build-per-event.md"]],
    [["A", ".decisions/index.md"]],
    [["M", ".decisions/index.md"]],
    [["A", ".patterns/tea/tea-discipline.md"]],
    [["M", ".patterns/index.md"]],
    [["A", ".changeset/quiet-owls-sing.md"]],
    [["M", "ROADMAP.md"]],
    [["M", "CLAUDE.md"]],
    [["M", ".claude/agents/reviewer.md"]],
  ])("%j starts no test job", (change) => {
    const chosen = decide({ paths: [change] });
    expect(chosen.legs).toEqual([]);
    expect(render(chosen)).toBe("test=false\nlegs=[]\n");
    expect(chosen.why).toBe("only files that no test can see changed");
  });

  it("decisions, patterns and the roadmap together skip every test job", () => {
    expect(
      decide({
        paths: [
          ".decisions/0036-a.md",
          ["A", ".decisions/0037-b.md"],
          ".patterns/index.md",
          "ROADMAP.md",
        ],
      }).legs,
    ).toEqual([]);
  });

  it("a Markdown file that is deleted may be a link target tea's docs tests check, so tea's leg starts", () => {
    for (const file of [
      ".decisions/0016-removal-lands-in-a-minor-at-0x.md",
      ".patterns/index.md",
      "ROADMAP.md",
    ]) {
      const chosen = decide({ paths: [["D", file]] });
      expect(names(chosen)).toEqual([
        "packages/backlog-sweep",
        "packages/structure-sweep",
        "packages/tea",
        "scripts",
      ]);
    }
  });

  it("a changeset that is edited or deleted may hold a note tea's tests search for, so tea's leg starts", () => {
    for (const status of ["M", "D", "T"]) {
      expect(
        names(decide({ paths: [[status, ".changeset/quiet-owls-sing.md"]] })),
      ).toContain("packages/tea");
    }
  });

  it("a changeset beside a structure-sweep change adds nothing", () => {
    expect(
      names(
        decide({
          paths: [
            ["A", ".changeset/quiet-owls-sing.md"],
            "packages/structure-sweep/src/a.ts",
          ],
        }),
      ),
    ).toEqual(["packages/structure-sweep", "scripts"]);
  });

  it("only Markdown is settled: a changeset's config, a decision's code and a workflow's Markdown are not", () => {
    for (const file of [
      ".changeset/config.json",
      ".decisions/x.ts",
      ".github/pull_request_template.md",
      ".github/ci/README.md",
    ]) {
      expect(names(decide({ paths: [["A", file]] })), file).toEqual(ALL);
    }
  });

  it("the rows name tea's folder, and a workspace without it runs every test", () => {
    expect(READS.map((row) => row.reader)).toEqual([
      "packages/tea",
      "packages/tea",
    ]);
    const without = plan({
      event: "pull_request",
      changes: changed([["D", ".decisions/0001-x.md"]]),
      packages: ["packages/other"],
      dependents: (dirs) => dirs,
    });
    expect(names(without)).toEqual(["packages/other", "scripts"]);
    expect(without.why).toContain(
      "packages/tea, which is not a workspace package",
    );
  });

  it("Markdown beside a package's change adds nothing and removes nothing", () => {
    expect(
      names(
        decide({ paths: [".decisions/0036-a.md", "packages/tea/src/a.ts"] }),
      ),
    ).toEqual(names(decide({ paths: ["packages/tea/src/a.ts"] })));
  });
});

describe("a package that came or went", () => {
  it.each([
    ["A", "packages/new-thing/package.json"],
    ["D", "packages/old-thing/package.json"],
    ["A", "packages/tea/react-peers/20.0.0/package.json"],
    ["T", "packages/tea/package.json"],
  ])("%s %s runs every test: code-graph's tests list the members", (status, file) => {
    const chosen = decide({ paths: [[status, file], "packages/tea/src/a.ts"] });
    expect(names(chosen)).toEqual(ALL);
    expect(chosen.why).toContain(file);
  });

  it("an edited manifest changes no member list, so it starts only its package", () => {
    expect(
      names(decide({ paths: ["packages/structure-sweep/package.json"] })),
    ).toEqual(["packages/structure-sweep", "scripts"]);
  });
});

describe("a path that starts every test", () => {
  it.each([
    ["the lockfile", "pnpm-lock.yaml"],
    ["the workspace file", "pnpm-workspace.yaml"],
    ["the root package.json", "package.json"],
    ["the root vitest config", "vitest.config.ts"],
    ["the root biome config", "biome.jsonc"],
    ["a root tsconfig", "tsconfig.base.json"],
    ["the workflow", ".github/workflows/build.yaml"],
    ["CODEOWNERS", ".github/CODEOWNERS"],
    ["a CI script", ".github/ci/changes.mjs"],
    ["the changeset config", ".changeset/config.json"],
    ["the fabrika config", ".fabrika.jsonc"],
    ["agent config", ".claude/settings.json"],
    ["a path no rule knows", "tools/anything/at/all.txt"],
    ["a root dotfile", ".npmrc"],
  ])("%s (%s) runs every test", (_what, file) => {
    const chosen = decide({ paths: [file] });
    expect(names(chosen)).toEqual(ALL);
    expect(chosen.why).toBe(
      `${file} is in no package and no rule calls it safe, so every test runs`,
    );
  });

  it("one such path among many safe ones still runs every test", () => {
    const paths = [
      ".decisions/a.md",
      "packages/tea/src/a.ts",
      "pnpm-lock.yaml",
      "packages/tea/src/b.ts",
    ];
    expect(names(decide({ paths }))).toEqual(ALL);
  });

  it("a push to main, an unknown event and no event run every test", () => {
    for (const event of ["push", "workflow_dispatch", "schedule", ""]) {
      const chosen = decide({ event, paths: [".decisions/a.md"] });
      expect(names(chosen)).toEqual(ALL);
    }
  });

  it("a merge queue group follows its paths as a pull request does", () => {
    expect(
      names(
        decide({
          event: "merge_group",
          paths: ["packages/structure-sweep/src/a.ts"],
        }),
      ),
    ).toEqual(["packages/structure-sweep", "scripts"]);
    expect(
      decide({ event: "merge_group", paths: [".decisions/a.md"] }).legs,
    ).toEqual([]);
  });
});

describe("a mixed change", () => {
  it("takes the union of what each path reaches", () => {
    const chosen = decide({
      paths: ["packages/structure-sweep/src/a.ts", "packages/tea/src/a.ts"],
    });
    expect(names(chosen)).toEqual([
      "packages/backlog-sweep",
      "packages/structure-sweep",
      "packages/tea",
      "scripts",
    ]);
  });

  it("asks for the dependents of every touched package once, deduplicated", () => {
    /** @type {string[][]} */
    const asked = [];
    plan({
      event: "pull_request",
      changes: changed([
        "packages/tea/a.ts",
        "packages/tea/b.ts",
        "packages/code-graph/c.ts",
      ]),
      packages: PACKAGES,
      dependents: (dirs) => {
        asked.push([...dirs]);
        return reach(dirs);
      },
    });
    expect(asked).toEqual([["packages/tea", "packages/code-graph"]]);
  });

  it("a root script and a package's file start the package's legs and the root leg once", () => {
    const chosen = decide({
      paths: [
        "scripts/publish-pending.mjs",
        "packages/structure-sweep/src/a.ts",
      ],
    });
    expect(names(chosen)).toEqual(["packages/structure-sweep", "scripts"]);
  });

  it("a root script alone starts only the root leg", () => {
    expect(decide({ paths: ["scripts/release-version.mjs"] }).legs).toEqual([
      ROOT_LEG,
    ]);
  });

  it("the legs are named by their folder and filter by it, with the trailing slash", () => {
    expect(legOf("packages/tea")).toEqual({
      name: "packages/tea",
      args: "packages/tea/",
    });
    expect(ROOT_LEG).toEqual({ name: "scripts", args: "--project scripts" });
  });
});

describe("a change too big to read at a glance", () => {
  const files = (dir, count) =>
    Array.from({ length: count }, (_, i) => `${dir}/src/gen/file-${i}.ts`);

  it("200 files in tea reach what one file in tea reaches", () => {
    expect(names(decide({ paths: files("packages/tea", 200) }))).toEqual(
      names(decide({ paths: ["packages/tea/src/a.ts"] })),
    );
  });

  it("200 files across all four packages run all four, no more", () => {
    const paths = PACKAGES.flatMap((dir) => files(dir, 50));
    expect(paths).toHaveLength(200);
    expect(names(decide({ paths }))).toEqual(ALL);
  });

  it("199 safe files and one unknown path run every test", () => {
    const paths = [...files("packages/tea", 199), "docs/unlisted.txt"];
    expect(paths).toHaveLength(200);
    const chosen = decide({ paths });
    expect(names(chosen)).toEqual(ALL);
    expect(chosen.why).toContain("docs/unlisted.txt");
  });

  it("200 Markdown decisions skip every test", () => {
    const paths = Array.from(
      { length: 200 },
      (_, i) => `.decisions/${String(i).padStart(4, "0")}-x.md`,
    );
    expect(decide({ paths }).legs).toEqual([]);
  });
});

describe("when the answer cannot be had, every test runs", () => {
  it("unreadable changed files", () => {
    const chosen = decide({ paths: null });
    expect(names(chosen)).toEqual(ALL);
    expect(chosen.why).toBe(
      "the changed files could not be read, so every test runs",
    );
  });

  it("no changed file at all", () => {
    expect(names(decide({ paths: [] }))).toEqual(ALL);
  });

  it("dependents pnpm could not give", () => {
    const chosen = plan({
      event: "pull_request",
      changes: changed(["packages/tea/a.ts"]),
      packages: PACKAGES,
      dependents: () => null,
    });
    expect(names(chosen)).toEqual(ALL);
  });

  it("a workspace pnpm could not list runs the whole suite as one job", () => {
    for (const packages of [null, []]) {
      const chosen = plan({
        event: "pull_request",
        changes: changed(["packages/tea/a.ts"]),
        packages,
        dependents: reach,
      });
      expect(chosen.legs).toEqual([WHOLE_LEG]);
      expect(WHOLE_LEG.args).toBe("");
    }
  });
});

/** A git repository to read paths from. @returns {{ dir: string, git: (...args: string[]) => string }} */
const makeRepo = () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "changes-")));
  /** @param {string[]} args */
  const git = (...args) => {
    const done = spawnSync(
      "git",
      [
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.com",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      {
        cwd: dir,
        encoding: "utf8",
      },
    );
    if (done.status !== 0) {
      throw new Error(`git ${args.join(" ")}: ${done.stderr}`);
    }
    return done.stdout.trim();
  };
  git("init", "-q", "-b", "main");
  return { dir, git };
};

const made = /** @type {string[]} */ ([]);
afterAll(() => {
  for (const dir of made) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * @param {string} dir
 * @param {Record<string, string>} files
 */
const write = (dir, files) => {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  }
};

describe("reading the changed files from git", () => {
  const repo = makeRepo();
  made.push(repo.dir);
  write(repo.dir, { "a.txt": "a\n", "keep.txt": "k\n" });
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "root");
  const fork = repo.git("rev-parse", "HEAD");

  // main moves on after the branch forked.
  write(repo.dir, { "main-only.txt": "m\n" });
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "main moves");
  const tip = repo.git("rev-parse", "HEAD");

  repo.git("checkout", "-q", "-b", "feature", fork);
  write(repo.dir, {
    "packages/tea/src/a.ts": "x\n",
    "with space.txt": "s\n",
    "new\nline.txt": "n\n",
  });
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "feature");
  const head = repo.git("rev-parse", "HEAD");
  const run = inFolder(repo.dir);

  /** @param {Change[] | null} changes */
  const sorted = (changes) =>
    changes?.map((c) => `${c.status} ${c.path}`).sort() ?? null;

  it("a pull request's changes start at the merge base, so main's own commits are not its changes", () => {
    expect(sorted(readChanges(tip, head, "pull_request", run))).toEqual([
      "A new\nline.txt",
      "A packages/tea/src/a.ts",
      "A with space.txt",
    ]);
  });

  it("a merge queue group's changes start at the group's base", () => {
    expect(sorted(readChanges(fork, head, "merge_group", run))).toEqual([
      "A new\nline.txt",
      "A packages/tea/src/a.ts",
      "A with space.txt",
    ]);
    // diffed straight from the base: what main added since is the other side of the diff.
    expect(sorted(readChanges(tip, head, "merge_group", run))).toContain(
      "D main-only.txt",
    );
  });

  it("each change keeps git's status: added, modified, deleted", () => {
    write(repo.dir, {
      "keep.txt": "changed\n",
      "packages/tea/src/a.ts": "y\n",
    });
    repo.git("rm", "-q", "with space.txt");
    repo.git("add", "-A");
    repo.git("commit", "-q", "-m", "mixed");
    const next = repo.git("rev-parse", "HEAD");
    expect(sorted(readChanges(head, next, "merge_group", run))).toEqual([
      "D with space.txt",
      "M keep.txt",
      "M packages/tea/src/a.ts",
    ]);
  });

  it("a rename is a deletion and an addition", () => {
    repo.git("mv", "a.txt", "b.txt");
    repo.git("commit", "-q", "-m", "rename");
    const renamed = repo.git("rev-parse", "HEAD");
    expect(sorted(readChanges(head, renamed, "merge_group", run))).toContain(
      "D a.txt",
    );
    expect(sorted(readChanges(head, renamed, "merge_group", run))).toContain(
      "A b.txt",
    );
  });

  it("an empty diff is no change, which the plan runs in full", () => {
    expect(readChanges(head, head, "merge_group", run)).toEqual([]);
  });

  it("history it cannot read is null: a bad sha, all zeros, a commit the clone lacks", () => {
    const zeros = "0".repeat(40);
    const absent = "a".repeat(40);
    expect(validSha(zeros)).toBe(false);
    expect(validSha("HEAD")).toBe(false);
    expect(validSha(head)).toBe(true);
    expect(readChanges("", head, "pull_request", run)).toBeNull();
    expect(readChanges(zeros, head, "pull_request", run)).toBeNull();
    expect(readChanges(tip, "main", "pull_request", run)).toBeNull();
    expect(readChanges(absent, head, "pull_request", run)).toBeNull();
    expect(readChanges(absent, head, "merge_group", run)).toBeNull();
    // and no changes at all runs every test:
    const none = readChanges(absent, head, "pull_request", run);
    expect(
      names(
        plan({
          event: "pull_request",
          changes: none,
          packages: PACKAGES,
          dependents: reach,
        }),
      ),
    ).toEqual(ALL);
  });

  it("output git cut short is not trusted", () => {
    const cut = () => ({ status: 0, stdout: "M\0a.txt\0M\0b.t" });
    expect(readChanges(tip, head, "merge_group", cut)).toBeNull();
    const odd = () => ({ status: 0, stdout: "M\0a.txt\0M\0" });
    expect(readChanges(tip, head, "merge_group", odd)).toBeNull();
    const word = () => ({ status: 0, stdout: "MODIFIED\0a.txt\0" });
    expect(readChanges(tip, head, "merge_group", word)).toBeNull();
    const failed = () => ({ status: 128, stdout: "" });
    expect(readChanges(tip, head, "merge_group", failed)).toBeNull();
  });

  it("a change of 200 files comes back as 200 changes", () => {
    const big = makeRepo();
    made.push(big.dir);
    write(big.dir, { "keep.txt": "k\n" });
    big.git("add", "-A");
    big.git("commit", "-q", "-m", "root");
    const before = big.git("rev-parse", "HEAD");
    write(
      big.dir,
      Object.fromEntries(
        Array.from({ length: 200 }, (_, i) => [
          `packages/tea/src/gen/f${i}.ts`,
          `${i}\n`,
        ]),
      ),
    );
    big.git("add", "-A");
    big.git("commit", "-q", "-m", "big");
    const after = big.git("rev-parse", "HEAD");
    const found = readChanges(before, after, "pull_request", inFolder(big.dir));
    expect(found).toHaveLength(200);
    expect(found?.every((c) => c.status === "A")).toBe(true);
    expect(
      names(
        plan({
          event: "pull_request",
          changes: found,
          packages: PACKAGES,
          dependents: reach,
        }),
      ),
    ).toEqual(names(decide({ paths: ["packages/tea/src/a.ts"] })));
  });
});

describe("reading the workspace from pnpm", () => {
  // A workspace of its own, so the laws do not move when this repo's packages do:
  //   core <- app (dependency), core <- tool (devDependency), app <- cli, alone, and core/peers/x
  //   nested inside core.
  const workspace = makeRepo();
  made.push(workspace.dir);
  const manifest = (name, deps = {}, dev = {}) =>
    `${JSON.stringify({ name, version: "1.0.0", dependencies: deps, devDependencies: dev })}\n`;
  write(workspace.dir, {
    "package.json": manifest("root"),
    "pnpm-workspace.yaml":
      "packages:\n  - packages/*\n  - packages/core/peers/*\n",
    "packages/core/package.json": manifest("core"),
    "packages/core/peers/x/package.json": manifest("peer-x"),
    "packages/app/package.json": manifest("app", { core: "workspace:*" }),
    "packages/tool/package.json": manifest("tool", {}, { core: "workspace:*" }),
    "packages/cli/package.json": manifest("cli", { app: "workspace:*" }),
    "packages/alone/package.json": manifest("alone"),
  });
  workspace.git("add", "-A");
  workspace.git("commit", "-q", "-m", "workspace");
  const run = inFolder(workspace.dir);

  it("lists every package's folder, the nested ones under their outermost, never the root", () => {
    expect(readPackages(workspace.dir, run)).toEqual([
      "packages/alone",
      "packages/app",
      "packages/cli",
      "packages/core",
      "packages/tool",
    ]);
  });

  it("selects a package, its dependents and theirs, devDependencies included", () => {
    expect(readDependents(workspace.dir, ["packages/core"], run)).toEqual([
      "packages/app",
      "packages/cli",
      "packages/core",
      "packages/tool",
    ]);
    expect(readDependents(workspace.dir, ["packages/app"], run)).toEqual([
      "packages/app",
      "packages/cli",
    ]);
    expect(readDependents(workspace.dir, ["packages/alone"], run)).toEqual([
      "packages/alone",
    ]);
    expect(
      readDependents(workspace.dir, ["packages/cli", "packages/alone"], run),
    ).toEqual(["packages/alone", "packages/cli"]);
  });

  it("a folder pnpm does not know is no answer", () => {
    expect(readDependents(workspace.dir, ["packages/nope"], run)).toBeNull();
    expect(
      readDependents(workspace.dir, ["packages/core", "packages/nope"], run),
    ).toBeNull();
  });

  it("a pnpm that fails, or prints something else, is no answer", () => {
    expect(
      readPackages(workspace.dir, () => ({ status: 1, stdout: "" })),
    ).toBeNull();
    expect(
      readPackages(workspace.dir, () => ({
        status: 0,
        stdout: "No projects found",
      })),
    ).toBeNull();
    expect(
      readPackages(workspace.dir, () => ({ status: 0, stdout: "{}" })),
    ).toBeNull();
    expect(
      readPackages(workspace.dir, () => ({
        status: 0,
        stdout: `[{"name":"x"}]`,
      })),
    ).toBeNull();
    expect(
      readDependents(workspace.dir, ["packages/core"], () => ({
        status: 0,
        stdout: "No projects matched",
      })),
    ).toBeNull();
  });

  it("a change in a nested package starts its outermost package's leg and that one's dependents", () => {
    const chosen = plan({
      event: "pull_request",
      changes: changed(["packages/core/peers/x/package.json"]),
      packages: readPackages(workspace.dir, run),
      dependents: (dirs) => readDependents(workspace.dir, dirs, run),
    });
    expect(names(chosen)).toEqual([
      "packages/app",
      "packages/cli",
      "packages/core",
      "packages/tool",
      "scripts",
    ]);
  });

  it("end to end: a script run on a pull request reads git and pnpm and writes the job outputs", () => {
    const base = workspace.git("rev-parse", "HEAD");
    workspace.git("checkout", "-q", "-b", "feature");
    write(workspace.dir, {
      "packages/app/src/a.ts": "x\n",
      ".decisions/0001-x.md": "# x\n",
    });
    workspace.git("add", "-A");
    workspace.git("commit", "-q", "-m", "change");
    const head = workspace.git("rev-parse", "HEAD");
    const out = path.join(
      workspace.dir,
      "..",
      `out-${path.basename(workspace.dir)}`,
    );
    const done = spawnSync(process.execPath, [SCRIPT], {
      cwd: workspace.dir,
      encoding: "utf8",
      env: {
        ...process.env,
        EVENT: "pull_request",
        BASE: base,
        HEAD: head,
        GITHUB_OUTPUT: out,
      },
    });
    expect(done.status).toBe(0);
    const written = readFileSync(out, "utf8");
    rmSync(out);
    expect(written).toBe(
      `test=true\nlegs=${JSON.stringify([
        { name: "packages/app", args: "packages/app/" },
        { name: "packages/cli", args: "packages/cli/" },
        { name: "scripts", args: "--project scripts" },
      ])}\n`,
    );
    expect(done.stdout).toContain(
      "packages/app is touched, and packages/cli depends on it",
    );
  });

  it("end to end: a script run with history it cannot read runs every test and says so", () => {
    const out = path.join(
      workspace.dir,
      "..",
      `out-bad-${path.basename(workspace.dir)}`,
    );
    const done = spawnSync(process.execPath, [SCRIPT], {
      cwd: workspace.dir,
      encoding: "utf8",
      env: {
        ...process.env,
        EVENT: "merge_group",
        BASE: "",
        HEAD: "",
        GITHUB_OUTPUT: out,
      },
    });
    expect(done.status).toBe(0);
    expect(done.stdout).toContain(
      "::warning::changes: the changed files could not be read",
    );
    const legs = JSON.parse(readFileSync(out, "utf8").split("legs=")[1]);
    rmSync(out);
    expect(legs.map((leg) => leg.name).sort()).toEqual([
      "packages/alone",
      "packages/app",
      "packages/cli",
      "packages/core",
      "packages/tool",
      "scripts",
    ]);
  });

  it("end to end: a push to main runs every test without reading history", () => {
    const out = path.join(
      workspace.dir,
      "..",
      `out-push-${path.basename(workspace.dir)}`,
    );
    const done = spawnSync(process.execPath, [SCRIPT], {
      cwd: workspace.dir,
      encoding: "utf8",
      env: { ...process.env, EVENT: "push", GITHUB_OUTPUT: out },
    });
    expect(done.status).toBe(0);
    expect(done.stdout).not.toContain("::warning::");
    expect(readFileSync(out, "utf8")).toContain("test=true\n");
    expect(existsSync(out)).toBe(true);
    rmSync(out);
  });
});

// The slices are the whole suite or the split loses tests without a word. Every test file vitest
// finds under the root config must sit in a leg an everything-run starts, and the legs of this
// repo's own workspace must be the dependents pnpm reads from its package.json files.
describe("this repository's legs", { timeout: 120_000 }, () => {
  /** @param {string[]} args */
  const list = (args) => {
    const done = spawnSync(
      "pnpm",
      ["exec", "vitest", "list", "--filesOnly", ...args],
      {
        cwd: REPO,
        encoding: "utf8",
        maxBuffer: 2 ** 26,
      },
    );
    expect(done.status, done.stderr).toBe(0);
    return done.stdout
      .split("\n")
      .map((line) => line.replace(/^\[[^\]]*\]\s*/, "").trim())
      .filter((line) => line !== "");
  };

  const packages = readPackages(REPO);
  const everything = plan({
    event: "push",
    changes: null,
    packages,
    dependents: () => null,
  });

  it("the workspace lists the packages under packages/ and nothing else", () => {
    expect(packages).not.toBeNull();
    expect(packages?.every((dir) => /^packages\/[^/]+$/.test(dir))).toBe(true);
    expect(packages?.length).toBeGreaterThanOrEqual(4);
  });

  it("every test file belongs to a leg of the every-test run, and no leg is empty", () => {
    const all = list([]).map((file) =>
      path.relative(REPO, path.resolve(REPO, file)),
    );
    const covered = new Set();

    for (const leg of everything.legs) {
      const files = list(leg.args === "" ? [] : leg.args.split(" ")).map(
        (file) => path.relative(REPO, path.resolve(REPO, file)),
      );
      expect(
        files.length,
        `leg ${leg.name} finds no test file`,
      ).toBeGreaterThan(0);

      for (const file of files) {
        covered.add(file);
      }
    }

    expect(all.filter((file) => !covered.has(file))).toEqual([]);
    expect(all.length).toBeGreaterThan(400);
  });

  it("every `workspace:` dependency in a package.json makes its owner a dependent", () => {
    for (const dir of packages ?? []) {
      const json = JSON.parse(
        readFileSync(path.join(REPO, dir, "package.json"), "utf8"),
      );
      const deps = {
        ...json.dependencies,
        ...json.devDependencies,
        ...json.peerDependencies,
      };
      const used = Object.keys(deps).filter((name) =>
        String(deps[name]).startsWith("workspace:"),
      );

      for (const name of used) {
        const owner = (packages ?? []).find(
          (other) =>
            JSON.parse(
              readFileSync(path.join(REPO, other, "package.json"), "utf8"),
            ).name === name,
        );
        expect(owner, `${json.name} names ${name}`).toBeDefined();
        expect(readDependents(REPO, [owner])).toContain(dir);
      }
    }
  });

  it("a change in a package starts that package's leg and the root leg, in this repo", () => {
    const [first] = packages ?? [];
    const chosen = plan({
      event: "pull_request",
      changes: changed([`${first}/src/index.ts`]),
      packages,
      dependents: (dirs) => readDependents(REPO, dirs),
    });
    expect(chosen.legs.map((leg) => leg.name)).toContain(first);
    expect(chosen.legs.map((leg) => leg.name)).toContain("scripts");
  });
});
