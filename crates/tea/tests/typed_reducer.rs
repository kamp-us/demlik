use demlik_tea::{
    ApplyError, Machine, Step, Sub, Tagged, TryUpdate, try_fold_msgs, try_fold_msgs_shared,
    try_fold_updates, try_fold_updates_shared,
};
use std::{cell::Cell, rc::Rc, sync::Arc};

struct Cause<'a> {
    name: &'a str,
    local: Rc<Cell<u8>>,
}
struct Failure<'a> {
    original: Rc<Cause<'a>>,
}
struct Model<'a> {
    count: u32,
    name: &'a str,
    local: Rc<Cell<u8>>,
}
impl Tagged for Model<'_> {
    fn tag(&self) -> &str {
        "model"
    }
}
enum Msg {
    Added,
    Rejected,
}
impl Tagged for Msg {
    fn tag(&self) -> &str {
        match self {
            Self::Added => "added",
            Self::Rejected => "rejected",
        }
    }
}
impl demlik_tea::core::Message for Msg {
    const TYPES: &'static [&'static str] = &["added", "rejected"];
}
struct Command<'a>(&'a str);

#[test]
#[expect(
    clippy::arc_with_non_send_sync,
    reason = "Retained pure folds must accept borrowed local values."
)]
fn typed_update_only_folds_retain_opaque_borrowed_causes_and_seed_without_effects() {
    let name = String::from("borrowed");
    let local = Rc::new(Cell::new(7));
    let cause = Rc::new(Cause {
        name: &name,
        local: Rc::clone(&local),
    });
    let calls = Cell::new(0);
    let update = TryUpdate::try_reducer(|state: &Model<'_>, msg: &Msg| {
        calls.set(calls.get() + 1);
        match msg {
            Msg::Added => Ok(Step::new(
                Model {
                    count: state.count + 1,
                    name: state.name,
                    local: Rc::clone(&state.local),
                },
                vec![Command(state.name)],
            )),
            Msg::Rejected => Err(Failure {
                original: Rc::clone(&cause),
            }),
        }
    });
    let machine: Machine<'_, Model<'_>, Msg, Command<'_>, Sub, (), Failure<'_>> = Machine {
        init: Box::new(|_, _| panic!("update-only fold called init")),
        update,
        subscriptions: demlik_tea::core::subscriptions(|_| {
            panic!("update-only fold selected subscriptions")
        }),
    };
    let seed = Arc::new(Model {
        count: 0,
        name: &name,
        local: Rc::clone(&local),
    });
    let empty = match try_fold_updates_shared(&machine.update, Arc::clone(&seed), []) {
        Ok(step) => step,
        Err(_) => panic!("empty fold failed"),
    };
    assert!(Arc::ptr_eq(&empty.state, &seed));
    assert_eq!(calls.get(), 0);
    let step =
        match try_fold_updates_shared(&machine.update, Arc::clone(&seed), [Arc::new(Msg::Added)]) {
            Ok(step) => step,
            Err(_) => panic!("valid fold failed"),
        };
    assert_eq!(step.state.count, 1);
    assert!(Rc::ptr_eq(&step.state.local, &local));
    assert_eq!(step.commands[0].0, "borrowed");
    let failure = match try_fold_msgs_shared(
        &machine,
        Arc::clone(&seed),
        [Msg::Added, Msg::Rejected, Msg::Added].map(Arc::new),
    ) {
        Err(ApplyError::Reduce(error)) => error,
        Err(ApplyError::NoCell(_)) => panic!("declared failure became NoCell"),
        Ok(_) => panic!("declared failure was swallowed"),
    };
    assert!(Rc::ptr_eq(&failure.original, &cause));
    assert_eq!(failure.original.name, "borrowed");
    assert!(Rc::ptr_eq(&failure.original.local, &local));
    assert_eq!(calls.get(), 3);
    assert_eq!(seed.count, 0);
    let owned = match try_fold_msgs(
        &machine,
        Model {
            count: 0,
            name: &name,
            local: Rc::clone(&local),
        },
        [Msg::Rejected],
    ) {
        Err(ApplyError::Reduce(error)) => error,
        _ => panic!("owned replay must retain its declared cause"),
    };
    assert!(Rc::ptr_eq(&owned.original, &cause));
    assert_eq!(calls.get(), 4);
    let missing: TryUpdate<'_, Model<'_>, Msg, Command<'_>, Failure<'_>> =
        TryUpdate::RawReducer(Default::default());
    let error = match try_fold_updates(
        &missing,
        Model {
            count: 0,
            name: &name,
            local,
        },
        [Msg::Rejected],
    ) {
        Err(ApplyError::NoCell(error)) => error,
        _ => panic!("lookup must remain NoCell"),
    };
    assert_eq!(error.name(), "NoCellError");
    assert_eq!(error.msg_type, "rejected");
}

#[test]
fn actual_agent_null_usage_stays_a_declared_reduce_error() {
    use demlik_tea::{
        PlainData,
        agent::{
            AgentConfig, AgentError, create_agent,
            types::{AgentField, AgentTurn, Conversation, ToolCall, TurnUsage},
        },
        llm_call::{Config, LlmCall, Schema},
        resilience::resilient_call::CallValue,
    };
    struct Parser;
    impl Schema for Parser {
        type Raw = Rc<AgentTurn>;
        type Output = Rc<AgentTurn>;
        type Error = ();
        fn parse(&self, raw: Self::Raw) -> Result<Self::Output, CallValue<()>> {
            Ok(raw)
        }
    }
    struct Tool(Rc<ToolCall>);
    impl Tagged for Tool {
        fn tag(&self) -> &str {
            let _ = &self.0;
            "bare_tool"
        }
    }
    struct Retained<S>(Rc<S>);
    impl<S> Tagged for Retained<S> {
        fn tag(&self) -> &str {
            "(untagged state)"
        }
    }
    struct TurnMsg(Rc<AgentTurn>);
    impl Tagged for TurnMsg {
        fn tag(&self) -> &str {
            "measured_turn"
        }
    }
    impl demlik_tea::core::Message for TurnMsg {
        const TYPES: &'static [&'static str] = &["measured_turn"];
    }
    let llm = Rc::new(LlmCall::new(
        Config::new(|_: &&str| Rc::new(Parser)),
        |_: &()| Ok("failure".into()),
    ));
    let agent = create_agent(AgentConfig::new(
        llm,
        vec![Rc::new("collect")],
        |stage| **stage.unwrap(),
        |call| Tool(Rc::clone(call)),
        |_, _: &Rc<Conversation<PlainData>>, _| (),
        |turn| turn,
    ));
    let active = agent.start(&agent.init(), "run", 0.0).unwrap().state;
    let mut bad = active.as_ref().clone();
    bad.usage = AgentField::Value(None);
    let bad = Rc::new(bad);
    let retained = Rc::clone(&bad);
    let update = TryUpdate::try_reducer(|state: &Retained<_>, msg: &TurnMsg| {
        agent
            .turn(&state.0, Rc::clone(&msg.0), 1.0)
            .map(|step| step.map(Retained, |cmd| cmd))
    });
    let turn = Rc::new(AgentTurn {
        content: "measured".into(),
        tool_calls: vec![],
        provider: AgentField::Absent,
        usage: AgentField::Value(Rc::new(TurnUsage::new(1.0, 2.0))),
    });
    let error = match try_fold_updates(&update, Retained(bad), [TurnMsg(turn)]) {
        Err(ApplyError::Reduce(error)) => error,
        Err(ApplyError::NoCell(_)) => panic!("AgentError became NoCell"),
        Ok(_) => panic!("null usage must refuse"),
    };
    assert!(matches!(error, AgentError::NullUsage));
    assert!(retained.conversation.as_ref().unwrap().turns.is_empty());
}
