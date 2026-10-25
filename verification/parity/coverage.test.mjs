import assert from "node:assert/strict";
import test from "node:test";
import { evidenceGaps, resolveContract } from "./coverage.mjs";

const signature = "a".repeat(64);
const canonical = `@demlik/tea:.#BootingRuntime/member:published:${signature}`;
const id = `@demlik/tea:./persistence#recorder/member:src/runtime-types.d.ts#BootingRuntime:${signature}`;
function fixture() {
  const source = {
    id,
    signature,
    declaration: "dispatch(msg: M): Promise<void>;",
  };
  const owner = { ...source, id: canonical };
  const mapping = {
    signature,
    rust: {
      file: "crates/tea/src/runtime/engine.rs",
      symbols: ["Runtime::dispatch"],
    },
    cases: ["runtime.promise.serial"],
  };
  return {
    source,
    owner,
    mapping,
    capabilities: new Map([
      [id, source],
      [canonical, owner],
    ]),
    mappings: {
      [id]: { signature, inheritedFrom: canonical },
      [canonical]: mapping,
    },
  };
}
test("a referenced member uses its canonical evidence without duplicating it", () => {
  const f = fixture();
  const result = resolveContract(f.source, f.mappings, f.capabilities);
  assert.deepEqual(result.gaps, []);
  assert.equal(result.mapping, f.mapping);
  assert.deepEqual(evidenceGaps(result.mapping, new Map()), [
    "No passing compiled consumer called Runtime::dispatch",
    "Case runtime.promise.serial did not call this capability",
  ]);
  assert.deepEqual(
    evidenceGaps(
      result.mapping,
      new Map([["runtime.promise.serial", new Set(["Runtime::dispatch"])]]),
    ),
    [],
  );
});
test("a matching signature cannot borrow evidence from a different source owner", () => {
  const f = fixture();
  f.mappings[id].inheritedFrom = canonical.replace(
    "BootingRuntime",
    "Unrelated",
  );
  assert.equal(
    resolveContract(f.source, f.mappings, f.capabilities).mapping,
    undefined,
  );
});
test("a stale declaration or source signature refuses the canonical reference", () => {
  for (const field of ["declaration", "signature"]) {
    const f = fixture();
    f.owner[field] = "changed";
    assert.equal(
      resolveContract(f.source, f.mappings, f.capabilities).mapping,
      undefined,
    );
  }
  const f = fixture();
  f.mappings[id].signature = "changed";
  assert.equal(
    resolveContract(f.source, f.mappings, f.capabilities).mapping,
    undefined,
  );
});
test("missing owners and reference chains cannot manufacture native evidence", () => {
  const missing = fixture();
  delete missing.mappings[canonical];
  assert.equal(
    resolveContract(missing.source, missing.mappings, missing.capabilities)
      .mapping,
    undefined,
  );
  const chain = fixture();
  chain.mappings[canonical] = { signature, inheritedFrom: canonical };
  assert.equal(
    resolveContract(chain.source, chain.mappings, chain.capabilities).mapping,
    undefined,
  );
});
test("canonical references retain known qualifications and their original cases", () => {
  const f = fixture();
  f.mapping.knownGaps = ["Caller continuation order remains unverified"];
  const resolved = resolveContract(f.source, f.mappings, f.capabilities);
  assert.equal(resolved.mapping, f.mapping);
  assert.match(
    evidenceGaps(resolved.mapping, new Map())[0],
    /^Known parity gap:/,
  );
});

test("member references retain both owner and local measured gaps", () => {
  const f = fixture();
  f.mapping.knownGaps = ["Owner scheduling remains unresolved"];
  f.mappings[id].knownGaps = ["Recorder cancellation remains unresolved"];
  const resolved = resolveContract(f.source, f.mappings, f.capabilities);
  assert.deepEqual(
    evidenceGaps(
      resolved.mapping,
      new Map([["runtime.promise.serial", new Set(["Runtime::dispatch"])]]),
    ),
    [
      "Known parity gap: Owner scheduling remains unresolved",
      "Known parity gap: Recorder cancellation remains unresolved",
    ],
  );
});

test("an owned proof keeps its existing canonical annotation", () => {
  const f = fixture();
  f.mapping.canonical = "FetchPageCmd";
  assert.equal(
    resolveContract(f.owner, f.mappings, f.capabilities).mapping,
    f.mapping,
  );
});

test("an owner's annotation does not turn its compiled proof into a reference", () => {
  const f = fixture();
  f.mapping.canonical = "BootingRuntime";
  assert.deepEqual(
    resolveContract(f.source, f.mappings, f.capabilities).gaps,
    [],
  );
});

test("capability evidence must call the compiled public path, not merely pass a named case", () => {
  const mapping = {
    rust: { symbols: ["demlik_tea::core::fold_msgs"] },
    cases: ["fold"],
  };
  assert.deepEqual(
    evidenceGaps(
      mapping,
      new Map([["fold", new Set(["demlik_tea::core::fold_msgs"])]]),
    ),
    [],
  );
  assert.notEqual(
    evidenceGaps(mapping, new Map([["fold", new Set(["demlik_tea::replay"])]]))
      .length,
    0,
  );
  assert.notEqual(
    evidenceGaps(
      { ...mapping, rust: { symbols: ["demlik_tea::does_not_exist"] } },
      new Map([["fold", new Set(["demlik_tea::core::fold_msgs"])]]),
    ).length,
    0,
  );
  assert.notEqual(evidenceGaps(mapping, new Map()).length, 0);
});

test("passing calls cannot erase a measured unresolved parity gap", () => {
  const mapping = {
    rust: { symbols: ["demlik_tea::work_queue::QueueClient::enqueue"] },
    cases: ["sequential"],
    knownGaps: ["Concurrent store ordering remains unresolved"],
  };
  const evidence = new Map([["sequential", new Set(mapping.rust.symbols)]]);
  assert.deepEqual(evidenceGaps(mapping, evidence), [
    "Known parity gap: Concurrent store ordering remains unresolved",
  ]);
});
