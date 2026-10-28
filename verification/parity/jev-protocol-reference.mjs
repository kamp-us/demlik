import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  decodeJevReply,
  isTransientJevAskErr,
} from "../../packages/tea/src/internal/jev/ask/index.ts";
import {
  classifyStatus,
  isJevErr,
  parseAnswers,
} from "../../packages/tea/src/internal/jev/protocol/index.ts";

assert.equal(process.version, "v22.21.1");
assert.equal(process.versions.v8, "12.4.254.21-node.33");
export const root = fileURLToPath(new URL("../..", import.meta.url));
export const cases = JSON.parse(
  fs.readFileSync(
    new URL("./jev-protocol-cases.json.fixture", import.meta.url),
    "utf8",
  ),
);
const clone = structuredClone;
function questions() {
  return {
    category: {
      type: "choice",
      instructions: "Which invoice budget?",
      criteria: { groceries: "Food", dining: "Restaurants" },
    },
    frustration: {
      type: "score",
      instructions: "Frustration?",
      criteria: ["Calm", "Frustrated", "Angry"],
    },
    is_urgent: { type: "noul", instructions: "Urgent?" },
  };
}
function body() {
  return {
    model: "jev-1.13.0",
    answers: {
      category: {
        type: "choice",
        choice: "groceries",
        probabilities: { groceries: 0.88, dining: 0.12 },
        confidence: 0.81,
      },
      frustration: {
        type: "score",
        score: 1.05,
        legend: { 0: "Calm", 1: "Frustrated", 2: "Angry" },
        probabilities: { 0: 0, 1: 0.95, 2: 0.05 },
        confidence: 0.92,
      },
      is_urgent: { type: "noul", noul: 0.95 },
    },
    usage: { input_tokens: 318, output_tokens: 34 },
  };
}
export function fixture(item) {
  const q = questions(),
    b = body();
  const x = { id: item.id, op: "reply", questions: q, body: b, status: 200 };
  switch (item.scenario) {
    case "invoice-200":
      break;
    case "http-429":
      x.status = 429;
      x.body = { broken: true };
      break;
    case "http-401":
      x.status = 401;
      x.body = { broken: true };
      break;
    case "http-529":
      x.status = 529;
      x.body = null;
      break;
    case "status-number-family":
      x.op = "statuses";
      x.statuses = [
        199.5,
        200.25,
        299.9,
        300,
        429.25,
        529,
        0,
        -0,
        NaN,
        Infinity,
        -Infinity,
      ];
      break;
    case "choice-first-fault":
      b.answers.category.choice = "rent";
      b.answers.category.confidence = "high";
      b.answers.category.probabilities = "bad";
      break;
    case "probability-bad-value":
      b.answers.category.probabilities = { groceries: "bad", alien: 1 };
      break;
    case "probability-missing-extra":
      b.answers.category.probabilities = { dining: 0.9, alien: 0.1 };
      break;
    case "probability-key-order":
      b.answers.category.probabilities = { dining: 7, groceries: -2 };
      break;
    case "score-confidence-first":
      b.answers.frustration.confidence = null;
      b.answers.frustration.score = "bad";
      break;
    case "score-legend-first":
      b.answers.frustration.legend = { 0: 3 };
      b.answers.frustration.probabilities = "bad";
      break;
    case "noul-nonfinite":
      b.answers.is_urgent.noul = Infinity;
      break;
    case "finite-unbounded-signed-zero":
      b.usage = { input_tokens: -2.25, output_tokens: -0 };
      b.answers.category.confidence = -0;
      b.answers.category.probabilities = { groceries: 2, dining: -1 };
      b.answers.frustration.score = -0;
      b.answers.frustration.confidence = 3;
      b.answers.is_urgent.noul = -4;
      break;
    case "missing-answer":
      delete b.answers.category;
      break;
    case "type-mismatch":
      b.answers.category.type = "score";
      break;
    case "envelope-first-fault":
      b.model = 3;
      b.usage = null;
      b.answers = null;
      break;
    case "non-object-bodies":
      x.op = "bodies";
      x.bodies = [
        null,
        undefined,
        [],
        false,
        0,
        "text",
        { model: "ok", usage: null, answers: {} },
      ];
      break;
    case "integer-key-order":
      x.questions = {
        10: {
          type: "choice",
          instructions: "?",
          criteria: { 10: null, 2: null },
        },
        2: { type: "noul", instructions: "?" },
        z: { type: "noul", instructions: "?" },
      };
      x.body = {
        model: "m",
        usage: { input_tokens: 1, output_tokens: 2 },
        answers: {
          10: {
            type: "choice",
            choice: "10",
            confidence: 1,
            probabilities: { 10: 1, extra: 0 },
          },
          z: { type: "noul", noul: 0 },
        },
      };
      break;
    case "own-tag-and-extra":
      x.questions = { _tag: { type: "noul", instructions: "?" } };
      x.body = {
        model: "m",
        usage: { input_tokens: 0, output_tokens: 0, ignored: "drop" },
        answers: {
          _tag: { type: "noul", noul: 1, ignored: true },
          extra: { type: "score" },
        },
        ignored: "drop",
      };
      break;
    case "utf16":
      x.questions = {
        "q\ud800": {
          type: "choice",
          instructions: "?",
          criteria: { "c\udc00": null, "😀": "astral" },
        },
      };
      x.body = {
        model: "m\udfff",
        usage: { input_tokens: 1, output_tokens: 2 },
        answers: {
          "q\ud800": {
            type: "choice",
            choice: "c\udc00",
            confidence: 1,
            probabilities: { "c\udc00": 0.75, "😀": 0.25 },
          },
        },
      };
      break;
    case "fresh-output":
      x.op = "fresh";
      break;
    case "score-loose-maps":
      b.answers.frustration.legend = { other: "not a rubric key" };
      b.answers.frustration.probabilities = {};
      break;
    case "tag-guards":
      x.op = "guards";
      break;
    case "empty-questions":
      x.questions = {};
      break;
    default:
      throw new Error(item.scenario);
  }
  return x;
}
export function encode(value) {
  if (
    typeof value === "number" &&
    (!Number.isFinite(value) || Object.is(value, -0))
  )
    return { $fixtureNumber: Object.is(value, -0) ? "-0" : String(value) };
  if (value === undefined) return { $fixtureUndefined: true };
  if (Array.isArray(value)) return value.map(encode);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, encode(v)]),
    );
  return value;
}
export function specialNumbers(value, prefix = "", out = []) {
  if (
    typeof value === "number" &&
    (!Number.isFinite(value) || Object.is(value, -0))
  )
    out.push([prefix, Object.is(value, -0) ? "-0" : String(value)]);
  else if (Array.isArray(value))
    value.forEach((v, i) => {
      specialNumbers(v, `${prefix}/${i}`, out);
    });
  else if (value !== null && typeof value === "object")
    for (const [k, v] of Object.entries(value))
      specialNumbers(v, `${prefix}/${k}`, out);
  return out;
}
function reply(x, status, body) {
  const request = {
    state: "invoice-17",
    model: "requested-model",
    questions: x.questions,
  };
  const parsed = parseAnswers(x.questions, body),
    outcome = decodeJevReply(request, { status, body });
  return {
    parsed,
    outcome,
    wire: JSON.stringify(outcome),
    numeric: specialNumbers({ parsed, outcome }),
  };
}
export function view(x) {
  if (x.op === "statuses")
    return {
      entries: x.statuses.map((status) => ({
        kind: classifyStatus(status),
        ...reply(x, status, x.body),
      })),
    };
  if (x.op === "bodies")
    return { entries: x.bodies.map((body) => reply(x, x.status, body)) };
  if (x.op === "guards") {
    const tags = [
      "malformed_body",
      "missing_answer",
      "answer_type_mismatch",
      "off_criteria_choice",
      "off_criteria_probabilities",
      "malformed_answer",
      "http_retry",
      "port_threw",
      "unknown",
    ];
    const errors = [
      { _tag: "http_retry", status: 429 },
      { _tag: "port_threw", reason: "socket" },
      { _tag: "http_terminal", status: 401 },
      { _tag: "no_answer_path" },
      { _tag: "malformed_body", reason: "body" },
    ];
    return {
      guards: tags.map((_tag) => isJevErr({ _tag })),
      transient: errors.map(isTransientJevAskErr),
      answerGuard: isJevErr({ _tag: { type: "noul", noul: 1 } }),
    };
  }
  if (x.op === "fresh") {
    const parsed = parseAnswers(x.questions, x.body);
    assert.equal(parsed.ok, true);
    const before = clone(parsed);
    x.body.answers.category.choice = "dining";
    x.body.answers.category.probabilities.groceries = 0;
    x.body.usage.input_tokens = 999;
    x.body.answers.extra = { type: "noul", noul: 0 };
    return { before, afterInputMutation: parsed, inputAfter: x.body };
  }
  return reply(x, x.status, x.body);
}
export function anchors(rows) {
  assert.deepEqual(parseAnswers(questions(), undefined), {
    ok: false,
    error: { _tag: "malformed_body", reason: "body is not an object" },
  });
  const m = Object.fromEntries(rows.map((r) => [r.scenario, r.view]));
  assert.equal(m["invoice-200"].parsed.answers.category.choice, "groceries");
  assert.equal(m["invoice-200"].parsed.answers.frustration.score, 1.05);
  assert.equal(m["invoice-200"].parsed.answers.is_urgent.noul, 0.95);
  assert.equal(m["http-429"].outcome.error.jev._tag, "http_retry");
  assert.equal(m["http-401"].outcome.error.jev._tag, "http_terminal");
  assert.equal(
    m["choice-first-fault"].parsed.error._tag,
    "off_criteria_choice",
  );
  assert.equal(
    m["probability-bad-value"].parsed.error.reason,
    "`probabilities` is not a map of numbers",
  );
  assert.deepEqual(m["probability-missing-extra"].parsed.error.missing, [
    "groceries",
  ]);
  assert.deepEqual(m["probability-missing-extra"].parsed.error.extra, [
    "alien",
  ]);
  assert.equal(
    m["score-confidence-first"].parsed.error.reason,
    "`confidence` is not a number",
  );
  assert.equal(m["integer-key-order"].parsed.error.id, "2");
  assert.equal(m["own-tag-and-extra"].parsed.answers.extra, undefined);
  assert.equal(m.utf16.parsed.model, "m\udfff");
  assert.deepEqual(
    m["fresh-output"].before,
    m["fresh-output"].afterInputMutation,
  );
  assert.deepEqual(m["empty-questions"].parsed.answers, {});
  assert.equal(m["non-object-bodies"].entries[1].parsed.ok, false);
  assert.equal(
    m["non-object-bodies"].entries[1].parsed.error.reason,
    "body is not an object",
  );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const [output] = process.argv.slice(2);
  assert.ok(output);
  const rows = cases.map((item) => {
    const input = fixture(item);
    return { ...item, input: encode(input), view: view(input) };
  });
  anchors(rows);
  const sourceFiles = [
    "packages/tea/src/internal/jev/protocol/index.ts",
    "packages/tea/src/internal/jev/ask/index.ts",
  ];
  const hashes = Object.fromEntries(
    sourceFiles.map((f) => [
      f,
      createHash("sha256")
        .update(fs.readFileSync(path.join(root, f)))
        .digest("hex"),
    ]),
  );
  fs.writeFileSync(
    output,
    `${JSON.stringify(
      {
        reference: "75de37ea01a81cd7949e6275b7ee9cfdeb4e312d",
        node: process.version,
        v8: process.versions.v8,
        sourceHashes: hashes,
        cases: 24,
        rows,
      },
      null,
      2,
    )}\n`,
  );
}
