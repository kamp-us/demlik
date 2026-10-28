export const snapshotMessagesQualification =
  "Runtime-only Source profile: the published snapshot InterpretCell refuses Msg/list returns (TS2322). A checked Reflect replacement on the real typed IO-only handler exercises the actual unregistered plain edge. Native message-return methods are additive; no strict typed-parity credit.";

export const snapshotMessagesOpenId =
  "agent-snapshot-messages.effect.held-stop";

export const agentSnapshotMessagesCases = ["promise", "effect"].flatMap(
  (profile) =>
    [
      {
        suffix: "single",
        compaction: false,
        messageMode: "single",
        expected: { counts: [4, 2, 0, 1], phase: "cancelled", messages: 1 },
      },
      {
        suffix: "ordered",
        compaction: true,
        messageMode: "ordered",
        expected: { counts: [4, 2, 1, 1], phase: "cancelled", messages: 4 },
      },
      {
        suffix: "cold",
        compaction: true,
        messageMode: "ordered",
        cold: true,
        expected: { writer: [3, 2, 1, 1], reader: [1, 0, 0, 1] },
      },
      {
        suffix: "held-stop",
        compaction: false,
        messageMode: "single",
        expected: {
          counts: profile === "effect" ? [4, 2, 0, 1] : [3, 2, 0, 1],
          sourceCounts: profile === "effect" ? [4, 2, 0, 1] : [3, 2, 0, 1],
          phase: "running",
          messages: 0,
          reports: profile === "effect" ? 1 : 3,
        },
      },
      {
        suffix: "writer-fail",
        compaction: true,
        messageMode: "single",
        expected: {
          counts: [3, 2, 1, 1],
          phase: "running",
          messages: 0,
          reports: 1,
        },
      },
    ].map((c) => ({
      id: `agent-snapshot-messages.${profile}.${c.suffix}`,
      cold: c.cold ?? false,
      input: {
        mode: "runtime",
        profile,
        snapshot: true,
        compaction: c.compaction,
        every: 1,
        scenario: ["held-stop", "writer-fail"].includes(c.suffix)
          ? c.suffix
          : "normal",
        messageMode: c.messageMode,
      },
      expected: c.expected,
      hostEnvelope: ["held-stop", "writer-fail"].includes(c.suffix),
      open: false,
    })),
);

export const snapshotMessagesAuthoringGate = [
  {
    contract:
      "plain returned messages keep order, original payloads and stamps",
    regression:
      "dropping/reversing Vec, rebuilding payloads or minting timestamps",
    existingGap: "the old writer completes with ()",
    seam: "actual finite Agent machine and plain command settlement",
  },
  {
    contract:
      "context dispatch queues before returned list and following handler",
    regression: "reentrant Cancel prevents the next handler or changes order",
    existingGap: "the old writer has no returned list",
    seam: "public runtime handler/commit trace and literal model counts",
  },
  {
    contract: "cold Boot, failure and stop retain owners and exact checkpoints",
    regression:
      "eager loaded init, swallowed plain failure, late message transition",
    existingGap: "old grid uses a distinct () completion arm",
    seam: "real FileStore, named writer and fresh reader processes",
  },
];
