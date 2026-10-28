use demlik_tea::{
    PlainData, Tagged,
    agent::{
        AgentConfig, PlainCalls, PlainToolCall, StructuredOutputError, ToolResilience,
        create_agent,
        types::{AGENT_TURN_SCHEMA, Conversation},
    },
    llm_call::{self, LlmCall},
    retry_backoff::{CountBound, DEFAULT_RETRY_POLICY, RetryPolicy},
};
use std::{cell::Cell, rc::Rc};
struct Tool(Rc<PlainToolCall>);
impl Tagged for Tool {
    fn tag(&self) -> &str {
        self.0.name().as_utf8().unwrap()
    }
}

// Contract: policy selection waits for a launch and survives snapshot selection.
// Regression: invoke the selector during construction/start or drop it on profile selection.
// Existing base constructors have no policy callback; this uses the public config only.
#[test]
fn policy_declaration_is_deferred_and_preserves_snapshot_selection() {
    let schema = Rc::new(AGENT_TURN_SCHEMA);
    let llm = Rc::new(LlmCall::new(
        llm_call::Config::new(move |_: &&str| Rc::clone(&schema)),
        StructuredOutputError::describe,
    ));
    let callbacks = Cell::new(0);
    let payloads = Cell::new(0);
    let agent = create_agent(
        AgentConfig::from_plain_turns(
            llm,
            vec![Rc::new("collect")],
            |_| "invoice",
            |call| Tool(Rc::clone(call)),
            |_, _: &Rc<Conversation<PlainData, PlainData, PlainData, PlainData, PlainCalls>>, _| {
                payloads.set(payloads.get() + 1);
            },
        )
        .tool_resilience_of(|_| {
            callbacks.set(callbacks.get() + 1);
            Some(
                ToolResilience::default()
                    .timeout_ms(25.0)
                    .retry(RetryPolicy {
                        budget: CountBound { max_attempts: 2.0 },
                        ..DEFAULT_RETRY_POLICY
                    }),
            )
        })
        .with_snapshots(1.0),
    );
    let state = agent.init();
    assert_eq!((callbacks.get(), payloads.get()), (0, 0));
    let started = agent.start(&state, "r", 0.0).unwrap();
    assert!(!started.commands.is_empty());
    assert!(agent.subs(&started.state).unwrap().is_empty());
    assert_eq!((callbacks.get(), payloads.get()), (0, 1));
}

// Contract: omission/default policy data has no invented fields or durable tag.
// Regression: a default constructor silently enables a timeout or retry budget.
// This is declaration wire only, separate from canonical State codec coverage.
#[test]
fn tool_policy_declaration_defaults_match_the_source_optional_fields() {
    assert_eq!(
        serde_json::to_string(&ToolResilience::default()).unwrap(),
        "{}"
    );
    let timed = ToolResilience::default().timeout_ms(0.0);
    assert_eq!(
        serde_json::to_string(&timed).unwrap(),
        r#"{"timeoutMs":0.0}"#
    );
}
