#![allow(dead_code)]
use demlik_tea::{
    Machine, Step, Tagged, TryUpdate,
    command::{CommandContractError, CommandFamily},
    core::try_subscriptions,
    data::Sub,
    runtime::{self, NoEvent, NoInterpreter, NoSubscriptions, Options, Profile},
};
use std::{cell::Cell, convert::Infallible, rc::Rc};
struct Opaque<'a> {
    label: &'a str,
    marker: Cell<u8>,
}
struct Model;
impl Tagged for Model {
    fn tag(&self) -> &str {
        "model"
    }
}
demlik_tea::messages! { enum Msg { Tick } }
enum Cmd {}
impl Tagged for Cmd {
    fn tag(&self) -> &str {
        match *self {}
    }
}
impl CommandFamily for Cmd {
    type Msg = Msg;
    type Completion = ();
    fn settle(self, _: (), _: f64) -> Result<Vec<Msg>, CommandContractError> {
        match self {}
    }
}
fn main() {
    let label = String::from("borrowed actor cause");
    let cause = Rc::new(Opaque {
        label: &label,
        marker: Cell::new(1),
    });
    let machine: Machine<'_, Model, Msg, Cmd, Sub<()>, (), Rc<Opaque<'_>>> = Machine {
        init: Box::new(|_, _| Step::new(Model, vec![])),
        update: TryUpdate::try_reducer(|_, _| Ok(Step::new(Model, vec![]))),
        subscriptions: try_subscriptions(move |_: &Model| Err(Rc::clone(&cause))),
    };
    let options: Options<Model, Msg, Infallible, Infallible, NoEvent, Rc<Opaque<'_>>> =
        Options::new(Profile::Promise);
    let _ = runtime::try_launch(
        machine,
        (),
        NoInterpreter::new(),
        NoSubscriptions::new(),
        options,
    );
}
