import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  CommentCeilingsSchema,
  ceilingPoints,
  ceilingsFromCensus,
  toPoints,
} from "../../packages/code-graph/src/comments/ceilings.js";
import {
  governedRatio,
  loadCommentCensus,
} from "../../packages/code-graph/src/comments/census.js";
import { classifyComment } from "../../packages/code-graph/src/comments/classify.js";
import { runCommentGate } from "../../packages/code-graph/src/comments/gate.js";
import {
  evaluateRatchet,
  renderRatchet,
} from "../../packages/code-graph/src/comments/ratchet.js";
import { stableStringify } from "../../packages/code-graph/src/render/json.js";
import {
  createCheckWorktree,
  checkedExecFileSync as execFileSync,
  checkedSpawnSync as spawnSync,
} from "./check-worktree.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const { positionals, values } = parseArgs({
  options: {
    "policy-driver": { type: "string" },
    "gate-driver": { type: "string" },
  },
  allowPositionals: true,
});
assert.ok(positionals.length <= 2, "unexpected positional arguments");
const baseline = positionals[0];
assert.ok(
  baseline,
  "usage: node --import tsx comment-mutations.mjs <baseline-native-driver> [evidence.json] [--policy-driver <native-policy-driver>] [--gate-driver <native-gate-driver>]",
);
assert.equal(process.version, "v22.21.1");
const mutationCheck = createCheckWorktree(process.cwd(), "comment-mutations");
let mutationFailure;
try {
  const directory = mutationCheck.root;
  const cargo = process.env.CARGO ?? "cargo";
  const targetDirectory = mutationCheck.target;
  const censusCase = (id, directory) => ({
    id,
    operation: "code_graph.comment_census",
    input: { root: directory },
  });
  function call(binary, item) {
    const result = spawnSync(binary, [], {
      input: `${JSON.stringify(item)}\n`,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    const lines = result.stdout.trim().split("\n");
    assert.equal(lines.length, 1);
    const answer = JSON.parse(lines[0]);
    assert.equal(answer.id, item.id);
    assert.equal(answer.ok, true, JSON.stringify(answer.error));
    const owner = {
      "code_graph.comment_census":
        "demlik_code_graph::comments::census::load_comment_census",
      "code_graph.comment_policy":
        "demlik_code_graph::comments::ratchet::evaluate_ratchet",
      "code_graph.comment_points":
        "demlik_code_graph::comments::ceilings::to_points",
      "code_graph.comment_classify":
        "demlik_code_graph::comments::classify::classify_comment",
      "code_graph.comment_gate":
        "demlik_code_graph::comments::gate::run_comment_gate",
      "code_graph.comment_verdict_render":
        "demlik_code_graph::comments::ratchet::render_ratchet",
      "code_graph.stable_json":
        "demlik_code_graph::render::json::stable_stringify",
    }[item.operation];
    assert.ok(owner, item.operation);
    assert.ok(answer.observedCalls.includes(owner));
    return answer;
  }
  const results = [];
  try {
    for (const folder of ["overlap", "protected"])
      await mkdir(path.join(directory, folder));
    await writeFile(
      path.join(directory, "overlap/entry.ts"),
      "/* first prose */ // TODO later\nexport const value = 1;",
    );
    await writeFile(
      path.join(directory, "protected/only.spec.ts"),
      "// @vitest-environment happy-dom\n",
    );
    const overlap = censusCase(
      "first-comment-owns-a-shared-line",
      path.join(directory, "overlap"),
    );
    const protectedCase = censusCase(
      "protected-class-stays-out-of-governed-ratio",
      path.join(directory, "protected"),
    );
    const returns = {
      id: "return-body-uses-function-wrapper",
      operation: "code_graph.comment_classify",
      input: { text: "// return null;", pos: 100, fileHeaderCandidate: false },
    };
    const overlapCensus = loadCommentCensus(overlap.input.root);
    const protectedCensus = loadCommentCensus(protectedCase.input.root);
    const originalOverlap = call(baseline, overlap);
    const originalProtected = call(baseline, protectedCase);
    const originalReturn = call(baseline, returns);
    assert.deepEqual(originalOverlap.output.census, overlapCensus);
    assert.deepEqual(originalProtected.output.census, protectedCensus);
    assert.equal(originalReturn.output.bucket, classifyComment(returns.input));
    assert.equal(originalReturn.output.bucket, "commented-out-code");
    assert.equal(originalOverlap.output.census.buckets.marker.lines, 0);
    assert.equal(governedRatio(protectedCensus.scopes[0]), 0);
    assert.equal(originalProtected.output.governedRatios[0].ratio, 0);

    const mutations = [
      {
        name: "comment-line-claimed-by-every-comment",
        file: "crates/code-graph/src/comments/census.rs",
        before: "if claimed.insert(line) {",
        after: "if { claimed.insert(line); true } {",
        item: overlap,
        original: originalOverlap,
        verify: (answer) =>
          assert.equal(answer.output.census.buckets.marker.lines, 1),
      },
      {
        name: "comment-return-wrapper-omitted",
        file: "crates/code-graph/src/comments/classify.rs",
        before:
          'let wrapped = format!("function snippet() {{\\n{}\\n}}", body.to_lossy());',
        after: "let wrapped = String::new();",
        item: returns,
        original: originalReturn,
        verify: (answer) => assert.equal(answer.output.bucket, "inline"),
      },
      {
        name: "comment-protected-class-charged-as-prose",
        file: "crates/code-graph/src/comments/classify.rs",
        before:
          "Self::Pragma | Self::License | Self::Marker => CommentClass::Protected,",
        after:
          "Self::Pragma | Self::License | Self::Marker => CommentClass::Prose,",
        item: protectedCase,
        original: originalProtected,
        verify: (answer) =>
          assert.equal(answer.output.governedRatios[0].ratio, 1),
      },
    ];
    if (values["policy-driver"]) {
      const policyDriver = values["policy-driver"];
      for (const [folder, scope, text] of [
        ["policy-recorded", "a", "// prose\nexport const value=1;"],
        ["policy-inherited", "a", "export const value=1;"],
        ["policy-prototype", "toString", "// prose\nexport const value=1;"],
      ]) {
        const location = path.join(directory, folder, scope);
        await mkdir(location, { recursive: true });
        await writeFile(path.join(location, "package.json"), "{}");
        await writeFile(path.join(location, "entry.ts"), text);
      }
      const makePolicy = (id, folder, ceilings) => ({
        id,
        operation: "code_graph.comment_policy",
        input: { root: path.join(directory, folder), ceilings },
      });
      const recordedCase = makePolicy(
        "recorded-ceiling-controls-scope",
        "policy-recorded",
        { scopes: { a: 100 } },
      );
      const inheritedCase = makePolicy(
        "unrecorded-scope-never-slacks",
        "policy-inherited",
        {},
      );
      const prototypeCase = makePolicy(
        "inherited-object-property-is-not-a-default-ceiling",
        "policy-prototype",
        {},
      );
      const policyReference = (item) => {
        const census = loadCommentCensus(item.input.root),
          ceilings = CommentCeilingsSchema.parse(item.input.ceilings),
          recorded = ceilingsFromCensus(census, ceilings);
        return {
          census,
          ceilings,
          recorded,
          verdict: evaluateRatchet(census, ceilings),
          recordedVerdict: evaluateRatchet(census, recorded),
        };
      };
      const originalRecorded = call(policyDriver, recordedCase),
        originalInherited = call(policyDriver, inheritedCase),
        originalPrototype = call(policyDriver, prototypeCase);
      for (const [item, answer] of [
        [recordedCase, originalRecorded],
        [inheritedCase, originalInherited],
        [prototypeCase, originalPrototype],
      ]) {
        assert.deepEqual(answer.output, policyReference(item));
        assert.equal(answer.output.verdict.passed, true);
      }
      assert.equal(originalInherited.output.verdict.inheritedScopes, 1);
      assert.equal(originalPrototype.output.verdict.inheritedScopes, 0);
      const zeroCase = {
        id: "negative-zero-survives-numeric-helper-observation",
        operation: "code_graph.comment_points",
        input: { ratio: -0.00015 },
      };
      const originalZero = call(policyDriver, zeroCase);
      const number = (value) => ({
        value,
        kind: "finite",
        negativeZero: Object.is(value, -0),
      });
      assert.deepEqual(
        originalZero.output,
        JSON.parse(
          JSON.stringify({
            points: number(toPoints(zeroCase.input.ratio)),
            ceilingPoints: number(ceilingPoints(zeroCase.input.ratio)),
          }),
        ),
      );
      assert.equal(originalZero.output.points.negativeZero, true);
      mutations.push(
        {
          name: "comment-recorded-ceiling-ignored",
          file: "crates/code-graph/src/comments/ratchet.rs",
          before:
            "let ceiling = recorded.copied().unwrap_or(ceilings.default);",
          after: "let ceiling = ceilings.default;",
          item: recordedCase,
          original: originalRecorded,
          example: "comment_policy_driver",
          verify: (answer) => assert.equal(answer.output.verdict.passed, false),
        },
        {
          name: "comment-inherited-scope-slacks",
          file: "crates/code-graph/src/comments/ratchet.rs",
          before: "else if !inherited && -delta > ceilings.slack_points {",
          after: "else if -delta > ceilings.slack_points {",
          item: inheritedCase,
          original: originalInherited,
          example: "comment_policy_driver",
          verify: (answer) =>
            assert.equal(
              answer.output.verdict.violations[0].direction,
              "SLACK",
            ),
        },
        {
          name: "comment-prototype-scope-inherits-default",
          file: "crates/code-graph/src/comments/ratchet.rs",
          before:
            "if recorded.is_none() && has_object_prototype_property(&scope) {",
          after:
            "if recorded.is_none() && false && has_object_prototype_property(&scope) {",
          item: prototypeCase,
          original: originalPrototype,
          example: "comment_policy_driver",
          verify: (answer) =>
            assert.equal(answer.output.verdict.inheritedScopes, 1),
        },
        {
          name: "comment-negative-zero-erased",
          file: "crates/code-graph/src/comments/ceilings.rs",
          before: "0.0f64.copysign(value)",
          after: "0.0",
          item: zeroCase,
          original: originalZero,
          example: "comment_policy_driver",
          verify: (answer) =>
            assert.equal(answer.output.points.negativeZero, false),
        },
      );
    }
    if (values["gate-driver"]) {
      const gateDriver = values["gate-driver"],
        project = path.join(directory, "gate-project"),
        missingRepo = path.join(directory, "gate-missing"),
        writeRepo = path.join(directory, "gate-write");
      await mkdir(path.join(project, "a"), { recursive: true });
      await mkdir(missingRepo);
      await mkdir(writeRepo);
      await writeFile(path.join(project, "a/package.json"), "{}");
      await writeFile(
        path.join(project, "a/entry.ts"),
        "// prose\nexport const value=1;",
      );
      const missingCase = {
        id: "ci-missing-ceilings-is-config-refusal",
        operation: "code_graph.comment_gate",
        input: {
          rootAbsolute: project,
          repoRoot: missingRepo,
          ci: true,
          writeCeilings: false,
          json: false,
          pretty: false,
        },
      };
      const writeCase = {
        id: "write-ceilings-takes-precedence-over-ci",
        operation: "code_graph.comment_gate",
        input: {
          rootAbsolute: project,
          repoRoot: writeRepo,
          ci: true,
          writeCeilings: true,
          json: false,
          pretty: false,
        },
      };
      const file = path.join(writeRepo, "comment-ceilings.json"),
        resetWrite = () => writeFile(file, "{}");
      const reference = (item) => {
        const emitted = [],
          reports = [];
        return {
          exitCode: runCommentGate({
            ...item.input,
            emit: (payload) => emitted.push(payload),
            report: (message) => reports.push(message),
          }),
          emitted,
          reports,
        };
      };
      const originalMissing = call(gateDriver, missingCase);
      assert.deepEqual(originalMissing.output, reference(missingCase));
      assert.equal(originalMissing.output.exitCode, 2);
      await resetWrite();
      const writeExpected = reference(writeCase),
        written = await readFile(file, "utf8");
      await resetWrite();
      const originalWrite = call(gateDriver, writeCase);
      assert.deepEqual(originalWrite.output, writeExpected);
      assert.equal(await readFile(file, "utf8"), written);
      assert.equal(originalWrite.output.exitCode, 0);
      const jsonCase = {
        id: "nested-pretty-json-keeps-lossless-keys",
        operation: "code_graph.stable_json",
        input: {
          value: JSON.parse(
            '{"__proto__":{"hidden":1},"z":[{"\\ud800":{"b":1,"a":2}}]}',
          ),
          pretty: true,
        },
      };
      const originalJson = call(gateDriver, jsonCase);
      assert.equal(
        originalJson.output,
        stableStringify(jsonCase.input.value, true),
      );
      assert.ok(originalJson.output.includes("\n"));
      assert.ok(!originalJson.output.includes('"__proto__"'));
      const verdict = {
        passed: false,
        scopesChecked: 1,
        inheritedScopes: 1,
        defaultCeiling: 40,
        slackPoints: 2,
        violations: [
          {
            scope: "raw\ud800😀",
            measured: 100,
            ceiling: 40,
            direction: "EXCEEDED",
            delta: 60,
            inherited: true,
          },
        ],
      };
      const rawCase = {
          id: "raw-verdict-scope-survives-human-render",
          operation: "code_graph.comment_verdict_render",
          input: { verdict, json: false, pretty: false },
        },
        originalRaw = call(gateDriver, rawCase);
      assert.deepEqual(
        originalRaw.output,
        renderRatchet(verdict, false, false),
      );
      assert.ok(originalRaw.output.stdout.includes("\ud800"));
      mutations.push(
        {
          name: "comment-ci-missing-file-inherits-defaults",
          file: "crates/code-graph/src/comments/gate.rs",
          before: "file.exists() || args.ci",
          after: "file.exists()",
          item: missingCase,
          original: originalMissing,
          example: "comment_gate_driver",
          verify: (answer) => assert.equal(answer.output.exitCode, 1),
        },
        {
          name: "comment-ci-skips-requested-recording",
          file: "crates/code-graph/src/comments/gate.rs",
          before: "if args.write_ceilings {",
          after: "if args.write_ceilings && !args.ci {",
          item: writeCase,
          original: originalWrite,
          example: "comment_gate_driver",
          setup: resetWrite,
          verify: async (answer) => {
            assert.equal(answer.output.exitCode, 1);
            assert.equal(await readFile(file, "utf8"), "{}");
          },
        },
        {
          name: "comment-pretty-json-emits-compact-container",
          file: "crates/code-graph/src/render/json.rs",
          before:
            "pretty_value(&normalized, &mut PrettyFormatter::new(), &mut out)?;",
          after:
            "pretty_value(&normalized, &mut PrettyFormatter::new(), &mut out)?; out.clear(); out.extend_from_slice(&serde_json::to_vec(&normalized)?);",
          item: jsonCase,
          original: originalJson,
          example: "comment_gate_driver",
          verify: (answer) => assert.ok(!answer.output.includes("\n")),
        },
        {
          name: "comment-json-retains-prototype-assignment-key",
          file: "crates/code-graph/src/render/json.rs",
          before: '.filter(|(key, _)| key != "__proto__")',
          after: ".filter(|_| true)",
          item: jsonCase,
          original: originalJson,
          example: "comment_gate_driver",
          verify: (answer) => assert.ok(answer.output.includes('"__proto__"')),
        },
        {
          name: "comment-human-render-loses-raw-scope",
          file: "crates/code-graph/src/render/text.rs",
          before: "let mut out = value.clone();",
          after: "let mut out = JsString::from(value.to_lossy());",
          item: rawCase,
          original: originalRaw,
          example: "comment_gate_driver",
          verify: (answer) =>
            assert.ok(!answer.output.stdout.includes("\ud800")),
        },
      );
    }
    for (const mutation of mutations) {
      const example = mutation.example ?? "comment_driver";
      const file = path.join(directory, mutation.file),
        original = await readFile(file, "utf8");
      assert.equal(
        original.split(mutation.before).length,
        2,
        `${mutation.name} must alter exactly one site`,
      );
      await writeFile(file, original.replace(mutation.before, mutation.after));
      process.stderr.write(
        `building disposable native fault: ${mutation.name}\n`,
      );
      execFileSync(
        cargo,
        [
          "build",
          "--locked",
          "--offline",
          "--package",
          "demlik-code-graph",
          "--example",
          example,
        ],
        {
          cwd: directory,
          env: { ...process.env },
          stdio: "pipe",
          maxBuffer: 16 * 1024 * 1024,
        },
      );
      await mutation.setup?.();
      const answer = call(
        path.join(targetDirectory, "debug/examples", example),
        mutation.item,
      );
      assert.notDeepEqual(
        answer.output,
        mutation.original.output,
        mutation.name,
      );
      await mutation.verify(answer);
      results.push({
        name: mutation.name,
        detected: true,
        witness: mutation.item.id,
        baseline: mutation.original,
        mutated: answer,
      });
      await writeFile(file, original);
    }
    const evidence = {
      reference: {
        node: process.version,
        v8: process.versions.v8,
        parser: "OXC 0.151.0",
      },
      passed: results.length,
      controls: results,
    };
    if (positionals[1])
      await writeFile(positionals[1], `${JSON.stringify(evidence, null, 2)}\n`);
    process.stdout.write(
      `${JSON.stringify({ ...evidence, controls: results.map(({ name, detected, witness }) => ({ name, detected, witness })) }, null, 2)}\n`,
    );
  } finally {
  }
} catch (error) {
  mutationFailure = error;
  throw error;
} finally {
  mutationCheck.remove(mutationFailure);
}
