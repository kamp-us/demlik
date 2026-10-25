import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { listRepo } from "../../packages/code-graph/src/extract/project.js";
import {
  findWranglerConfigs,
  loadBindingCatalog,
} from "../../packages/code-graph/src/extract/wrangler-config.js";
import {
  MID_FILE_ERRORS,
  SEARCH_CONFIG,
} from "../../packages/code-graph/src/test-helpers/wrangler-configs.js";

const binary = process.argv[2];
assert.ok(
  binary,
  "usage: node --import tsx graph-catalog.mts <native-driver> [evidence.json]",
);
assert.equal(process.version, "v22.21.1");
assert.ok(process.versions.v8.startsWith("12.4."));
const inputSchema = z.strictObject({
  root: z.string(),
  reuseListing: z.boolean().default(false),
  listingRoot: z.string().nullable().optional(),
});
type Case = {
  id: string;
  operation: "code_graph.catalog";
  input: z.infer<typeof inputSchema>;
};
const resultSchema = z.object({
  id: z.string().nullable(),
  ok: z.boolean(),
  output: z.unknown().optional(),
  error: z.object({ kind: z.string(), message: z.string() }).optional(),
  observedCalls: z.array(z.string()),
});
const root = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "demlik-catalog-parity-")),
);
const cases: Case[] = [];
function write(file: string, text: string): void {
  const absolute = path.join(root, file);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, text);
}
function add(
  id: string,
  directory: string,
  options: Partial<z.infer<typeof inputSchema>> = {},
): void {
  cases.push({
    id,
    operation: "code_graph.catalog",
    input: inputSchema.parse({ root: path.join(root, directory), ...options }),
  });
}
function reference(item: Case): {
  ok: boolean;
  output?: unknown;
  error?: { kind: string; message: string };
} {
  try {
    const input = item.input;
    const listing = input.reuseListing
      ? listRepo(input.listingRoot ?? input.root)
      : undefined;
    return {
      ok: true,
      output: {
        configs: findWranglerConfigs(input.root, listing),
        catalog: loadBindingCatalog(input.root, listing),
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: {
        kind: error instanceof TypeError ? "type-error" : "backend-error",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
try {
  write(
    "groups/services/a/wrangler.jsonc",
    '\ufeff// api\n{"name":"api","main":"./src/main.ts","services":[{"binding":"SEARCH","service":"worker"}],"durable_objects":{"bindings":[{"name":"ROOM","class_name":"Room"}]},"workflows":[{"binding":"FLOW","class_name":"Flow"}],"d1_databases":[{"binding":"DB"}],"vars":{"Z":1},"secrets":{"required":["A","Z"]},"unknown":{"binding":"UNLISTED"},"env":{"test":{"binding":"IGNORED"}},}',
  );
  write(
    "groups/services/a/.dev.vars",
    "# local\n LOCAL = one\n\ufeffBOM=two\n\u0085KEY=three\nexport EXPORTED=four\n",
  );
  write("groups/services/a/.dev.vars.example", "EXAMPLE=one\nLOCAL=two\n");
  write(
    "groups/services/b/wrangler.toml",
    "name = 'worker'\nmain = 'index.ts'\nlegacy = 2024-02-30\n[[services]]\nbinding = 'API'\nservice = 'api'\n",
  );
  write("groups/services/bad/wrangler.json", '{"name":"broken","services":[{');
  write(
    "groups/services/unsafe/wrangler.toml",
    "name='unsafe'\nignored=9007199254740992\n",
  );
  write(
    "groups/services/leap/wrangler.toml",
    "name='leap'\nignored=23:59:60\n",
  );
  add("real-groups-legacy-dates-safe-integers-and-dev-vars", "groups");
  add("same-catalog-with-reused-file-listing", "groups", {
    reuseListing: true,
  });
  add("subtree-catalog-reuses-repo-file-listing", "groups/services/a", {
    reuseListing: true,
    listingRoot: path.join(root, "groups"),
  });
  const jsonc = [
    [
      "inherited",
      '{"__proto__":{"name":"inherited","services":[{"binding":"B","service":"remote"}]},"vars":{"__proto__":null,"__proto__":{"binding":"OWN"},"X":1}}',
    ],
    ["throwing", '{"name":2,"vars":{"__proto__":{"constructor":null}}}'],
    ["array-proto", '{"vars":{"__proto__":[],"X":1}}'],
    ["null-proto", '{"vars":{"__proto__":null,"X":1}}'],
    ["primitive-proto", '{"__proto__":1,"vars":{"__proto__":"ignored","X":1}}'],
    [
      "fake-constructor",
      '{"vars":{"constructor":{"prototype":{"isPrototypeOf":false}},"X":1}}',
    ],
    [
      "inherited-constructor",
      '{"vars":{"__proto__":{"constructor":{"prototype":{"isPrototypeOf":false}}},"X":1}}',
    ],
    ["own-null-constructor", '{"vars":{"constructor":null}}'],
    ["constructor-array", '{"vars":{"constructor":[],"X":1}}'],
    [
      "raw-main",
      String.raw`{"main":"./\ud800.ts","name":"\udfff","services":[{"binding":"\ud800","service":"\udfff","entrypoint":"\ud800"}],"vars":{"\ud800":1},"secrets":{"required":["\udfff"]}}`,
    ],
    ["erased-main", String.raw`{"main":"\ud800/../actual.ts"}`],
    [
      "wrong-services-catches-all",
      '{"services":[{"binding":"GOOD","service":"ok"},{"binding":3,"service":"bad"}],"d1_databases":[{"binding":"DB"}]}',
    ],
    [
      "wrong-do-catches-all",
      '{"durable_objects":{"bindings":[{"name":"A","class_name":"A"},{"name":"B","class_name":"B","script_name":null}]}}',
    ],
    [
      "wrong-workflow-catches-all",
      '{"workflows":[{"binding":"A","class_name":"A"},{"binding":"B"}]}',
    ],
    [
      "wrong-named-group-catches-all",
      '{"d1_databases":[{"binding":"A"},1],"queues":{"producers":[{"binding":"Q"}]},"kv_namespaces":null,"r2_buckets":"r"}',
    ],
    [
      "wrong-secrets-catches-required",
      '{"vars":{"one":1},"secrets":{"required":["one",3]}}',
    ],
    [
      "wrong-vars-catches-record",
      '{"vars":{"constructor":[],"one":1},"secrets":{"required":["known"]}}',
    ],
    ["wrong-name-unparsed", '{"name":1}'],
    ["null-main-unparsed", '{"main":null}'],
    ["empty-name-is-retained", '{"name":"","main":""}'],
    ["inherited-field-null-is-unparsed", '{"__proto__":{"name":null}}'],
    [
      "nested-env-binding-is-retained",
      '{"env":{"dev":{"binding":"TOP_IGNORED"}},"unknown":{"env":{"binding":"NESTED"}}}',
    ],
  ] as const;
  for (const [id, text] of jsonc) {
    write(`jsonc/${id}/wrangler.jsonc`, text);
    add(`jsonc-${id}`, `jsonc/${id}`);
  }
  for (const [index, text] of [
    '// line comment\n{"name":"a"}',
    '/* block */{"name":"a"}',
    '// CR comment\r{"name":"a"}',
    '{"name":"a",}',
    '{"services":[{"binding":"B","service":"b"},]}',
    SEARCH_CONFIG,
    ...MID_FILE_ERRORS.map((item) => item.text),
    "{,}",
    "[,]",
    '{"name":,"main":"x"}',
    '{"x":[1,,]}',
    '{"x":1,/* unclosed',
    "# shell comment\n{}",
    '{"x":1} garbage',
    '{"x":"/* literal */","main":"http://example"}',
    "",
    "null",
    "[]",
    "true",
    "\ufeff\ufeff{}",
    '{"x":1e400}',
    '{"x":01}',
    '{"x":1.}',
    '{"x":+1}',
    '{"x":"\\x41"}',
    '{"x":1}\ufeff',
    '{"x":1,\v}',
    '{"x":1//EOF',
    '{"x":"line\nraw"}',
  ].entries()) {
    write(`syntax/${index}/wrangler.jsonc`, text);
    add(`jsonc-syntax-${index}`, `syntax/${index}`);
  }
  const tomls = [
    "name='safe'\nvalue=9007199254740991\n",
    "name='unsafe'\nvalue=-9007199254740992\n",
    "value=inf\n",
    "value=nan\n",
    "value=2024-02-30\n",
    "value=2023-02-29\n",
    "value=2024-04-31\n",
    "value=2024-13-01\n",
    "value=2024-01-32\n",
    "value=24:00:00\n",
    "value=23:59:60\n",
    "value=1979-05-27T07:32:60Z\n",
    "value=07:32\n",
    "[vars]\n2024-02-30='key stays literal'\n",
    "[__proto__]\nname='inherited'\n[vars]\n__proto__={binding='OWN'}\nX=1\n",
    "[vars]\nconstructor=1\nX=1\n",
    "name='d'\n[vars]\nconstructor={prototype={isPrototypeOf=1}}\nX=1\n",
    "name='a'\nmain='src/index.ts'\n[[workflows]]\nbinding='W'\nclass_name='Flow'\n",
    'name="\\e"\n',
    "name='''multi\nline'''\n",
    "[vars]\nA=2024-02-30\nB=0x1f\n",
    "name = 'unclosed\n",
    "[vars]\nA=1\nA=2\n",
    "[vars]\nA=[1,2,]\n",
    "name='a'\n[vars]\nX={\na=1,\n}\n",
    '\ufeff\ufeffname="bom"\n',
  ];
  for (const [index, text] of tomls.entries()) {
    write(`toml/${index}/wrangler.toml`, text);
    add(`toml-syntax-and-source-profile-${index}`, `toml/${index}`);
  }
  write("multiple/wrangler.toml", "name='same'\n");
  write("multiple/wrangler.json", '{"name":"same"}');
  write("multiple/wrangler.jsonc", '{"name":"same"}');
  write("multiple/node_modules/ignored/wrangler.json", "{}");
  write("multiple/.hidden/wrangler.json", "{}");
  add("multiple-configs-stable-order-and-visible-file-rules", "multiple");
  fs.mkdirSync(path.join(root, "empty"));
  add("empty-catalog", "empty");
  add("missing-catalog-root", "missing");
  write("dot/holder/wrangler.json", '{"name":"lexical"}');
  write("dot/holder/lexical-only/wrangler.json", "{}");
  write("dot/outside/wrangler.json", '{"name":"physical"}');
  write("dot/outside/physical-only/wrangler.json", "{}");
  fs.mkdirSync(path.join(root, "dot/outside/nested"), { recursive: true });
  fs.symlinkSync(
    path.join(root, "dot/outside/nested"),
    path.join(root, "dot/holder/link"),
    "dir",
  );
  cases.push({
    id: "dot-segments-normalize-before-following-symlinks",
    operation: "code_graph.catalog",
    input: { root: `${root}/dot/holder/link/..`, reuseListing: false },
  });
  cases.push({
    id: "relative-catalog-paths",
    operation: "code_graph.catalog",
    input: {
      root: path.relative(process.cwd(), path.join(root, "groups")),
      reuseListing: false,
    },
  });
  const repo = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../..",
  );
  cases.push({
    id: "existing-core-fixture-binding-catalog",
    operation: "code_graph.catalog",
    input: {
      root: path.join(repo, "packages/code-graph/test/parity/fixture"),
      reuseListing: true,
    },
  });
  const expected = cases.map(reference);
  assert.deepEqual(
    z
      .object({ configs: z.array(z.string()) })
      .parse(
        expected.find(
          (_, index) =>
            cases[index].id ===
            "dot-segments-normalize-before-following-symlinks",
        )?.output,
      ).configs,
    [path.join(root, "dot/holder/wrangler.json")],
  );
  const checked = z
    .object({
      catalog: z.object({
        manifests: z.array(
          z.object({
            service: z.string(),
            bindingNames: z.array(z.string()),
            envKeys: z.array(z.string()),
            main: z.string().nullable(),
          }),
        ),
        unparsedConfigs: z.array(z.string()),
      }),
    })
    .parse(expected[0].output);
  assert.equal(checked.catalog.manifests.length, 2);
  assert.deepEqual(checked.catalog.unparsedConfigs, [
    "services/bad/wrangler.json",
    "services/leap/wrangler.toml",
    "services/unsafe/wrangler.toml",
  ]);
  assert.deepEqual(checked.catalog.manifests[0].bindingNames, [
    "DB",
    "FLOW",
    "SEARCH",
    "UNLISTED",
  ]);
  const invalid = [
    "not json",
    JSON.stringify({
      id: "missing",
      operation: "code_graph.catalog",
      input: {},
    }),
    JSON.stringify({
      id: "unsupported",
      operation: "invented",
      input: { root },
    }),
    JSON.stringify({
      id: "bad-reuse",
      operation: "code_graph.catalog",
      input: { root, reuseListing: "yes" },
    }),
    JSON.stringify({
      id: "unknown-option",
      operation: "code_graph.catalog",
      input: { root, ignored: true },
    }),
  ];
  const native = spawnSync(binary, [], {
    input: `${[...cases.map((item) => JSON.stringify(item)), ...invalid].join("\n")}\n`,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  assert.equal(native.status, 0, native.stderr);
  assert.equal(native.stderr, "");
  const actual = native.stdout
    .trim()
    .split("\n")
    .map((line) => resultSchema.parse(JSON.parse(line)));
  assert.equal(actual.length, cases.length + invalid.length);
  for (const [index, answer] of expected.entries()) {
    const returned = actual[index];
    assert.equal(
      returned.ok,
      answer.ok,
      `${cases[index].id}: ${JSON.stringify(returned.error)}`,
    );
    if (answer.ok)
      assert.deepEqual(returned.output, answer.output, cases[index].id);
    else assert.deepEqual(returned.error, answer.error, cases[index].id);
    assert.ok(
      returned.observedCalls.includes(
        "demlik_code_graph::extract::wrangler_config::load_binding_catalog",
      ),
    );
  }
  for (const answer of actual.slice(cases.length)) {
    assert.equal(answer.ok, false);
    assert.ok(answer.error?.message);
    assert.deepEqual(answer.observedCalls, []);
  }
  const evidence = {
    reference: {
      node: process.version,
      v8: process.versions.v8,
      jsonc: "jsonc-parser 3.3.1",
      toml: "smol-toml 1.9.0",
      nativeToml: "toml 1.1.8 spec1.1.0 / toml_parser 1.1.5",
    },
    passed: cases.length,
    rejectedInvalidInputs: invalid.length,
    nativeApis: [
      ...new Set(actual.flatMap((answer) => answer.observedCalls)),
    ].sort(),
    cases: actual,
  };
  if (process.argv[3])
    fs.writeFileSync(process.argv[3], `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify({ ...evidence, cases: undefined }, null, 2));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
