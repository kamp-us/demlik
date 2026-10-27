#![allow(dead_code)]
use std::{borrow::Cow, cell::Cell, convert::Infallible, rc::Rc};

use demlik_tea::{
    Tagged,
    agent::{
        AgentConfig, StateOf, create_agent,
        types::{AgentTurn, Conversation},
    },
    command::{CommandContractError, CommandFamily},
    llm_call::{self, LlmCall, Schema},
    resilience::resilient_call::CallValue,
};

pub struct Stage<'a> {
    pub label: Cow<'a, str>,
    pub marker: Rc<Cell<u8>>,
}
pub struct OpaqueResult(pub Rc<Cell<u8>>);
pub struct OpaqueCause(pub Rc<Cell<u8>>);
pub type State<'a> = StateOf<
    Stage<'a>,
    &'static str,
    (),
    Parser,
    OpaqueResult,
    OpaqueCause,
    demlik_tea::PlainData,
    AgentTurn,
>;

pub struct Parser;
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
pub fn canonical<'a>(label: Cow<'a, str>) -> Rc<State<'a>> {
    let parser = Rc::new(Parser);
    let llm = Rc::new(LlmCall::new(
        llm_call::Config::new(move |_: &&str| Rc::clone(&parser)),
        |_: &Infallible| Ok("unreachable".into()),
    ));
    let agent = create_agent(AgentConfig::new(
        llm,
        vec![Rc::new(Stage {
            label,
            marker: Rc::new(Cell::new(7)),
        })],
        |_| "invoice",
        |_| ToolCommand,
        |_, _: &Rc<Conversation<OpaqueResult, AgentTurn, OpaqueCause>>, _| (),
        |turn: &AgentTurn| turn,
    ));
    agent.init()
}

demlik_tea::messages! { pub enum Msg { Keep } }
pub enum NoCommand {}
impl Tagged for NoCommand {
    fn tag(&self) -> &str {
        match *self {}
    }
}
impl CommandFamily for NoCommand {
    type Msg = Msg;
    type Completion = ();
    fn settle(self, _: (), _: f64) -> Result<Vec<Msg>, CommandContractError> {
        match self {}
    }
}
