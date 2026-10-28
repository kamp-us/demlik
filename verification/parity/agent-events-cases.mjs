export const agentEventCases = [
  { id: "idle-is-silent", scenario: "idle", mode: "pure" },
  { id: "outbox-owner-once", scenario: "outbox", mode: "pure" },
  {
    id: "direct-success-is-not-deduplicated",
    scenario: "direct",
    mode: "pure",
  },
  { id: "failed-tool-refuses-late-success", scenario: "refused", mode: "pure" },
  {
    id: "cancel-ends-once-and-silences-late-success",
    scenario: "cancel",
    mode: "pure",
  },
  {
    id: "absorbed-retry-has-no-failure-event",
    scenario: "retry",
    mode: "pure",
  },
  ...["promise", "effect"].flatMap((profile) =>
    ["invoice", "listener", "save", "resume"].map((scenario) => ({
      id: `${profile}-${scenario}`,
      scenario,
      profile,
      mode: "runtime",
    })),
  ),
];

export const authoringGate = [
  {
    risk: "outbox-versus-direct publication",
    contract:
      "A lifecycle array is projected once by identity; direct successes remain per-message events; refused/cancelled late values are silent.",
    regression:
      "Content-based/global dedup drops valid direct events or replays embedded lifecycle notes.",
    coverageGap:
      "Existing native AgentEvent enum/transcript data tests never execute the missing projector.",
    unusedProductionSeam: false,
  },
  {
    risk: "real invoice transcript ownership/order",
    contract:
      "Three stages, five original turns, two actual invoice IO results and final status flow into the collector, including retained pending Boot.",
    regression:
      "Copying an owner, publishing tool completion after the next turn, or replaying loaded history changes live consumers.",
    coverageGap:
      "Existing runtime/tool/collector proofs are separate; this uses their public combination.",
    unusedProductionSeam: false,
  },
  {
    risk: "publication and callback failure boundary",
    contract:
      "Save failure prevents publication/work; one throwing event listener reports its original cause and leaves other listeners running.",
    regression:
      "Publish before save or abort the event bucket on the first callback failure.",
    coverageGap:
      "Data-only transcript coverage cannot see commit ordering or actual runtime listener isolation.",
    unusedProductionSeam: false,
  },
];
