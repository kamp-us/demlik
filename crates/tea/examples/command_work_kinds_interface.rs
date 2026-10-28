use demlik_tea::runtime::CommandWork;
use std::cell::Cell;
fn main() {
    let calls = Cell::new(0);
    let work = CommandWork::promise(|_| {
        calls.set(calls.get() + 1);
        async { Ok::<(), ()>(()) }
    });
    assert_eq!(calls.get(), 0);
    drop(work);
    assert_eq!(calls.get(), 0);
    println!("lazy factory construction and drop: true");
}
