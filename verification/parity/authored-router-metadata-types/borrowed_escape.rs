use demlik_tea::{Step, TryUpdate};
use std::{cell::Cell, convert::Infallible};
demlik_tea::messages! { enum Msg { Kept } }
fn main() {
    let update;
    {
        let marker = Cell::new(0);
        let original = &marker;
        update = TryUpdate::try_reducer_with_types(vec!["Kept".into()], move |_: &(), _: &Msg| {
            original.set(original.get() + 1);
            Ok::<_, Infallible>(Step::<_, ()>::new((), vec![]))
        });
    }
    let _ = update.try_apply(&(), &Msg::Kept);
}
