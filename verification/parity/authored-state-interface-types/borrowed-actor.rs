mod canonical;
use canonical::{Msg, NoCommand, State, canonical};
use demlik_tea::{
    Machine, Step, Update,
    core::subscriptions,
    data::Sub,
    runtime::{self, NoInterpreter, NoSubscriptions, Options, Profile},
};
use std::{borrow::Cow, convert::Infallible, rc::Rc};
fn main() {
    let label = String::from("borrowed invoice");
    let state: Rc<State<'_>> = canonical(Cow::Borrowed(&label));
    let machine: Machine<'_, Rc<State<'_>>, Msg, NoCommand, Sub<()>> = Machine {
        init: Box::new(move |loaded, _| {
            Step::new(loaded.unwrap_or_else(|| Rc::clone(&state)), vec![])
        }),
        update: Update::reducer(|state, _| Step::new(Rc::clone(state), vec![])),
        subscriptions: subscriptions(|_| vec![]),
    };
    let options: Options<Rc<State<'_>>, Msg, Infallible, Infallible> =
        Options::new(Profile::Promise);
    let _ = runtime::try_launch(
        machine,
        (),
        NoInterpreter::new(),
        NoSubscriptions::new(),
        options,
    );
}
