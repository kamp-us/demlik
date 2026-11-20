interface Rule {
  readonly when: string;
  readonly use: string;
  readonly from: string;
  readonly page: string;
  readonly instead?: string;
}

export const rules: readonly Rule[] = [
  {
    when: "An older search answer overwrites newer results; ignore late answers",
    use: "defineMachine",
    from: "@demlik/tea",
    page: "docs/how-to/ignore-a-late-answer.md",
    instead: "requestId guards in update; declare the machine's identity",
  },
  {
    when: "You step the machine yourself and must ignore late answers",
    use: "matchesIdentity, applyCell",
    from: "@demlik/tea",
    page: "docs/how-to/ignore-a-late-answer.md#3-step-the-machine-in-your-own-host",
    instead: "a custom filter; call matchesIdentity before applyCell",
  },
  {
    when: "Save to your own database or ledger that can append atomically and read in order",
    use: "Journal, eventSourcedStore",
    from: "@demlik/tea/persistence",
    page: "docs/how-to/make-durable.md",
    instead:
      "a Store that keeps only the latest State and no log; eventSourcedStore retains owed work (one writer per stream)",
  },
  {
    when: "Save the latest State in one SQL row with compare-and-set",
    use: "rowStore",
    from: "@demlik/tea/persistence",
    page: "docs/reference/persistence.md#rowStore",
    instead:
      "hand-written revision fencing; use a RowPort and { fenced: true }",
  },
  {
    when: "Two processes may write the same machine's log",
    use: "FencedJournal, eventSourcedStore",
    from: "@demlik/tea/persistence",
    page: "docs/reference/persistence.md#eventSourcedStore",
    instead: "unchecked appends; supply a FencedJournal and { fenced: true }",
  },
  {
    when: "Check whether your storage driver preserves order and atomic batches",
    use: "journalConformance",
    from: "@demlik/tea/pbt",
    page: "docs/reference/persistence.md#check-a-host-written-journal",
    instead: "a home-grown driver test suite; inspect failed and skipped cases",
  },
  {
    when: "Work takes longer than one call or the platform's request limit",
    use: "owed",
    from: "@demlik/tea",
    page: "docs/how-to/make-durable.md#6-hand-long-work-to-an-external-owner",
    instead:
      "awaiting the whole job; durably hand off, return owed(), then dispatch(msg, { answerTo }) on a later call (logged store required)",
  },
  {
    when: "List what is still waiting for an answer",
    use: "logLedger",
    from: "@demlik/tea",
    page: "docs/how-to/make-durable.md#6-hand-long-work-to-an-external-owner",
    instead:
      "a second pending-work list; read logLedger(await store.readLog()).surviving()",
  },
  {
    when: "The host must wake the machine at its next deadline after the call ends",
    use: "deadlinesSub, deadlineExceeded",
    from: "@demlik/tea/resilience",
    page: "docs/how-to/make-durable.md#5-end-each-call-and-return-the-next-alarm",
    instead:
      "an in-process timer after stop; share the State deadline selector and set the platform alarm in the host",
  },
  {
    when: "An effect needs typed success and error results",
    use: "Cmd.define",
    from: "@demlik/tea",
    page: "docs/how-to/run-on-the-promise-engine.md",
    instead:
      "hand-written outcome Msgs; declare input and ok schemas and err tags",
  },
  {
    when: "The saved State shape changed and old saves must still load",
    use: "schemaMigrate",
    from: "@demlik/tea",
    page: "docs/reference/tea.md#schemaMigrate",
    instead:
      "repeated boundary parsing; give Store.migrate a schemaMigrate(schema, upcast)",
  },
] satisfies readonly Rule[];
