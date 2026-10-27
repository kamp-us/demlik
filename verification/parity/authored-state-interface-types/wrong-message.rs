mod canonical;
use canonical::{Msg, State, canonical};
use demlik_tea::{Step, TryUpdate};
use std::{borrow::Cow, convert::Infallible, rc::Rc};
demlik_tea::messages! { enum Other { Keep } }
fn main() {
    let state: Rc<State<'static>> = canonical(Cow::Owned("invoice".into()));
    let update: TryUpdate<'_, Rc<State<'static>>, Msg, (), Infallible> =
        TryUpdate::try_reducer(|state, _| Ok(Step::new(Rc::clone(state), vec![])));
    let _ = update.try_apply(&state, &Other::Keep);
}
