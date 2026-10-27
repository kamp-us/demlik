const core = "crates/tea/src/core.rs",
  engine = "crates/tea/src/runtime/engine.rs";
const actor = (policy, scenario = "declared") =>
  ["promise", "effect"].map(
    (profile) =>
      `typed-reducer.actor.${profile}.${policy}.${scenario}.dispatch`,
  );
export const typedReducerControls = [
  {
    id: "fold-drops-tail",
    file: core,
    patches: [
      [
        "for message in messages {",
        "for message in messages.into_iter().take(1) {",
      ],
    ],
    cases: [
      "typed-reducer.pure.updates.ordered",
      "typed-reducer.pure.msgs-shared.reject-middle",
    ],
  },
  {
    id: "fold-reverses-command-batches",
    file: core,
    patches: [
      [
        "commands.extend(next.commands);",
        "commands.splice(0..0, next.commands);",
      ],
    ],
    cases: [
      "typed-reducer.pure.updates.ordered",
      "typed-reducer.pure.updates-shared.ordered",
    ],
  },
  {
    id: "fold-swallows-declared-error",
    file: core,
    patches: [
      [
        "let next = apply(&state, message)?;",
        "let next = match apply(&state, message) { Ok(next) => next, Err(_) => continue };",
      ],
    ],
    cases: [
      "typed-reducer.pure.updates.reject-middle",
      "typed-reducer.pure.msgs-shared.reject-first",
    ],
  },
  {
    id: "declared-error-becomes-lookup-refusal",
    file: core,
    patches: [
      [
        "return cell(state, message).map_err(ApplyError::Reduce);",
        'return cell(state, message).map_err(|_| ApplyError::NoCell(NoCellError::new(message.tag(), "<typed-reducer-control>", self.accepted_types(Some(state)))));',
      ],
    ],
    cases: [...actor("stop"), ...actor("restart", "nested-no-cell")],
  },
  {
    id: "typed-branch-bypasses-report-and-policy",
    file: engine,
    patches: [
      [
        "self.reduce_failed(&state, &message, Rc::new(RuntimeError::Reduce(error)))?",
        "return Err(Rc::new(RuntimeError::Reduce(error))); ",
      ],
    ],
    cases: [...actor("stop"), ...actor("restart")],
  },
  {
    id: "reducer-report-has-wrong-phase",
    file: engine,
    patches: [
      [
        "self.core.report(Rc::clone(&error), ErrorPhase::Reduce);",
        "self.core.report(Rc::clone(&error), ErrorPhase::FollowUp);",
      ],
    ],
    cases: actor("escalate"),
  },
  {
    id: "stop-does-not-halt",
    file: engine,
    patches: [
      [
        "if queue.gate != Gate::Abandoned {\n                        queue.gate = Gate::Closed;\n                    }",
        "let _ = queue;",
      ],
    ],
    cases: actor("stop"),
  },
  {
    id: "escalate-halts",
    file: engine,
    patches: [
      [
        "Supervision::Escalate => Err(error),",
        "Supervision::Escalate => { self.producer.mailbox.with(|queue| queue.gate = Gate::Closed); Err(error) },",
      ],
    ],
    cases: actor("escalate"),
  },
  {
    id: "restart-calls-rehydrate-twice",
    file: engine,
    patches: [
      [
        "Ok(Step::new(rehydrate(state, message, &error), vec![]))",
        "let _ = rehydrate(state, message, &error); Ok(Step::new(rehydrate(state, message, &error), vec![]))",
      ],
    ],
    cases: actor("restart"),
  },
  {
    id: "restart-reports-after-rehydrate",
    file: engine,
    patches: [
      ["self.core.report(Rc::clone(&error), ErrorPhase::Reduce);", ""],
      [
        "Ok(Step::new(rehydrate(state, message, &error), vec![]))",
        "let recovered = rehydrate(state, message, &error); self.core.report(Rc::clone(&error), ErrorPhase::Reduce); Ok(Step::new(recovered, vec![]))",
      ],
    ],
    cases: actor("restart"),
  },
  {
    id: "failed-reducer-notifies-a-commit",
    file: engine,
    patches: [
      [
        "Ok(Err(ApplyError::Reduce(error))) => {\n                self.reduce_failed",
        "Ok(Err(ApplyError::Reduce(error))) => {\n                self.core.committed(Some(&message), &state);\n                self.reduce_failed",
      ],
    ],
    cases: actor("escalate"),
  },
  {
    id: "lookup-refusal-is-supervised",
    file: engine,
    patches: [
      [
        "Ok(Err(ApplyError::NoCell(error))) => {\n                return Err(Rc::new(RuntimeError::NoCell(error)));\n            }",
        "Ok(Err(ApplyError::NoCell(error))) => self.reduce_failed(&state, &message, Rc::new(RuntimeError::NoCell(error)))?,",
      ],
    ],
    cases: [...actor("stop", "lookup"), ...actor("restart", "lookup")],
  },
  {
    id: "drive-receipt-precedes-cleanup",
    file: "crates/tea/src/runtime/drive.rs",
    patches: [
      [
        "runtime.stop().await;\n            let _ = tx.send(answer);",
        "let _ = tx.send(answer);\n            runtime.stop().await;",
      ],
    ],
    test: "cancellation_failure_waits_for_disposer_before_settling_the_drive_both_profiles",
    assertion: "drive receipt escaped before cleanup",
  },
  {
    id: "scope-receipt-precedes-cleanup",
    file: "crates/tea/src/runtime/scope.rs",
    patches: [
      [
        "scope.close().await;\n            let _ = tx.send(result);",
        "let _ = tx.send(result);\n            scope.close().await;",
      ],
    ],
    test: "effect_scope_returns_the_original_typed_program_failure_after_awaited_cleanup",
    assertion: "scope receipt escaped before cleanup",
  },
  {
    id: "promise-admission-becomes-lazy",
    file: engine,
    patches: [
      [
        "let mut pending = Some(message);\n        let eager = if self.profile == Profile::Promise {",
        "let mut pending = Some(message);\n        let eager = if false {",
      ],
    ],
    test: "dropping_dispatch_waiters_preserves_only_work_admitted_by_the_profile",
    assertion: "profile admission must own work after its waiter drops",
  },
  {
    id: "scope-erases-an-extra-rc-wrapper",
    file: "crates/tea/src/runtime/scope.rs",
    patches: [["cause: error,", "cause: Rc::new(error),"]],
    test: "scope_failure_downcast_keeps_the_actual_runtime_allocation_with_a_typed_reducer_family",
    assertion: "scope must retain the actual runtime error type",
  },
];
