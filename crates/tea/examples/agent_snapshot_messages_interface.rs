use demlik_tea::{
    PlainData, Tagged,
    agent::{
        AgentConfig, AgentMachineMsg, AgentToolMsg, AgentWorkError, StructuredOutputError,
        compaction::{CompactMessage, CompactRun, CompactionPolicy},
        create_agent,
        model::{Messages, NoMessages, plain_model},
        snapshot::{AgentSnapshotMessages, AgentSnapshotWrite},
        types::AGENT_TURN_SCHEMA,
    },
    command::{CommandContractError, CommandFamily},
    data::JsText,
    llm_call::{self, LlmCall},
    runtime::{CommandContext, CommandWork, Interpreter},
    timing::TokioTimer,
};
use std::rc::Rc;
struct Payload<'a>(&'a str);
struct Cause(String);
struct Tool;
impl Tagged for Tool {
    fn tag(&self) -> &str {
        "invoice_tool"
    }
}
impl CommandFamily for Tool {
    type Msg = AgentToolMsg<()>;
    type Completion = Vec<Self::Msg>;
    fn settle(
        self,
        value: Self::Completion,
        _: f64,
    ) -> Result<Vec<Self::Msg>, CommandContractError> {
        Ok(value)
    }
}

type OnMsg = AgentMachineMsg<
    JsText,
    (),
    Rc<PlainData>,
    StructuredOutputError,
    AgentToolMsg<()>,
    CompactMessage<Rc<PlainData>, Cause>,
>;
struct Tools<'a>(&'a str);
impl<M> Interpreter<Tool, M> for Tools<'_> {
    type Error = AgentWorkError<Cause>;
    fn interpret<'b>(
        &'b self,
        _: &'b Tool,
        _: CommandContext<M, Self::Error>,
    ) -> Option<CommandWork<'b, Vec<AgentToolMsg<()>>, Self::Error>> {
        Some(CommandWork::new(async move {
            assert_eq!(self.0, "borrowed");
            Ok(vec![])
        }))
    }
}
struct Compact<'a>(&'a str);
impl<'a> Interpreter<CompactRun<Payload<'a>, Rc<PlainData>, Cause>, OnMsg> for Compact<'a> {
    type Error = AgentWorkError<Cause>;
    fn interpret<'b>(
        &'b self,
        command: &'b CompactRun<Payload<'a>, Rc<PlainData>, Cause>,
        _: CommandContext<OnMsg, Self::Error>,
    ) -> Option<CommandWork<'b, Vec<CompactMessage<Rc<PlainData>, Cause>>, Self::Error>> {
        Some(CommandWork::new(async move {
            assert_eq!(command.input.payload.0, self.0);
            Ok(vec![])
        }))
    }
}
struct Writer<'a>(&'a str);
impl<M> Interpreter<AgentSnapshotWrite, M> for Writer<'_> {
    type Error = AgentWorkError<Cause>;
    fn interpret<'b>(
        &'b self,
        command: &'b AgentSnapshotWrite,
        _: CommandContext<M, Self::Error>,
    ) -> Option<CommandWork<'b, (), Self::Error>> {
        Some(CommandWork::new(async move {
            assert_eq!(self.0, "borrowed");
            assert!(matches!(
                command.command().input().payload.as_ref(),
                PlainData::Undefined
            ));
            Ok(())
        }))
    }
}
struct Returning<'a, M> {
    text: &'a str,
    message: fn() -> M,
}
impl<M> Interpreter<AgentSnapshotMessages<M>, M> for Returning<'_, M> {
    type Error = AgentWorkError<Cause>;
    fn interpret<'b>(
        &'b self,
        command: &'b AgentSnapshotMessages<M>,
        _: CommandContext<M, Self::Error>,
    ) -> Option<CommandWork<'b, Vec<M>, Self::Error>> {
        Some(CommandWork::new(async move {
            assert_eq!(self.text, "borrowed");
            assert!(matches!(
                command.command().input().payload.as_ref(),
                PlainData::Undefined
            ));
            Ok(vec![(self.message)()])
        }))
    }
}
fn main() {
    let owned = String::from("borrowed");
    let borrowed = owned.as_str();
    let schema = Rc::new(AGENT_TURN_SCHEMA);
    let llm = Rc::new(LlmCall::new(
        llm_call::Config::new(move |_: &JsText| Rc::clone(&schema)),
        StructuredOutputError::describe,
    ));
    let off = Rc::new(create_agent(AgentConfig::from_plain_turns(
        Rc::clone(&llm),
        vec![Rc::new(borrowed)],
        |_| "invoice".into(),
        |_| Tool,
        |_, _, _| (),
    )));
    let off_model = plain_model(async move |_: Messages<'_, ()>| {
        assert_eq!(borrowed, "borrowed");
        Ok(Rc::new(PlainData::Null))
    });
    let _off = Rc::clone(&off).to_machine(
        off_model,
        NoMessages,
        Tools(borrowed),
        Rc::new(TokioTimer::new(|_| {})),
    );
    let policy = CompactionPolicy::from_plain(
        |c| if c.turns.len() >= 2 { 2.0 } else { 0.0 },
        move |_, _| Payload(borrowed),
    );
    let on = Rc::new(create_agent(
        AgentConfig::from_plain_turns(
            Rc::clone(&llm),
            vec![Rc::new(borrowed)],
            |_| "invoice".into(),
            |_| Tool,
            |_, _, _| (),
        )
        .with_compaction(policy)
        .expect("profile before stop_when"),
    ));
    let model = plain_model(async move |_: Messages<'_, ()>| {
        assert_eq!(borrowed, "borrowed");
        Ok(Rc::new(PlainData::Null))
    });
    let _on = Rc::clone(&on).to_machine_with_compaction(
        model,
        NoMessages,
        Tools(borrowed),
        Compact(borrowed),
        Rc::new(TokioTimer::new(|_| {})),
    );
    let snapshot = Rc::new(create_agent(
        AgentConfig::from_plain_turns(
            Rc::clone(&llm),
            vec![Rc::new(borrowed)],
            |_| "invoice".into(),
            |_| Tool,
            |_, _, _| (),
        )
        .stop_when(|_| false)
        .with_snapshots(2.0),
    ));
    let started = snapshot.start(&snapshot.init(), "inv-17", 0.0).unwrap();
    let terminating = Rc::new(PlainData::Object(
        [
            ("content".into(), PlainData::String("invoice ready".into())),
            ("toolCalls".into(), PlainData::Array(vec![])),
        ]
        .into_iter()
        .collect(),
    ));
    let finished = snapshot.turn(&started.state, terminating, 1.0).unwrap();
    assert_eq!(finished.commands.len(), 1);
    let demlik_tea::agent::AgentCommand::Snapshot(command) = &finished.commands[0] else {
        panic!("actual terminal checkpoint");
    };
    assert!(matches!(
        command.command().input().payload.as_ref(),
        PlainData::Undefined
    ));
    assert_eq!(command.command().input().key, JsText::from("@@snapshot"));
    let model = plain_model(async move |_: Messages<'_, ()>| {
        assert_eq!(borrowed, "borrowed");
        Ok(Rc::new(PlainData::Null))
    });
    let _snapshot = Rc::clone(&snapshot).to_machine_with_snapshot(
        model,
        NoMessages,
        Tools(borrowed),
        Writer(borrowed),
        Rc::new(TokioTimer::new(|_| {})),
    );
    let policy = CompactionPolicy::from_plain(|_| 2.0, move |_, _| Payload(borrowed));
    let both = Rc::new(create_agent(
        AgentConfig::from_plain_turns(
            llm,
            vec![Rc::new(borrowed)],
            |_| "invoice".into(),
            |_| Tool,
            |_, _, _| (),
        )
        .with_snapshots(2.0)
        .with_compaction(policy)
        .expect("profile before predicate"),
    ));
    let model = plain_model(async move |_: Messages<'_, ()>| {
        assert_eq!(borrowed, "borrowed");
        Ok(Rc::new(PlainData::Null))
    });
    let _both = Rc::clone(&both).to_machine_with_snapshot_and_compaction(
        model,
        NoMessages,
        Tools(borrowed),
        Writer(borrowed),
        Compact(borrowed),
        Rc::new(TokioTimer::new(|_| {})),
    );
    let model = plain_model(async move |_: Messages<'_, ()>| {
        assert_eq!(borrowed, "borrowed");
        Ok(Rc::new(PlainData::Null))
    });
    let _returning = Rc::clone(&snapshot).to_machine_with_snapshot_messages(
        model,
        NoMessages,
        Tools(borrowed),
        Returning {
            text: borrowed,
            message: || AgentMachineMsg::cancel(17.25),
        },
        Rc::new(TokioTimer::new(|_| {})),
    );
    let model = plain_model(async move |_: Messages<'_, ()>| {
        assert_eq!(borrowed, "borrowed");
        Ok(Rc::new(PlainData::Null))
    });
    let _returning_both = Rc::clone(&both).to_machine_with_snapshot_messages_and_compaction(
        model,
        NoMessages,
        Tools(borrowed),
        Returning {
            text: borrowed,
            message: || AgentMachineMsg::cancel(17.25),
        },
        Compact(borrowed),
        Rc::new(TokioTimer::new(|_| {})),
    );
    let opaque = Cause(String::from("original"));
    assert_eq!(opaque.0, "original");
    println!(
        "old and returned-message profiles retain inferred borrowed ports and opaque host causes"
    );
}
