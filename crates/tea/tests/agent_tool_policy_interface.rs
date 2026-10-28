use demlik_tea::{
    PlainData, Tagged,
    agent::{
        AgentConfig, AgentError, OptionalProfile, PlainCalls, PlainToolCall, StructuredOutputError,
        ToolResilience, create_agent,
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

// Contract: a new policy declaration stays inert during construction/init and
// refuses behavior while the retry/timer implementation is deliberately pending.
// Regression: silently ignore a selected policy or invoke its callback early.
// This uses public constructors and preserves snapshot selection, with no test export.
#[test]
fn policy_declaration_refuses_before_callbacks_and_preserves_snapshot_selection() {
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
    let Err(error) = agent.start(&state, "r", 0.0) else {
        panic!("pending profile must refuse")
    };
    assert!(matches!(
        error,
        AgentError::UnsupportedConfiguredProfile {
            profile: OptionalProfile::ToolResilience
        }
    ));
    assert_eq!(error.name(), "UnsupportedAgentProfile");
    assert_eq!(
        error.to_string(),
        "base agent cannot execute configured toolResilience"
    );
    assert!(matches!(
        agent.subs(&state),
        Err(AgentError::UnsupportedConfiguredProfile {
            profile: OptionalProfile::ToolResilience
        })
    ));
    assert_eq!((callbacks.get(), payloads.get()), (0, 0));
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
