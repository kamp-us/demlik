const nominal = [
  [false, false, 2, [4, 2, 0, 0]],
  [false, true, 2, [4, 2, 1, 0]],
  [true, false, 2.5, [4, 2, 0, 1]],
  [true, true, 0, [4, 2, 1, 2]],
];
export const agentSnapshotGridCases = [
  ...["promise", "effect"].flatMap((profile) => [
    ...nominal.map(([snapshot, compaction, every, counts]) => ({
      id: `agent-snapshot.${profile}.nominal.${snapshot ? "on" : "off"}-${compaction ? "on" : "off"}`,
      input: {
        mode: "runtime",
        profile,
        snapshot,
        compaction,
        every,
        scenario: "normal",
        anchors: snapshot && !compaction,
      },
      expected: { counts, phase: "done", failure: null },
    })),
    {
      id: `agent-snapshot.${profile}.held`,
      input: {
        mode: "runtime",
        profile,
        snapshot: true,
        compaction: true,
        every: "Infinity",
        scenario: "held",
      },
      expected: {
        counts: [4, 2, 1, 1],
        phase: "done",
        failure: null,
        held: true,
      },
    },
    {
      id: `agent-snapshot.${profile}.writer-fail`,
      input: {
        mode: "runtime",
        profile,
        snapshot: true,
        compaction: true,
        every: 1,
        scenario: "writer-fail",
      },
      expected: {
        counts: [3, 2, 1, 1],
        phase: "running",
        failure: null,
        reports: 1,
      },
    },
    {
      id: `agent-snapshot.${profile}.save-fail`,
      input: {
        mode: "runtime",
        profile,
        snapshot: true,
        compaction: true,
        every: 1,
        scenario: "save-fail",
      },
      expected: {
        counts: [3, 2, 1, 0],
        phase: "running",
        failure: null,
        reports: 1,
      },
    },
    ...[false, true].map((compaction) => ({
      id: `agent-snapshot.${profile}.cold.${compaction ? "on" : "off"}`,
      cold: true,
      input: {
        profile,
        snapshot: true,
        compaction,
        every: 1,
        scenario: "normal",
      },
      expected: { writer: [3, 2, compaction ? 1 : 0, 1], reader: [1, 0, 0, 1] },
    })),
  ]),
];
export const snapshotAnchorExpectations = {
  zero: { seq: 6, writes: [5, 6] },
  fractional: { seq: 2, writes: [2] },
  nan: { seq: 6, writes: [5, 6] },
  infinity: { seq: 1, writes: [1] },
};
export const snapshotAuthoringGate = [
  {
    contract: "four exact handler obligations",
    regression: "dummy snapshot handler or widened OFF signature",
    existingGap: "prior grid had no snapshot arm",
    seam: "public inferred configuration/wiring",
  },
  {
    contract: "discard progress writes but forward stage writes first",
    regression: "missing or reordered named IO",
    existingGap: "leaf cadence tests bypass Agent",
    seam: "actual Agent verbs and runtime handlers",
  },
  {
    contract: "plain writer failure retains its original cause",
    regression: "defined-command swallowing or automatic ack",
    existingGap: "standalone Snapshot intentionally registers its definition",
    seam: "actual dispatch/commit/Store",
  },
  {
    contract: "named checkpoint cold ready is commandless then Boot resumes",
    regression: "no real bytes or eager init",
    existingGap: "previous cold files were runtime Store only",
    seam: "real writer, FileStore and fresh processes",
  },
];
