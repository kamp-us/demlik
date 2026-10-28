use demlik_tea::{Step, TryUpdate};
use std::convert::Infallible;
demlik_tea::tool_router! { mod tools {} }
demlik_tea::messages! { enum Other { Kept } }
fn main() {
    let update = TryUpdate::try_reducer_with_types(
        tools::Router::new().unwrap().settlement_types(),
        |_: &(), _: &tools::Messages| Ok::<_, Infallible>(Step::<_, ()>::new((), vec![])),
    );
    let _ = update.try_apply(&(), &Other::Kept);
}
