use demlik_tea::{Step, TryUpdate};
use std::rc::Rc;
struct Cause;
demlik_tea::messages! { enum Msg { Rejected } }
fn main() {
    let _: TryUpdate<'_, (), Msg, (), Rc<Cause>> = TryUpdate::try_reducer_with_types(
        vec!["Rejected".into()],
        |_, _| -> Result<Step<(), ()>, _> { Err(String::from("cause replaced")) },
    );
}
