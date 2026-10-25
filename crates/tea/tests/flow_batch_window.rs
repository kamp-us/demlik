use demlik_tea::{
    Tagged,
    flow::batch_window::{
        BatchWindowConfig, add_item, init_batch_window, on_window, subs_for, timer_for,
    },
};
use std::rc::Rc;
struct Item(u32);
struct Flush(Rc<Vec<Rc<Item>>>);
impl Tagged for Flush {
    fn tag(&self) -> &str {
        "flush"
    }
}
#[test]
fn size_flush_keeps_arrival_order_and_old_window_anchor_then_ignores_a_stale_expiry() {
    let config = BatchWindowConfig::new(3.0, 1000.0, |items: &Rc<Vec<Rc<Item>>>| {
        Flush(Rc::clone(items))
    });
    let first = add_item(&config, &init_batch_window(), Rc::new(Item(30)), 100.0);
    let second = add_item(&config, &first.state, Rc::new(Item(10)), 110.0);
    assert_eq!(second.state.opened_at, Some(100.0));
    let deadline = timer_for(&config, &second.state, None).unwrap();
    assert_eq!(deadline.ms, 1000.0);
    assert_eq!(deadline.msg.at_ms, 1100.0);
    assert_eq!(subs_for(&config, &second.state, None)[0].at_ms, 1100.0);
    let flushed = add_item(&config, &second.state, Rc::new(Item(20)), 120.0);
    assert_eq!(flushed.commands.len(), 1);
    assert_eq!(
        flushed.commands[0]
            .0
            .iter()
            .map(|i| i.0)
            .collect::<Vec<_>>(),
        vec![30, 10, 20]
    );
    assert!(flushed.state.buffer.is_empty());
    assert_eq!(flushed.state.opened_at, None);
    assert_eq!(second.state.buffer.len(), 2);
    assert_eq!(second.state.opened_at, Some(100.0));
    let stale = on_window(&config, &flushed.state, 1100.0);
    assert!(Rc::ptr_eq(&stale.state, &flushed.state));
    assert!(stale.commands.is_empty());
    assert!(timer_for(&config, &stale.state, None).is_none());
}

#[test]
fn the_bound_window_flushes_nonempty_data_even_before_its_deadline_and_nan_disables_only_the_size_trigger()
 {
    use demlik_tea::flow::batch_window::create_batch_window;
    let window = create_batch_window(BatchWindowConfig::new(
        f64::NAN,
        1000.0,
        |items: &Rc<Vec<Rc<Item>>>| Flush(Rc::clone(items)),
    ));
    let opened = window.add(&window.init(), Rc::new(Item(7)), 100.0);
    let buffered = window.add(&opened.state, Rc::new(Item(8)), 101.0);
    assert!(buffered.commands.is_empty());
    assert_eq!(
        window.timer(&buffered.state, None).unwrap().msg.at_ms,
        1100.0
    );
    let flushed = window.on_window(&buffered.state, 102.0);
    assert_eq!(flushed.commands.len(), 1);
    assert!(Rc::ptr_eq(&flushed.commands[0].0, &buffered.state.buffer));
    assert_eq!(
        flushed.commands[0]
            .0
            .iter()
            .map(|item| item.0)
            .collect::<Vec<_>>(),
        vec![7, 8]
    );
    assert!(window.subs(&flushed.state, None).is_empty());
}
