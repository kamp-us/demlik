use std::{
    cell::{Cell, RefCell},
    convert::Infallible,
    panic::{AssertUnwindSafe, catch_unwind},
    rc::Rc,
};

use demlik_tea::{
    Machine, Step, Tagged, Update,
    agent::{
        AgentConfig, AgentError, OptionalProfile, create_agent,
        types::{AgentField, AgentTurn, Conversation},
    },
    core::{ProjectionError, SubEntry, SubscriptionEntries, SubscriptionProjection},
    data::{DependencyError, Sub},
    llm_call::{self, LlmCall, Schema},
    resilience::{deadline, resilient_call::CallValue},
};
use serde::{Serialize, Serializer};

struct Opaque<'a> {
    label: &'a str,
    marker: &'a Cell<u8>,
}
struct Model<'a> {
    count: u32,
    owner: &'a Opaque<'a>,
}
impl Tagged for Model<'_> {
    fn tag(&self) -> &str {
        "counter"
    }
}
demlik_tea::messages! { enum Msg { Added } }

enum Dependency {
    Value(u8),
    Refused,
}
impl Serialize for Dependency {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Value(value) => serializer.serialize_u8(*value),
            Self::Refused => Err(serde::ser::Error::custom("dependency refused")),
        }
    }
}

#[test]
fn ordinary_infallible_constructors_keep_inference() {
    let whole = demlik_tea::core::subscriptions(|value: &u32| vec![*value]);
    assert_eq!(whole.desired(&7).unwrap(), [7]);
    let entries =
        SubscriptionEntries::new(vec![SubEntry::new("pulse", |value: &u32| Some(*value))]);
    let desired = entries.desired(&7).unwrap();
    assert_eq!(desired.len(), 1);
    assert_eq!(desired[0].kind(), "pulse");
    assert_eq!(*desired[0].deps(), 7);
}

#[test]
fn borrowed_opaque_whole_projection_preserves_original_cause_without_panic() {
    let label = String::from("original error");
    let marker = Cell::new(3);
    let cause = Rc::new(Opaque {
        label: &label,
        marker: &marker,
    });
    let model_owner = Opaque {
        label: &label,
        marker: &marker,
    };
    let model = Model {
        count: 1,
        owner: &model_owner,
    };
    let projection = demlik_tea::core::try_subscriptions(|state: &Model<'_>| {
        assert!(std::ptr::eq(state.owner, &model_owner));
        Err::<Vec<()>, _>(Rc::clone(&cause))
    });
    let result = catch_unwind(AssertUnwindSafe(|| projection.desired(&model)));
    let Ok(Err(ProjectionError::Declared(error))) = result else {
        panic!("declared refusal became a panic or success");
    };
    assert!(Rc::ptr_eq(&error, &cause));
    assert_eq!(error.label, label);
    assert!(std::ptr::eq(error.marker, &marker));
    let evaluated = projection.evaluate(&model);
    assert!(evaluated.desired.is_empty());
    let runtime_error: demlik_tea::runtime::Failure<Infallible, Infallible, Rc<Opaque<'_>>> =
        Rc::new(demlik_tea::runtime::RuntimeError::Projection {
            failures: evaluated.failures,
        });
    let retained = Rc::clone(&runtime_error);
    assert!(Rc::ptr_eq(&runtime_error, &retained));
    assert_eq!(retained.name(), "SubscriptionProjectionError");
    let demlik_tea::runtime::RuntimeError::Projection { failures } = retained.as_ref() else {
        panic!("projection was routed through another error category");
    };
    let [failure] = failures.as_slice() else {
        panic!("refusal was erased");
    };
    assert!(failure.kind.is_none());
    let ProjectionError::Declared(error) = &failure.cause else {
        panic!("cause category changed");
    };
    assert!(Rc::ptr_eq(error, &cause));
}

#[test]
fn typed_entries_keep_kinds_and_collect_siblings_dependency_errors_and_panics() {
    let label = String::from("per entry");
    let marker = Cell::new(1);
    let original = Rc::new(Opaque {
        label: &label,
        marker: &marker,
    });
    let entries = SubscriptionEntries::new(vec![
        SubEntry::try_new("declared", |_: &()| {
            Err::<Option<Dependency>, _>(Rc::clone(&original))
        }),
        SubEntry::try_new("healthy", |_: &()| Ok(Some(Dependency::Value(9)))),
        SubEntry::try_new("bad-data", |_: &()| Ok(Some(Dependency::Refused))),
        SubEntry::try_new("panicked", |_: &()| panic!("native projection panic")),
    ]);
    let direct = catch_unwind(AssertUnwindSafe(|| entries.desired(&())));
    assert!(
        matches!(direct, Ok(Err(ProjectionError::Declared(error))) if Rc::ptr_eq(&error, &original))
    );
    let result = entries.evaluate(&());
    assert_eq!(result.desired.len(), 1);
    assert_eq!(result.desired[0].kind(), "healthy");
    assert_eq!(
        result
            .failures
            .iter()
            .map(|f| f.kind.as_deref())
            .collect::<Vec<_>>(),
        [Some("declared"), Some("bad-data"), Some("panicked")]
    );
    assert!(
        matches!(&result.failures[0].cause, ProjectionError::Declared(error) if Rc::ptr_eq(error, &original))
    );
    assert!(matches!(
        &result.failures[1].cause,
        ProjectionError::Dependency(_)
    ));
    assert!(
        matches!(&result.failures[2].cause, ProjectionError::Panic(payload) if payload.downcast_ref::<&str>() == Some(&"native projection panic"))
    );
}

#[test]
fn legacy_replay_keeps_its_signature_and_borrowed_model_without_new_bounds() {
    let label = String::from("loaded");
    let marker = Cell::new(7);
    let owner = Opaque {
        label: &label,
        marker: &marker,
    };
    let init_calls = Cell::new(0);
    let projections = Cell::new(0);
    let machine: Machine<'_, Model<'_>, Msg, (), Sub<u32>> = Machine {
        init: Box::new(|loaded, _| {
            init_calls.set(init_calls.get() + 1);
            Step::new(loaded.expect("caller supplied original model"), vec![])
        }),
        update: Update::reducer(|state: &Model<'_>, _| {
            Step::new(
                Model {
                    count: state.count + 1,
                    owner: state.owner,
                },
                vec![],
            )
        }),
        subscriptions: demlik_tea::core::subscriptions(|state: &Model<'_>| {
            projections.set(projections.get() + 1);
            vec![Sub::new("pulse", state.count).unwrap()]
        }),
    };
    let result: Result<_, demlik_tea::NoCellError> = demlik_tea::replay(
        &machine,
        Some(Model {
            count: 4,
            owner: &owner,
        }),
        &(),
        [Msg::Added],
    );
    let replayed = result.unwrap();
    assert_eq!(init_calls.get(), 1);
    assert_eq!(projections.get(), 1);
    assert_eq!(replayed.state.count, 5);
    assert!(std::ptr::eq(replayed.state.owner, &owner));
    assert_eq!(*replayed.subs[0].deps(), 5);
}

#[test]
fn legacy_replay_preserves_its_existing_native_dependency_panic() {
    struct Empty;
    impl Tagged for Empty {
        fn tag(&self) -> &str {
            "empty"
        }
    }
    let machine: Machine<'_, Empty, Msg, (), Sub<Dependency>> = Machine {
        init: Box::new(|_, _| Step::new(Empty, vec![])),
        update: Update::reducer(|_, _| Step::new(Empty, vec![])),
        subscriptions: Box::new(SubscriptionEntries::new(vec![SubEntry::new(
            "bad-data",
            |_: &Empty| Some(Dependency::Refused),
        )])),
    };
    let failed = catch_unwind(AssertUnwindSafe(|| {
        demlik_tea::replay(&machine, None, &(), [])
    }));
    let Err(payload) = failed else {
        panic!("legacy replay erased dependency failure");
    };
    assert!(payload.is::<DependencyError>());
}

struct Parser;
impl Schema for Parser {
    type Raw = Rc<AgentTurn>;
    type Output = Rc<AgentTurn>;
    type Error = Infallible;
    fn parse(&self, value: Self::Raw) -> Result<Self::Output, CallValue<Self::Error>> {
        Ok(value)
    }
}
struct ToolCommand;
impl Tagged for ToolCommand {
    fn tag(&self) -> &str {
        "tool"
    }
}

#[test]
fn canonical_agent_state_is_projected_directly_with_original_composed_owners() {
    let label = String::from("borrowed stage");
    let marker = Cell::new(73);
    let stage = Rc::new(Opaque {
        label: &label,
        marker: &marker,
    });
    let parser = Rc::new(Parser);
    let llm = Rc::new(LlmCall::new(
        llm_call::Config::new(move |_: &&str| Rc::clone(&parser)),
        |_: &Infallible| Ok("unreachable".into()),
    ));
    let agent = create_agent(
        AgentConfig::new(
            llm,
            vec![Rc::clone(&stage)],
            |_| "audit",
            |_| ToolCommand,
            |_, _: &Rc<Conversation<Opaque<'_>, AgentTurn, Opaque<'_>>>, _| (),
            |turn: &AgentTurn| turn,
        )
        .deadline_ms(25.0),
    );
    let active = agent.start(&agent.init(), "r", 0.0).unwrap().state;
    assert!(Rc::ptr_eq(&active.current_stage().unwrap(), &stage));
    let original_run = Rc::clone(&active.run);
    let original_tools = Rc::clone(&active.tools);
    let entries = SubscriptionEntries::new(vec![SubEntry::try_new("deadline", |candidate| {
        assert!(std::ptr::eq(candidate, active.as_ref()));
        agent
            .subs(candidate)
            .map(|list| deadline::deadlines(&list).is_some().then_some(list))
    })]);
    let result = entries.evaluate(active.as_ref());
    assert!(result.failures.is_empty());
    assert_eq!(result.desired.len(), 1);
    assert_eq!(result.desired[0].kind(), "deadline");
    assert!(Rc::ptr_eq(&active.run, &original_run));
    assert!(Rc::ptr_eq(&active.tools, &original_tools));

    let mut invalid = active.as_ref().clone();
    invalid.compaction = AgentField::Absent;
    let invalid = Rc::new(invalid);
    let captured = RefCell::new(None);
    let refusing = SubscriptionEntries::new(vec![SubEntry::try_new("deadline", |candidate| {
        assert!(std::ptr::eq(candidate, invalid.as_ref()));
        agent
            .subs(candidate)
            .map(|list| deadline::deadlines(&list).is_some().then_some(list))
            .map_err(|error| {
                let error = Rc::new(error);
                captured.replace(Some(Rc::clone(&error)));
                error
            })
    })]);
    let result = refusing.evaluate(invalid.as_ref());
    let [failure] = result.failures.as_slice() else {
        panic!("agent refusal was erased");
    };
    assert_eq!(failure.kind.as_deref(), Some("deadline"));
    let ProjectionError::Declared(error) = &failure.cause else {
        panic!("agent refusal category changed");
    };
    assert!(Rc::ptr_eq(error, captured.borrow().as_ref().unwrap()));
    assert!(
        matches!(error.as_ref(), AgentError::UnsupportedRestoredProfile { profile: OptionalProfile::MissingCompaction, keys } if keys.is_empty())
    );
    assert!(Rc::ptr_eq(&invalid.run, &original_run));
    assert!(Rc::ptr_eq(&invalid.tools, &original_tools));
}
