import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { apiViewReference, apiViewSchema } from "./api-view-reference.mjs";
import {
  createCheckWorktree,
  checkedExecFileSync as execFileSync,
  checkedSpawnSync as spawnSync,
} from "./check-worktree.mjs";

const baseline = process.argv[2];
assert.ok(
  baseline,
  "usage: node --import tsx api-view-mutations.mjs <baseline-driver> [report.json]",
);
assert.ok(process.argv.length <= 4);
assert.equal(process.version, "v22.21.1");
assert.equal(process.versions.v8, "12.4.254.21-node.33");
const root = fileURLToPath(new URL("../..", import.meta.url));
const manifest = createRequire(
  path.join(root, "packages/code-graph/package.json"),
).resolve("@typescript/native-preview/package.json");
const mutationCheck = createCheckWorktree(process.cwd(), "api-view-mutations");
let mutationFailure;
try {
  const directory = mutationCheck.root;
  const workspace = mutationCheck.root,
    target = mutationCheck.target,
    binary = path.join(target, "debug/examples/api_view_driver");
  const compilerTemp = path.join(directory, "compiler-temp");
  fs.mkdirSync(compilerTemp);
  const previousTemp = process.env.TMPDIR;
  process.env.TMPDIR = compilerTemp;
  const environment = {
    ...process.env,
    CARGO_PROFILE_DEV_DEBUG: "0",
    CARGO_PROFILE_TEST_DEBUG: "0",
    CARGO_INCREMENTAL: "0",
    CARGO_BUILD_JOBS: "1",
  };
  const baselineHash = createHash("sha256")
    .update(fs.readFileSync(baseline))
    .digest("hex");
  const prefix = "crates/code-graph/src/api/",
    text = `${prefix}text.rs`,
    read = `${prefix}read.rs`,
    emit = `${prefix}emit.rs`,
    model = `${prefix}model.rs`;
  const controls = [];
  function project(label, files) {
    const packageRoot = path.join(directory, label);
    for (const [name, source] of Object.entries(files)) {
      const file = path.join(packageRoot, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, source);
    }
    return packageRoot;
  }
  const config = JSON.stringify({
    compilerOptions: {
      strict: true,
      target: "ESNext",
      module: "ESNext",
      types: [],
      noEmitOnError: true,
    },
    include: ["src/**/*"],
  });
  const item = (id, input) => ({
    id,
    operation: "code_graph.api-view",
    input: apiViewSchema.parse(input),
  });
  const request = (id, root, entry = "src/index.ts", warn = "collect") =>
    item(id, {
      action: "read",
      root,
      map: { ".": { entry } },
      repoRoot: null,
      warn,
    });
  const names = (v) => v.view.subpaths["."].names,
    refs = (v, name = "api") => names(v)[name].references;
  function call(executable, request) {
    const run = spawnSync(executable, [manifest], {
      input: `${JSON.stringify(request)}\n`,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, TMPDIR: compilerTemp },
    });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stderr, "");
    const answer = JSON.parse(run.stdout);
    assert.equal(answer.id, request.id);
    assert.equal(answer.ok, true, JSON.stringify(answer.error));
    assert.ok(answer.observedCalls.length);
    return answer.output;
  }
  function fault(
    name,
    file,
    before,
    after,
    item,
    beforeCheck,
    afterCheck,
    unchanged,
  ) {
    return {
      name,
      file,
      before,
      after,
      item,
      beforeCheck,
      afterCheck,
      unchanged,
    };
  }
  try {
    const pkg = project("package", {
      "tsconfig.json": config,
      "src/index.ts": [
        "interface A {b:B} interface B {c:C} type C={n:number};",
        "declare const Brand: unique symbol; class Base {readonly base=1}",
        "export class Derived extends Base {} export interface Branded {readonly [Brand]:A}",
        "export interface Public {readonly n:number} export declare function published(x:Public):Public;",
        "export declare function api(a:A):A; export type Query=typeof Brand;",
        "export type Imported=import('./hidden').Hidden;",
      ].join("\n"),
      "src/hidden.ts": "export interface Hidden {readonly private:string}",
      "src/aliases.ts": "export {api as a,api as b} from './index';",
      "src/proto.ts":
        'const local=1;export {local as "__proto__",local as a,local as b};',
      "src/errors.ts": "export const wrong:string=1;",
    });
    const declarations = project("declarations", {
      "tsconfig.json": JSON.stringify({
        compilerOptions: { types: [] },
        files: [],
      }),
      "out/entry.d.ts": "  export declare const a:string,b:number;\n",
      "raw�/entry.d.ts":
        "interface Private {x:number} export declare function api(x:Private):Private; export {};",
    });
    const excluded = project("excluded", {
      "tsconfig.json": JSON.stringify({
        compilerOptions: { types: [] },
        files: ["included.ts"],
      }),
      "included.ts": "export const yes=1;",
      "src/index.ts": "export const no=1;",
    });
    const raw = project("raw�", {
      "tsconfig.json": config,
      "src/index.ts": "export const raw=1;",
    }).replace("raw�", "raw\ud800");
    const large = project("large", {
      "tsconfig.json": config,
      "src/index.ts": Array.from(
        { length: 16000 },
        (_, i) => `export const n${i}:string=1;`,
      ).join("\n"),
    });
    const nodeItem = (id, kind) =>
      item(id, {
        action: "nodes",
        config: path.join(declarations, "tsconfig.json"),
        file: path.join(declarations, "out/entry.d.ts"),
        select: [{ kind, nth: 0 }],
      });
    const emitted = (id, entry) =>
      item(id, {
        action: "emitted",
        root: pkg,
        subpaths: [
          {
            subpath: ".",
            entry,
            entryAbsolute: path.join(pkg, entry),
            tier: null,
          },
        ],
        repoRoot: null,
        context: null,
        warn: "collect",
      });
    const mutations = [
      fault(
        "nel-is-retained-as-trivia",
        text,
        "0x85 | 0x2028 | 0x2029 =>",
        "0x2028 | 0x2029 =>",
        item("bare-nel-skipped", { action: "text", text: "\u0085/*gone*/x" }),
        (v) => assert.equal(v.clean, "x"),
        (v) => assert.equal(v.clean, "\u0085x"),
      ),
      fault(
        "template-close-is-not-rescanned",
        text,
        "125 if holes.last() == Some(&depth) =>",
        "125 if false =>",
        item("template-chunk-keeps-comment-spelling", {
          action: "text",
          text: "type T=`a\u0024{{b:1}.b}/*keep*/`; /*gone*/",
        }),
        (v) => assert.ok(v.clean.includes("/*keep*/")),
        (v) => assert.ok(!v.clean.includes("/*keep*/")),
      ),
      fault(
        "string-crlf-continuation-stops-early",
        text,
        "        end + 1",
        "        end",
        item("continued-string-is-one-token", {
          action: "text",
          text: 'type T="continued\\\r\n/*keep*/"; //gone',
        }),
        (v) => assert.ok(v.clean.includes("/*keep*/")),
        (v) => assert.ok(!v.clean.includes("/*keep*/")),
      ),
      fault(
        "nontext-remainder-is-scanned-again",
        text,
        "0xfffd => position = units.len()",
        "0xfffd => position += 1",
        item("replacement-token-keeps-remainder", {
          action: "text",
          text: "x�/*keep*/",
        }),
        (v) => assert.equal(v.clean, "x�/*keep*/"),
        (v) => assert.equal(v.clean, "x�"),
      ),
      fault(
        "tidy-retains-blank-lines",
        text,
        "(end > 0).then(|| JsString::from_units(line[..end].to_vec()))",
        "Some(JsString::from_units(line[..end].to_vec()))",
        item("indent-kept-empty-lines-dropped", {
          action: "text",
          text: "\n  type T=1;  \n\n",
        }),
        (v) => assert.equal(v.tidy, "  type T=1;"),
        (v) => assert.notEqual(v.tidy, "  type T=1;"),
      ),
      fault(
        "variable-is-not-whole-statement",
        text,
        'if declaration.is_kind("VariableDeclaration")',
        "if false",
        nodeItem("whole-multiple-variable-statement", "VariableDeclaration"),
        (v) => assert.ok(v[0].text.includes("a:string,b:number")),
        (v) => assert.ok(!v[0].text.includes("b:number")),
      ),
      fault(
        "source-file-skips-leading-indent",
        text,
        'if statement.is_kind("SourceFile") {\n        0',
        'if statement.is_kind("SourceFile") {\n        statement.start()?',
        nodeItem("source-file-starts-at-zero", "SourceFile"),
        (v) => assert.ok(v[0].text.startsWith("  export")),
        (v) => assert.ok(!v[0].text.startsWith("  export")),
      ),
      fault(
        "published-alias-is-not-followed",
        read,
        "        let symbol = program.alias_target(&symbol)?.unwrap_or(symbol);\n",
        "",
        request("alias-follows-declaration", pkg, "src/aliases.ts"),
        (v) => assert.ok(names(v).a.text.includes("function api")),
        (v) => assert.ok(!names(v).a.text.includes("function api")),
      ),
      fault(
        "type-query-reference-is-ignored",
        read,
        'node.is_kind("TypeQuery")',
        "false",
        request("typeof-private-brand", pkg),
        (v) =>
          assert.ok(
            Object.keys(refs(v, "Query")).some((k) => k.endsWith("#Brand")),
          ),
        (v) => assert.deepEqual(refs(v, "Query"), {}),
      ),
      fault(
        "computed-member-reference-is-ignored",
        read,
        'node.is_kind("ComputedPropertyName")',
        "false",
        request("computed-private-brand", pkg),
        (v) =>
          assert.ok(
            Object.keys(refs(v, "Branded")).some((k) => k.endsWith("#Brand")),
          ),
        (v) =>
          assert.ok(
            !Object.keys(refs(v, "Branded")).some((k) => k.endsWith("#Brand")),
          ),
      ),
      fault(
        "heritage-reference-is-ignored",
        read,
        'node.is_kind("ExpressionWithTypeArguments")',
        "false",
        request("private-heritage", pkg),
        (v) =>
          assert.ok(
            Object.keys(refs(v, "Derived")).some((k) => k.endsWith("#Base")),
          ),
        (v) => assert.deepEqual(refs(v, "Derived"), {}),
      ),
      fault(
        "import-type-reference-is-ignored",
        read,
        'node.is_kind("ImportType")',
        "false",
        request("import-type-qualifier", pkg),
        (v) =>
          assert.ok(
            Object.keys(refs(v, "Imported")).some((k) => k.endsWith("#Hidden")),
          ),
        (v) => assert.deepEqual(refs(v, "Imported"), {}),
      ),
      fault(
        "raw-out-prefix-is-replaced",
        read,
        "!file.units().starts_with(prefix.units())",
        "!file.to_lossy().starts_with(&prefix.to_lossy())",
        item("raw-prefix-differs-from-physical-replacement", {
          action: "program",
          config: path.join(declarations, "tsconfig.json"),
          out: path.join(declarations, "raw\ud800"),
          entries: [[".", path.join(declarations, "raw�/entry.d.ts")]],
        }),
        (v) => assert.deepEqual(v[0][1].names.api.references, {}),
        (v) =>
          assert.ok(
            Object.keys(v[0][1].names.api.references).some((k) =>
              k.endsWith("#Private"),
            ),
          ),
      ),
      fault(
        "published-reference-is-inlined",
        read,
        "if self.published.contains(&node_key(&node)?)",
        "if false",
        request("published-ancestor-not-private", pkg),
        (v) => assert.deepEqual(refs(v, "published"), {}),
        (v) =>
          assert.ok(
            Object.keys(refs(v, "published")).some((k) =>
              k.endsWith("#Public"),
            ),
          ),
      ),
      fault(
        "reference-walk-stops-after-first-hop",
        read,
        "queue.push_back(reached);",
        "let _ = reached;",
        request("three-private-hops", pkg),
        (v) => assert.equal(Object.keys(refs(v)).length, 3),
        (v) => assert.equal(Object.keys(refs(v)).length, 1),
      ),
      fault(
        "producer-prototype-becomes-own",
        model,
        'if name == "__proto__" {\n            self.prototype = Some(entry);',
        "if false {\n            self.prototype = Some(entry);",
        emitted("prototype-is-not-own", "src/proto.ts"),
        (v) => {
          assert.equal(v.names[0][1].keys.includes("__proto__"), false);
          assert.ok(v.names[0][1].prototype);
        },
        (v) => {
          assert.ok(v.names[0][1].keys.includes("__proto__"));
          assert.equal(v.names[0][1].prototype, null);
        },
      ),
      fault(
        "alias-facts-share-object",
        read,
        `        read.assign(
            name,
            Arc::new(ApiEntryText {
                text: joined_text(&declarations)?,
                references: Arc::new(references),
            }),
        );`,
        `        let entry = Arc::new(ApiEntryText {text: joined_text(&declarations)?, references: Arc::new(references)});
        let entry = read.entries.first().map(|(_, first)| Arc::clone(first)).unwrap_or(entry);
        read.assign(name, entry);`,
        emitted("aliases-fresh-with-equal-data", "src/aliases.ts"),
        (v) =>
          assert.deepEqual(v.names[0][1].identity, [
            [true, false],
            [false, true],
          ]),
        (v) =>
          assert.deepEqual(v.names[0][1].identity, [
            [true, true],
            [true, true],
          ]),
        (v) => v.names[0][1].names,
      ),
      fault(
        "diagnostic-warning-ignored",
        `${prefix}view.rs`,
        "if emit.get().diagnostics > 0.0",
        "if false",
        request("type-errors-one-warning", pkg, "src/errors.ts"),
        (v) => assert.equal(v.warnings.length, 1),
        (v) => assert.deepEqual(v.warnings, []),
      ),
      fault(
        "warning-refusal-leaves-temp",
        emit,
        "match (result, remove_emit(&emit.temp))",
        "match (result, Ok(()))",
        request("warning-failure-cleans-emit", pkg, "src/errors.ts", "fail"),
        (v) => assert.equal(v.tempClean, true),
        (v) => assert.equal(v.tempClean, false),
      ),
      fault(
        "compiler-preserves-no-emit-on-error",
        emit,
        '"--noEmitOnError",\n            "false",',
        '"--noEmitOnError",\n            "true",',
        request("type-errors-still-publish", pkg, "src/errors.ts"),
        (v) => assert.ok(names(v).wrong),
        (v) =>
          assert.match(v.thrown.message, /has no emitted declaration file/),
      ),
      fault(
        "missing-emitted-entry-is-accepted",
        emit,
        "if !std::path::Path::new(&emitted.to_lossy()).exists()",
        "if false",
        request("excluded-entry-observable", excluded),
        (v) =>
          assert.match(v.thrown.message, /has no emitted declaration file/),
        (v) => assert.deepEqual(names(v), {}),
      ),
      fault(
        "output-budget-is-enlarged",
        `${prefix}capture.rs`,
        "MAX_BUFFER: usize = 1024 * 1024",
        "MAX_BUFFER: usize = 16 * 1024 * 1024",
        item("large-compiler-output-refused", {
          action: "emit",
          root: large,
          config: path.join(large, "tsconfig.json"),
          subpaths: [],
        }),
        (v) => assert.match(v.thrown.message, / ENOBUFS$/),
        (v) => assert.equal(v.diagnostics, 1),
      ),
      fault(
        "raw-config-replaced-before-go",
        "crates/code-graph/src/engine/tsgo/mod.rs",
        "Some(ts_config_path.clone()),",
        "None,",
        request("actual-go-rejects-raw-config", raw),
        (v) => assert.match(v.thrown.message, /invalid surrogate pair/),
        (v) => assert.ok(names(v).raw),
      ),
    ];
    const originals = new Map();
    for (const m of mutations)
      if (!originals.has(m.file))
        originals.set(m.file, fs.readFileSync(path.join(root, m.file), "utf8"));
    const expected = new Map();
    for (const m of mutations) {
      const source = JSON.parse(
        JSON.stringify(await apiViewReference(m.item.input)),
      );
      assert.deepEqual(
        call(baseline, m.item),
        source,
        `baseline/source: ${m.name}`,
      );
      m.beforeCheck(source);
      assert.equal(
        originals.get(m.file).split(m.before).length,
        2,
        `fault sites: ${m.name}`,
      );
      expected.set(m.name, source);
    }

    for (const m of mutations) {
      for (const [file, original] of originals)
        fs.writeFileSync(path.join(workspace, file), original);
      fs.writeFileSync(
        path.join(workspace, m.file),
        originals.get(m.file).replace(m.before, m.after),
      );
      execFileSync(
        process.env.CARGO ?? "cargo",
        [
          "build",
          "--offline",
          "-p",
          "demlik-code-graph",
          "--example",
          "api_view_driver",
        ],
        {
          cwd: workspace,
          env: environment,
          encoding: "utf8",
          maxBuffer: 16 * 1024 * 1024,
          stdio: "pipe",
        },
      );
      const actual = call(binary, m.item),
        source = expected.get(m.name);
      assert.notDeepEqual(actual, source, `${m.name}: escaped`);
      m.afterCheck(actual);
      if (m.unchanged)
        assert.deepEqual(
          m.unchanged(actual),
          m.unchanged(source),
          `${m.name}: independent identity witness`,
        );
      controls.push({
        name: m.name,
        detected: true,
        item: m.item,
        expected: source,
        mutant: actual,
      });
      process.stdout.write(
        `${JSON.stringify({ detected: m.name, witness: m.item.id })}\n`,
      );
    }
    assert.equal(
      createHash("sha256").update(fs.readFileSync(baseline)).digest("hex"),
      baselineHash,
      "isolated target preserves baseline driver",
    );
    const report = {
      detected: controls.length,
      escaped: 0,
      baselineMatchesSource: true,
      baselineDriverUnchanged: true,
      baselineDriverHash: baselineHash,
      reference: { node: process.version, v8: process.versions.v8 },
      buildProfile: {
        devDebug: 0,
        testDebug: 0,
        incremental: false,
        jobs: 1,
        target,
      },
      controls,
    };
    if (process.argv[3])
      fs.writeFileSync(process.argv[3], `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(
      `${JSON.stringify({ detected: report.detected, escaped: report.escaped })}\n`,
    );
  } finally {
    if (previousTemp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTemp;
  }
} catch (error) {
  mutationFailure = error;
  throw error;
} finally {
  mutationCheck.remove(mutationFailure);
}
