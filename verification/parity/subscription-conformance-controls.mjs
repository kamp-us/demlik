const engine = "crates/tea/src/runtime/engine.rs",
  core = "crates/tea/src/core/subscriptions.rs";
const pair = (scenario) =>
  ["promise", "effect"].map((p) => `subscription.${p}.${scenario}`);
const view = `        *self.core.view.borrow_mut() = View {
            state: Some(Arc::clone(&state)),
            saved: if self.store.is_some() {
                SaveStatus::Pending
            } else {
                SaveStatus::Saved
            },
        };
`;
export const subscriptionControls = [
  {
    id: "projection-failure-aborts-siblings",
    file: core,
    patches: [
      [
        "                cause,\n            });\n        }\n        evaluation",
        "                cause,\n            });\n            break;\n        }\n        evaluation",
      ],
    ],
    cases: pair("two-failures"),
  },
  {
    id: "failed-kind-is-disposed",
    file: engine,
    patches: [[" && !unread.contains(running.kind.as_str())", ""]],
    cases: pair("recover"),
  },
  {
    id: "last-error-replaces-first",
    file: engine,
    patches: [
      [
        "failures: evaluation.failures,",
        "failures: evaluation.failures.into_iter().rev().collect(),",
      ],
    ],
    cases: pair("two-failures"),
  },
  {
    id: "projection-refusal-is-swallowed",
    file: engine,
    patches: [
      [
        "        self.reconcile(&state)?;",
        "        let _ = self.reconcile(&state);",
      ],
    ],
    cases: pair("recover"),
  },
  {
    id: "projection-is-sub-failure",
    file: engine,
    patches: [
      [
        "        if starting {",
        "        if let Some(error) = &first { self.fail_sub(Rc::clone(error)); }\n        if starting {",
      ],
    ],
    cases: pair("recover"),
  },
  {
    id: "projection-is-reducer-report",
    file: engine,
    patches: [
      [
        "        if starting {",
        "        if let Some(error) = &first { self.core.report(Rc::clone(error), ErrorPhase::Reduce); }\n        if starting {",
      ],
    ],
    cases: pair("recover"),
  },
  {
    id: "failed-boot-flushes-again",
    file: engine,
    patches: [
      [
        "if !boot_failed && let (Some(store), Some(state))",
        "if let (Some(store), Some(state))",
      ],
    ],
    cases: pair("boot-projection"),
  },
  {
    id: "abandoned-boot-starts-subs",
    file: engine,
    patches: [
      [
        "let starting = self.producer.mailbox.gate() == Gate::Open;",
        "let starting = true;",
      ],
    ],
    cases: pair("held-load"),
  },
  {
    id: "state-installed-only-after-save",
    file: engine,
    patches: [
      [view, ""],
      [
        "        self.reconcile(&state)?;",
        `${view}        self.reconcile(&state)?;`,
      ],
    ],
    cases: pair("held-save-projection"),
  },
  {
    id: "tail-wakes-before-receipt",
    file: engine,
    patches: [
      [
        "            tokio::task::yield_now().await;\n            self.producer.mailbox.completed(seq);",
        "            self.producer.mailbox.completed(seq);\n            tokio::task::yield_now().await;",
      ],
    ],
    cases: pair("mixed-runner"),
  },
  {
    id: "follow-up-overtakes-cleanup-rejection",
    file: engine,
    patches: [
      [
        "                    tokio::task::yield_now().await;\n                    if matches!(origin, Origin::Producer)",
        "                    if matches!(origin, Origin::Producer)",
      ],
    ],
    cases: ["subscription.promise.mixed-cleanup.producer"],
  },
  {
    id: "whole-refusal-becomes-empty",
    file: core,
    patches: [
      [
        "        (self.0)(state).map_err(ProjectionError::Declared)",
        "        match (self.0)(state) { Ok(desired) => Ok(desired), Err(_) => Ok(vec![]) }",
      ],
    ],
    test: "whole_projection_refusal_keeps_all_existing_kinds_until_real_recovery",
  },
  {
    id: "unknown-kind-refusal-loses-live-subs",
    file: engine,
    patches: [
      [
        "        let keep_all = evaluation\n            .failures\n            .iter()\n            .any(|failure| failure.kind.is_none());",
        "        let keep_all = false;",
      ],
    ],
    test: "whole_projection_refusal_keeps_all_existing_kinds_until_real_recovery",
  },
];
