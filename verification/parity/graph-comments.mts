import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  governedRatio,
  loadCommentCensus,
} from "../../packages/code-graph/src/comments/census.js";
import {
  bucketRecord,
  bucketsIn,
  COMMENT_BUCKETS,
  type CommentBucket,
  classifyComment,
  classOf,
  commentBody,
  isBanner,
  isCommentedOutCode,
} from "../../packages/code-graph/src/comments/classify.js";
import { assembleGraph } from "../../packages/code-graph/src/extract/assemble.js";
import { loadCheapProject } from "../../packages/code-graph/src/extract/project.js";
import { ThresholdsSchema } from "../../packages/code-graph/src/schema.js";

const binary = process.argv[2];
assert.ok(
  binary,
  "usage: node --import tsx graph-comments.mts <native-driver> [evidence.json]",
);
assert.equal(process.version, "v22.21.1");
assert.ok(process.versions.v8.startsWith("12.4."));
const repo = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const bucketSchema = z.enum(COMMENT_BUCKETS),
  classSchema = z.enum(["protected", "mechanical", "prose"]);
const shapeInput = z.strictObject({
  text: z.string(),
  pos: z.number().int().nonnegative().default(100),
  fileHeaderCandidate: z.boolean().default(false),
});
const censusInput = z.strictObject({ root: z.string() });
const ratioFields = {
  loc: z.number(),
  codeLines: z.number(),
  commentLines: z.number(),
  mechanicalLines: z.number(),
  protectedLines: z.number(),
  proseLines: z.number(),
  ratio: z.number(),
};
const censusSchema = z.strictObject({
  totals: z.strictObject({
    ...ratioFields,
    files: z.number(),
    blankLines: z.number(),
  }),
  buckets: z.record(
    bucketSchema,
    z.strictObject({ lines: z.number(), count: z.number(), files: z.number() }),
  ),
  scopes: z.array(
    z.strictObject({ ...ratioFields, scope: z.string(), files: z.number() }),
  ),
  files: z.array(
    z.strictObject({
      ...ratioFields,
      file: z.string(),
      blankLines: z.number(),
      isTest: z.boolean(),
      buckets: z.record(bucketSchema, z.number()),
    }),
  ),
});
const shapeOutput = z.strictObject({
  body: z.string(),
  banner: z.boolean(),
  commentedOutCode: z.boolean(),
  bucket: bucketSchema,
  class: classSchema,
});
const censusOutput = z.strictObject({
  census: censusSchema,
  governedRatios: z.array(
    z.strictObject({ scope: z.string(), ratio: z.number() }),
  ),
});
const bucketOutput = z.strictObject({
  buckets: z.array(bucketSchema),
  classes: z.record(bucketSchema, classSchema),
  protected: z.array(bucketSchema),
  mechanical: z.array(bucketSchema),
  prose: z.array(bucketSchema),
});
const responseSchema = z.object({
  id: z.string().nullable(),
  ok: z.boolean(),
  output: z.unknown().optional(),
  error: z.object({ kind: z.string(), message: z.string() }).optional(),
  observedCalls: z.array(z.string()),
});
type Response = z.infer<typeof responseSchema>;
type Case = {
  id: string;
  operation:
    | "code_graph.comment_classify"
    | "code_graph.comment_census"
    | "code_graph.comment_buckets";
  input: unknown;
};
const root = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "demlik-comments-parity-")),
);
const cases: Case[] = [];
function write(file: string, text: string): void {
  const absolute = path.join(root, file);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, text);
}
function census(id: string, dir: string): void {
  cases.push({
    id,
    operation: "code_graph.comment_census",
    input: { root: path.join(root, dir) },
  });
}
function reference(item: Case): Response {
  if (item.operation === "code_graph.comment_buckets") {
    const classes = bucketRecord(() => "prose");
    for (const bucket of COMMENT_BUCKETS) classes[bucket] = classOf(bucket);
    return {
      id: item.id,
      ok: true,
      output: {
        buckets: COMMENT_BUCKETS,
        classes,
        protected: bucketsIn("protected"),
        mechanical: bucketsIn("mechanical"),
        prose: bucketsIn("prose"),
      },
      observedCalls: [],
    };
  }
  if (item.operation === "code_graph.comment_classify") {
    const input = shapeInput.parse(item.input),
      body = commentBody(input.text),
      bucket = classifyComment(input);
    return {
      id: item.id,
      ok: true,
      output: {
        body,
        banner: isBanner(body),
        commentedOutCode: isCommentedOutCode(body),
        bucket,
        class: classOf(bucket),
      },
      observedCalls: [],
    };
  }
  const input = censusInput.parse(item.input),
    result = loadCommentCensus(input.root);
  const graph = assembleGraph(
    loadCheapProject(input.root),
    ThresholdsSchema.parse({}),
  );
  assert.equal(
    result.totals.commentLines,
    graph.stats.totalCommentLines,
    item.id,
  );
  assert.equal(result.totals.loc, graph.stats.totalLoc, item.id);
  assert.equal(result.totals.files, graph.stats.fileCount, item.id);
  return {
    id: item.id,
    ok: true,
    output: {
      census: result,
      governedRatios: result.scopes.map((scope) => ({
        scope: scope.scope,
        ratio: governedRatio(scope),
      })),
    },
    observedCalls: [],
  };
}
try {
  const direct: ReadonlyArray<readonly [string, string, CommentBucket]> = [
    ["line-body", "//  hello  ", "inline"],
    ["block-body", "/* hello */", "block"],
    ["doc-stars", "/**\n * one\n * two\n */", "docblock"],
    ["empty-comment", "//", "inline"],
    ["empty-doc-star-delimiter", "/**/", "docblock"],
    ["empty-block", "/* */", "block"],
    ["pragma-typescript", "// @ts-expect-error narrowing", "pragma"],
    [
      "pragma-biome",
      "// biome-ignore lint/suspicious/noExplicitAny: boundary",
      "pragma",
    ],
    ["pragma-eslint", "// eslint-disable-next-line", "pragma"],
    ["pragma-coverage", "/* c8 ignore next */", "pragma"],
    ["pragma-xml-reference", "/// <reference types='node' />", "pragma"],
    ["pragma-jsx", "// @jsxImportSource preact", "pragma"],
    ["pragma-over-marker", "// @ts-ignore TODO drop this", "pragma"],
    ["license-away-from-start", "// Copyright 2026 Binclusive", "inline"],
    [
      "spdx-away-from-start",
      "// SPDX-License-Identifier: Apache-2.0",
      "inline",
    ],
    ["marker-todo", "/** TODO: collapse this with the other one */", "marker"],
    ["marker-fixme", "// FIXME later", "marker"],
    ["marker-deprecated", "/** @deprecated use next() */", "marker"],
    ["marker-ascii-boundary", "// éTODOé", "marker"],
    ["marker-not-subword", "// XTODOS XFIXME", "inline"],
    ["typescript-const", "// const x = 1;", "commented-out-code"],
    ["return-function-wrapper", "// return null;", "commented-out-code"],
    [
      "return-rejected-in-module-accepted-in-function",
      "// return await work();",
      "inline",
    ],
    [
      "import-declaration",
      "// import { a } from './a.js';",
      "commented-out-code",
    ],
    ["tsx-element", "// <Button disabled />", "commented-out-code"],
    [
      "typescript-export-type",
      "/* export type X = { a: string };*/",
      "commented-out-code",
    ],
    [
      "regex-literal-not-a-comment",
      "// const slash = /a\\/\\/b/;",
      "commented-out-code",
    ],
    [
      "typescript-generic-arrow",
      "// const f = <T,>(x: T) => x;",
      "commented-out-code",
    ],
    ["bare-number-statement", "// 1;", "commented-out-code"],
    ["bigint-statement", "// 1n;", "commented-out-code"],
    ["boolean-statement", "// true;", "commented-out-code"],
    ["null-statement", "// null;", "commented-out-code"],
    ["lone-identifier-semicolon", "// resolveThresholds;", "inline"],
    ["lone-string-semicolon", '// "danger";', "inline"],
    ["lone-template-semicolon", "// `danger`;", "inline"],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: The comment body is TypeScript source.
    ["template-with-expression", "// `danger ${value}`;", "commented-out-code"],
    ["parenthesized-string", '// ("danger");', "commented-out-code"],
    [
      "lone-call-prose",
      "// see resolveThresholds(opts.thresholds, cleanExit)",
      "inline",
    ],
    ["comma-prose", "// a note, with a trailing comma,", "inline"],
    ["ordinary-prose", "// this is ordinary prose", "inline"],
    ["syntax-refusal", "// const = 1;", "inline"],
    ["parser-admits-break-without-checker", "// break;", "commented-out-code"],
    [
      "bare-lower-jsx-not-admitted-by-source-prefilter",
      "// <button />",
      "inline",
    ],
    ["punctuation-banner", "// ----------", "banner"],
    ["equals-banner", "// ==========", "banner"],
    ["wrapped-divider", "// ---- Types ----", "banner"],
    ["prefix-rule", "// ### section", "banner"],
    ["plus-punctuation", "// +++++", "banner"],
    ["raw-surrogate-prose", "// \ud800 lone \udfff", "inline"],
    ["raw-surrogate-code", '// const text = "\ud800";', "commented-out-code"],
    [
      "star-tab-whitespace",
      "/**\n\u00a0*\tone\t\n\u3000* two\n */",
      "docblock",
    ],
    ["star-before-slash-not-stripped", "/*\n */ literal\n*/", "block"],
  ];
  for (const [id, text, bucket] of direct) {
    assert.equal(
      classifyComment({ text, pos: 100, fileHeaderCandidate: false }),
      bucket,
      id,
    );
    for (const pos of [0, 100])
      for (const fileHeaderCandidate of [false, true])
        cases.push({
          id: `${id}.pos-${pos}.header-${fileHeaderCandidate}`,
          operation: "code_graph.comment_classify",
          input: shapeInput.parse({ text, pos, fileHeaderCandidate }),
        });
  }
  for (const space of [
    "\t",
    "\v",
    "\f",
    "\r",
    "\n",
    "\u00a0",
    "\u1680",
    "\u2000",
    "\u200a",
    "\u2028",
    "\u2029",
    "\u202f",
    "\u205f",
    "\u3000",
    "\ufeff",
    "\u0085",
    "\u180e",
    "\u200b",
    "\ud800",
  ])
    cases.push({
      id: `trim-${space.charCodeAt(0).toString(16)}`,
      operation: "code_graph.comment_classify",
      input: shapeInput.parse({ text: `// ${space}value${space}` }),
    });
  cases.push({
    id: "bucket-classes-and-canonical-order",
    operation: "code_graph.comment_buckets",
    input: {},
  });
  for (const [file, text] of [
    [
      "authored/main.ts",
      "/* Copyright 2026 */\n// @ts-ignore\n// TODO keep this marker\n// const dead = 1;\n// ---- Types ----\nimport './other';\n/**\n * Documents one call.\n */\nexport function run() {\n  /* a plain block */ return 1; // a reason\n}\n// ordinary prose\n",
    ],
    ["authored/empty.ts", ""],
    ["authored/broken.ts", "export function broken( {"],
    ["authored/pkg/package.json", "{}"],
    [
      "authored/pkg/src/other.ts",
      "/**\n * Describes this file.\n */\nexport type Config = {flag: boolean};\n",
    ],
    ["authored/pkg/src/other.spec.ts", "// @vitest-environment happy-dom\n"],
    ["authored/pkg/nested/package.json", "{}"],
    ["authored/pkg/nested/src/entry.ts", "export function own() {return 1;}\n"],
    [
      "headers/imports.ts",
      "import 'node:fs';\n/** first block after imports */\nimport 'node:path';\n/* second block */\n",
    ],
    [
      "headers/after-code.ts",
      "export const value=1;\n/** after a declaration */\n/* plain block */\n",
    ],
    [
      "headers/priority.ts",
      "// Copyright 2026\n/* @ts-ignore */\n/** second block is no header */\nexport {};\n",
    ],
    [
      "headers/non-import-equals.ts",
      "import value = require('x');\n/** after the import-equals declaration */\nexport {};\n",
    ],
    [
      "overlap/entry.ts",
      "/* first prose */ // TODO later\nexport const value = 1;",
    ],
    ["protected/only.spec.ts", "// @vitest-environment happy-dom\n"],
    [
      "syntax/entry.tsx",
      'const slash = /a\\/\\/b/;\nconst text = "// fake comment";\nexport const node = <div>{ /* real JSX prose */ }</div>;\n',
    ],
    ["syntax/returns.ts", "// return 1;\nexport function run() {return 0;}\n"],
    ["lines/cr.ts", "export const x=1;\r// comment\rexport const y=2;"],
    ["lines/crlf.ts", "// line\r\n\r\nexport {};\r\n"],
    [
      "lines/separators.ts",
      "// line\u2028export const x=1;\u2029// last\u2029",
    ],
    ["lines/blank-spaces.ts", "\t\n\u00a0\n\u1680\n\u200b\nexport {};\n"],
    [
      "bom/entry.ts",
      "\ufeff/* Copyright after project BOM removal */\nexport {};\n",
    ],
    [
      "shebang/entry.ts",
      "#!/usr/bin/env node\n/* leading prose */\nexport {};\n",
    ],
    ["unicode/é/package.json", "{}"],
    ["unicode/é/é.ts", "// prose\nexport {};\n"],
    ["unicode/z/package.json", "{}"],
    ["unicode/z/z.ts", "// prose\nexport {};\n"],
    ["ignored/node_modules/ignored.ts", "// ignored\n"],
    ["ignored/.hidden.ts", "// ignored\n"],
    ["ignored/src/kept.ts", "// kept\nexport {};\n"],
    ["all-malformed/broken.ts", "const = {"],
  ])
    write(file, text);
  fs.mkdirSync(path.join(root, "empty"));
  for (const dir of [
    "authored",
    "headers",
    "overlap",
    "protected",
    "syntax",
    "lines",
    "bom",
    "shebang",
    "unicode",
    "ignored",
    "all-malformed",
    "empty",
    "missing",
  ])
    census(`project-${dir}`, dir);
  census("package-root-scope-is-dot", "authored/pkg");
  for (const [id, relative] of [
    ["actual-comment-module", "packages/code-graph/src/comments"],
    ["actual-extraction-module", "packages/code-graph/src/extract"],
    ["actual-tea-pure-core", "packages/tea/src/pure"],
  ])
    cases.push({
      id,
      operation: "code_graph.comment_census",
      input: { root: path.join(repo, relative) },
    });
  const expected = cases.map(reference);
  const authored = censusOutput.parse(
    expected[cases.findIndex((item) => item.id === "project-authored")].output,
  );
  assert.deepEqual(authored.census.totals, {
    files: 5,
    loc: 24,
    codeLines: 5,
    blankLines: 5,
    commentLines: 14,
    mechanicalLines: 2,
    protectedLines: 4,
    proseLines: 8,
    ratio: 2.8,
  });
  assert.deepEqual(authored.census.buckets.inline, {
    lines: 1,
    count: 2,
    files: 1,
  });
  assert.equal(
    censusOutput.parse(
      expected[cases.findIndex((item) => item.id === "project-protected")]
        .output,
    ).governedRatios[0].ratio,
    0,
  );
  const invalid = [
    "not json",
    JSON.stringify({ id: "unsupported", operation: "invented", input: {} }),
    JSON.stringify({
      id: "no-text",
      operation: "code_graph.comment_classify",
      input: {},
    }),
    JSON.stringify({
      id: "bad-pos",
      operation: "code_graph.comment_classify",
      input: { text: "// value", pos: -1 },
    }),
    JSON.stringify({
      id: "unknown-shape",
      operation: "code_graph.comment_classify",
      input: { text: "// value", unknown: true },
    }),
    JSON.stringify({
      id: "no-root",
      operation: "code_graph.comment_census",
      input: {},
    }),
    JSON.stringify({
      id: "unknown-census",
      operation: "code_graph.comment_census",
      input: { root, unknown: true },
    }),
  ];
  const native = spawnSync(binary, [], {
    input: `${[...cases.map((item) => JSON.stringify(item)), ...invalid].join("\n")}\n`,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(native.status, 0, native.stderr);
  assert.equal(native.stderr, "");
  const actual = native.stdout
    .trim()
    .split("\n")
    .map((line) => responseSchema.parse(JSON.parse(line)));
  assert.equal(actual.length, cases.length + invalid.length);
  for (const [index, answer] of expected.entries()) {
    const returned = actual[index],
      item = cases[index];
    assert.equal(
      returned.ok,
      true,
      `${item.id}: ${JSON.stringify(returned.error)}`,
    );
    if (item.operation === "code_graph.comment_classify")
      shapeOutput.parse(returned.output);
    else if (item.operation === "code_graph.comment_census")
      censusOutput.parse(returned.output);
    else bucketOutput.parse(returned.output);
    assert.deepEqual(returned.output, answer.output, item.id);
    const owner =
      item.operation === "code_graph.comment_census"
        ? "census::load_comment_census"
        : item.operation === "code_graph.comment_classify"
          ? "classify::classify_comment"
          : "classify::buckets_in";
    assert.ok(
      returned.observedCalls.includes(`demlik_code_graph::comments::${owner}`),
      item.id,
    );
  }
  for (const answer of actual.slice(cases.length)) {
    assert.equal(answer.ok, false);
    assert.equal(answer.error?.kind, "driver-error");
    assert.ok(answer.error.message);
    assert.deepEqual(answer.observedCalls, []);
  }
  const censuses = expected
    .filter(
      (_, index) => cases[index].operation === "code_graph.comment_census",
    )
    .map((answer) => censusOutput.parse(answer.output).census);
  const evidence = {
    reference: {
      node: process.version,
      v8: process.versions.v8,
      parser: "OXC 0.151.0",
      profile:
        "source comment ranges, first-line claimant, TSX module then function-body parsing, exact UCS-2 classifier",
    },
    passed: cases.length,
    rejectedInvalidInputs: invalid.length,
    files: censuses.reduce((sum, census) => sum + census.totals.files, 0),
    commentLines: censuses.reduce(
      (sum, census) => sum + census.totals.commentLines,
      0,
    ),
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
