import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const before =
  "export function parse(text: string) { return Number(text); }\nexport const keep = 1;\nexport function legacy() {}\n";
const after =
  "export function parse(text: string, radix?: number) { return Number.parseInt(text, radix); }\nexport const keep = 1;\nexport function extra() { return 'x'; }\nexport * from './scratch';\n";
const currentMap = { ".": { entry: "src/index.ts", tier: "stable" } };
const oldMap = {
  ".": { entry: "src/index.ts", tier: "old-tier" },
  "./removed": { entry: "src/old.ts", tier: "base-only" },
};
const config = {
  compilerOptions: { strict: true, target: "ES2022", module: "ESNext" },
  include: ["src"],
};
const policy = {
  callout: "BREAKING",
  tiers: {
    stable: {
      added: { bump: "minor" },
      changed: { bump: "minor", callout: true },
      removed: { bump: "major", callout: true },
    },
  },
};
export function apiDiffModeCases(parent) {
  const cases = [],
    repos = [],
    recipes = [];
  const git = (root, ...args) =>
    execFileSync("git", ["--no-optional-locks", ...args], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const put = (root, file, body) => {
    const absolute = path.join(root, file);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, body);
  };
  function repo(name, options = {}) {
    const root = path.join(parent, name),
      pkg = path.join(root, "packages/demo");
    fs.mkdirSync(root);
    git(root, "init", "-q");
    git(root, "config", "user.name", "Fixture");
    git(root, "config", "user.email", "fixture@example.test");
    git(root, "config", "commit.gpgsign", "false");
    put(root, "pnpm-workspace.yaml", "packages: [packages/*]\n");
    if (!options.beforePackage) {
      put(root, "packages/demo/package.json", JSON.stringify({ name: "demo" }));
      put(
        root,
        "packages/demo/tsconfig.json",
        options.baseConfig ?? JSON.stringify(config),
      );
      if (!options.noBaseRows)
        put(root, "packages/demo/src/index.ts", options.before ?? before);
      else
        put(
          root,
          "packages/demo/src/unrelated.ts",
          "export const unrelated = 1;\n",
        );
      put(root, "packages/demo/src/old.ts", "export const onlyBase = 1;\n");
      put(root, "packages/demo/api-map.json", JSON.stringify(oldMap));
    }
    git(root, "add", ".");
    git(root, "commit", "-qm", "base");
    const sha = git(root, "rev-parse", "HEAD");
    put(
      root,
      "packages/demo/package.json",
      options.packageJson ?? '{"name":"demo"}',
    );
    put(
      root,
      "packages/demo/tsconfig.json",
      options.nowConfig ?? JSON.stringify(config),
    );
    put(root, "packages/demo/src/index.ts", options.after ?? after);
    put(
      root,
      "packages/demo/src/scratch.ts",
      "export const untracked = true;\n",
    );
    if (fs.existsSync(path.join(pkg, "src/old.ts")))
      fs.unlinkSync(path.join(pkg, "src/old.ts"));
    put(root, "packages/demo/current-map.json", JSON.stringify(currentMap));
    put(
      root,
      "packages/demo/policy.json",
      JSON.stringify(options.policy ?? policy),
    );
    for (const [file, body] of Object.entries(options.now ?? {}))
      put(root, file, body);
    const value = {
      root,
      pkg,
      sha,
      mapFile: path.join(pkg, "current-map.json"),
      policyFile: path.join(pkg, "policy.json"),
    };
    repos.push(value);
    recipes.push({ name, options });
    return value;
  }
  function add(id, operation, input, qualification) {
    cases.push({
      id: `api-workflow.${id}`,
      operation,
      input,
      ...(qualification ? { qualification } : {}),
    });
  }
  const main = repo("main");
  const d = (r, extra = {}) => ({
    root: r.pkg,
    map: currentMap,
    base: r.sha,
    ...extra,
  });
  add("diff.dirty-default", "diff", d(main));
  add("diff.repeat", "diff", d(main));
  add("diff.empty-current-refusal", "diff", d(main, { map: {} }));
  for (const awaited of [false, true])
    add(
      `diff.base-map-file-${awaited ? "async" : "sync"}`,
      "diff",
      d(main, { baseMap: { kind: "file", file: "api-map.json", awaited } }),
    );
  add(
    "diff.base-map-value",
    "diff",
    d(main, { baseMap: { kind: "value", value: oldMap, awaited: true } }),
  );
  add(
    "diff.base-map-empty",
    "diff",
    d(main, { baseMap: { kind: "value", value: {} } }),
  );
  add(
    "diff.base-map-null",
    "diff",
    d(main, { baseMap: { kind: "value", value: null } }),
  );
  add(
    "diff.base-map-bad-schema",
    "diff",
    d(main, { baseMap: { kind: "value", value: { ".": {} } } }),
  );
  add(
    "diff.base-map-missing-entry",
    "diff",
    d(main, {
      baseMap: {
        kind: "value",
        value: { "./bad": { entry: "src/missing.ts" } },
      },
    }),
  );
  add(
    "diff.base-map-constructor",
    "diff",
    d(main, { baseMap: { kind: "value", value: { constructor: null } } }),
  );
  for (const kind of ["input", "callback"]) {
    add(
      `diff.callback-${kind}`,
      "diff",
      d(main, {
        baseMap: {
          kind: "fail",
          failure: { kind, message: `base ${kind}\ud800\n failure` },
          awaited: true,
        },
      }),
    );
  }
  add(
    "diff.callback-read-failure",
    "diff",
    d(main, { baseMap: { kind: "file", file: "missing.json", awaited: true } }),
    "backendDiffError",
  );
  add(
    "diff.callback-cleanup-failure",
    "diff",
    d(main, {
      baseMap: {
        kind: "fail",
        failure: { kind: "input", message: "first callback refusal" },
        readonly: true,
      },
    }),
    "cleanupError",
  );
  add(
    "diff.success-cleanup-failure",
    "diff",
    d(main, { baseMap: { kind: "value", value: currentMap, readonly: true } }),
    "cleanupError",
  );
  add(
    "diff.map-before-base",
    "diff",
    d(main, { map: { ".": {} }, base: "missing-ref" }),
  );
  add("diff.invalid-ref", "diff", d(main, { base: "missing-ref" }));
  add("diff.invalid-root", "diff", {
    root: path.join(parent, "missing-root"),
    map: null,
    base: "missing-ref",
  });
  const identical = repo("identical", {
    before: "export const same = 1;\n",
    after: "export const same = 1;\n",
  });
  add("diff.no-change", "diff", d(identical));
  const noRows = repo("no-base-rows", { noBaseRows: true, baseConfig: "{" });
  add("diff.no-base-rows-skips-emit", "diff", d(noRows));
  const absent = repo("before-package", { beforePackage: true });
  add("diff.before-package-default", "diff", d(absent));
  add(
    "diff.before-package-skips-callback",
    "diff",
    d(absent, {
      baseMap: {
        kind: "fail",
        failure: { kind: "callback", message: "must not call" },
        awaited: true,
      },
    }),
  );
  const warnings = repo("warnings", {
    before: "export const bad: string = 1;\n",
    after: "export const bad: string = 2;\n",
  });
  add(
    "diff.both-warning-contexts",
    "diff",
    d(warnings, {
      baseMap: { kind: "value", value: currentMap, awaited: true },
    }),
  );
  for (const kind of ["input", "callback"])
    add(
      `diff.current-warning-${kind}`,
      "diff",
      d(warnings, {
        warnFailure: { kind, message: `warning ${kind}\ud800` },
        baseMap: {
          kind: "fail",
          failure: { kind: "callback", message: "base callback must not win" },
        },
      }),
    );
  add(
    "diff.empty-current-before-warn",
    "diff",
    d(warnings, {
      map: {},
      warnFailure: { kind: "input", message: "empty map current warning" },
      baseMap: {
        kind: "fail",
        failure: { kind: "callback", message: "must not call" },
      },
    }),
  );
  const baseWarning = repo("base-warning", {
    before: "export const bad: string = 1;\n",
    after: "export const good = 1;\n",
  });
  add("diff.base-warning-context", "diff", d(baseWarning));
  const currentWarning = repo("current-warning", {
    before: "export const good = 1;\n",
    after: "export const bad: string = 1;\n",
  });
  add(
    "diff.current-emit-before-callback",
    "diff",
    d(currentWarning, {
      baseMap: {
        kind: "fail",
        failure: { kind: "callback", message: "after current emit" },
        awaited: true,
      },
    }),
  );
  const fileInstead = repo("base-package-is-file", { beforePackage: true });
  // This second commit still predates the current package directory's shape.
  fs.rmSync(fileInstead.pkg, { recursive: true });
  put(fileInstead.root, "packages/demo", "old file");
  git(fileInstead.root, "add", ".");
  git(fileInstead.root, "commit", "-qm", "file instead of package");
  const fileBase = git(fileInstead.root, "rev-parse", "HEAD");
  fs.unlinkSync(fileInstead.pkg);
  put(fileInstead.root, "packages/demo/package.json", '{"name":"demo"}');
  put(fileInstead.root, "packages/demo/tsconfig.json", JSON.stringify(config));
  put(
    fileInstead.root,
    "packages/demo/src/index.ts",
    "export const now = 1;\n",
  );
  add("diff.base-package-file-skips-callback", "diff", {
    root: fileInstead.pkg,
    map: currentMap,
    base: fileBase,
    baseMap: {
      kind: "fail",
      failure: { kind: "callback", message: "must not call" },
    },
  });
  const mode = (r, extra = {}) => ({
    root: r.pkg,
    mapFile: r.mapFile,
    given: ["api"],
    json: false,
    pretty: false,
    entry: "flags",
    ...extra,
  });
  for (const entry of ["flags", "view"])
    for (const pretty of [false, true])
      add(
        `mode.view-${entry}-${pretty}`,
        "mode",
        mode(main, { entry, pretty }),
      );
  for (const pretty of [false, true])
    add(
      `mode.diff-${pretty}`,
      "mode",
      mode(main, {
        base: main.sha,
        pretty,
        given: ["api", "apiBase", "pretty"],
      }),
    );
  add("mode.view-json-flag-ignored", "mode", mode(main, { json: true }));
  add("mode.inactive", "mode", {
    root: "missing",
    given: ["stray"],
    json: false,
    pretty: false,
    entry: "flags",
  });
  add("mode.orphan-base", "mode", {
    root: "missing",
    base: "HEAD",
    given: ["apiBase", "stray"],
    json: false,
    pretty: false,
    entry: "flags",
  });
  add("mode.orphan-policy", "mode", {
    root: "missing",
    policyFile: "missing",
    given: ["apiPolicy"],
    json: false,
    pretty: false,
    entry: "flags",
  });
  add("mode.orphan-both", "mode", {
    root: "missing",
    base: "HEAD",
    policyFile: "missing",
    given: ["apiPolicy", "apiBase"],
    json: false,
    pretty: false,
    entry: "flags",
  });
  add(
    "mode.stray-order",
    "mode",
    mode(main, {
      root: "missing",
      mapFile: "missing",
      policyFile: "missing",
      given: ["api", "layerScope", "URL", "layerScope", "raw\ud800Flag"],
    }),
  );
  add(
    "mode.policy-needs-base",
    "mode",
    mode(main, {
      mapFile: "missing",
      policyFile: "missing",
      given: ["api", "apiPolicy"],
    }),
  );
  add(
    "mode.missing-map",
    "mode",
    mode(main, { mapFile: path.join(main.pkg, "missing-map.json") }),
  );
  add(
    "mode.missing-map-raw-path",
    "mode",
    mode(main, {
      mapFile: path.join(main.pkg, "missing\ud800.json"),
    }),
  );
  add(
    "mode.missing-policy-raw-path",
    "mode",
    mode(main, {
      base: main.sha,
      policyFile: path.join(main.pkg, "missing\udfff-policy.json"),
    }),
  );
  put(main.root, "packages/demo/bad-map.json", "{");
  put(main.root, "packages/demo/null-map.json", "null");
  put(
    main.root,
    "packages/demo/bad-policy.json",
    JSON.stringify({ callout: "", tiers: [] }),
  );
  put(main.root, "packages/demo/syntax-policy.json", "{");
  put(
    main.root,
    "packages/demo/type-policy.json",
    JSON.stringify({ callout: "x", tiers: { constructor: null } }),
  );
  add(
    "mode.map-json-before-policy",
    "mode",
    mode(main, {
      mapFile: path.join(main.pkg, "bad-map.json"),
      base: "missing",
      policyFile: "missing",
    }),
  );
  add(
    "mode.policy-before-map-schema",
    "mode",
    mode(main, {
      mapFile: path.join(main.pkg, "null-map.json"),
      base: "missing",
      policyFile: path.join(main.pkg, "bad-policy.json"),
    }),
  );
  add(
    "mode.policy-json-refusal",
    "mode",
    mode(main, {
      base: "missing",
      policyFile: path.join(main.pkg, "syntax-policy.json"),
    }),
  );
  add(
    "mode.policy-type-crash",
    "mode",
    mode(main, {
      base: main.sha,
      policyFile: path.join(main.pkg, "type-policy.json"),
    }),
  );
  add(
    "mode.map-schema-before-ref",
    "mode",
    mode(main, {
      mapFile: path.join(main.pkg, "null-map.json"),
      base: "missing",
    }),
  );
  add("mode.invalid-base", "mode", mode(main, { base: "missing" }));
  for (const spec of [
    { kind: "input", message: "emit refused\ud800" },
    { kind: "callback", message: "  ordinary\ud800\n \t failure\u0085end  " },
    { kind: "callback", message: "ApiInputError: only a message" },
    { kind: "cleanup-input", message: "cleanup input wins" },
  ])
    add(
      `mode.emit-${spec.kind}-${spec.message.startsWith("ApiInput") ? "looking" : "raw"}`,
      "mode",
      mode(main, { emitFailure: spec }),
    );
  add(
    "mode.emit-then-report-fails",
    "mode",
    mode(main, {
      emitFailure: { kind: "callback", message: "first\ud800" },
      reportFailure: { kind: "callback", message: "report\udc00" },
    }),
  );
  add(
    "mode.input-then-report-fails",
    "mode",
    mode(main, {
      mapFile: "missing",
      reportFailure: { kind: "input", message: "report input" },
    }),
  );
  add(
    "mode.stray-report-fails",
    "mode",
    mode(main, {
      given: ["bad"],
      reportFailure: { kind: "callback", message: "precondition report" },
    }),
  );
  const met = repo("ratchet-met", {
    now: { ".changeset/change.md": "---\ndemo: major\n---\nBREAKING change\n" },
  });
  const below = repo("ratchet-below", {
    now: { ".changeset/change.md": "---\ndemo: minor\n---\nBREAKING change\n" },
  });
  for (const [name, r] of [
    ["miss", main],
    ["met", met],
    ["below", below],
  ])
    for (const json of [false, true])
      for (const pretty of [false, true])
        add(
          `mode.ratchet-${name}-${json}-${pretty}`,
          "mode",
          mode(r, {
            base: r.sha,
            policyFile: r.policyFile,
            json,
            pretty,
            given: [
              "api",
              "apiBase",
              "apiPolicy",
              ...(json ? ["json"] : []),
              ...(pretty ? ["pretty"] : []),
            ],
          }),
        );
  const malformed = repo("bad-changeset", {
    now: { ".changeset/bad.md": "not frontmatter\n" },
    policy: { callout: "x", tiers: {} },
  });
  add(
    "mode.changeset-before-tier-refusal",
    "mode",
    mode(malformed, { base: malformed.sha, policyFile: malformed.policyFile }),
  );
  const noName = repo("no-package-name", { packageJson: "{}" });
  add(
    "mode.package-name-after-diff",
    "mode",
    mode(noName, { base: noName.sha, policyFile: noName.policyFile }),
  );
  const tier = repo("missing-tier", { policy: { callout: "x", tiers: {} } });
  add(
    "mode.unpoliced-tier",
    "mode",
    mode(tier, { base: tier.sha, policyFile: tier.policyFile }),
  );
  const out = path.join(parent, "outputs");
  fs.mkdirSync(out);
  add(
    "mode.out-miss",
    "mode",
    mode(main, {
      base: main.sha,
      policyFile: main.policyFile,
      outFile: path.join(out, "miss.txt"),
      given: ["api", "apiBase", "apiPolicy", "out"],
    }),
  );
  add(
    "mode.out-met-json",
    "mode",
    mode(met, {
      base: met.sha,
      policyFile: met.policyFile,
      json: true,
      pretty: true,
      outFile: path.join(out, "met.json"),
      given: ["api", "apiBase", "apiPolicy", "json", "pretty", "out"],
    }),
  );
  add(
    "mode.out-failure",
    "mode",
    mode(main, {
      outFile: path.join(out, "missing-parent/out.txt"),
      given: ["api", "out"],
    }),
    "backendModeReport",
  );
  return { cases, repos, recipes, outputs: out };
}
