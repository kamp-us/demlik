use demlik_tea::data::JsText;
use demlik_tea::flow::fan_out::{FanOut, FanOutConfig};
use demlik_tea::work_queue::QueueItemStatus;
use std::{cell::Cell, rc::Rc};
struct Input {
    key: JsText,
    n: u32,
    _local: Rc<()>,
}
struct Reply(u32);
struct Failure;
struct Launch(Rc<Input>);
impl demlik_tea::Tagged for Launch {
    fn tag(&self) -> &str {
        "launch"
    }
}
#[test]
fn settling_a_duplicate_id_closes_one_item_and_backfills_one_slot_without_mutating_the_prior_slice()
{
    let fan: FanOut<'_, Input, Reply, Launch, Failure> = FanOut::new(FanOutConfig::new(
        2.0,
        |item: &Input| item.key.clone(),
        |item: &Rc<Input>| Launch(Rc::clone(item)),
    ));
    let initial = fan.init();
    let a = Rc::new(Input {
        key: "dup".into(),
        n: 1,
        _local: Rc::new(()),
    });
    let b = Rc::new(Input {
        key: "dup".into(),
        n: 2,
        _local: Rc::new(()),
    });
    let c = Rc::new(Input {
        key: "next".into(),
        n: 3,
        _local: Rc::new(()),
    });
    let scattered = fan.scatter(&initial, [Rc::clone(&a), Rc::clone(&b), Rc::clone(&c)]);
    assert!(initial.items.is_empty());
    assert_eq!(
        scattered
            .commands
            .iter()
            .map(|cmd| cmd.0.n)
            .collect::<Vec<_>>(),
        vec![1, 2]
    );
    assert_eq!(
        scattered
            .state
            .items
            .iter()
            .map(|item| item.status)
            .collect::<Vec<_>>(),
        vec![
            QueueItemStatus::Running,
            QueueItemStatus::Running,
            QueueItemStatus::Pending
        ]
    );
    let settled = fan.item_ok(&scattered.state, &JsText::from("dup"), Rc::new(Reply(10)));
    assert_eq!(
        settled
            .state
            .running
            .iter()
            .map(|item| item.n)
            .collect::<Vec<_>>(),
        vec![2, 3]
    );
    assert_eq!(
        settled
            .commands
            .iter()
            .map(|cmd| cmd.0.n)
            .collect::<Vec<_>>(),
        vec![3]
    );
    assert_eq!(settled.state.done[0].result.0, 10);
    assert!(Rc::ptr_eq(&settled.state.done[0].item, &a));
    assert_eq!(
        settled
            .state
            .items
            .iter()
            .map(|item| item.status)
            .collect::<Vec<_>>(),
        vec![
            QueueItemStatus::Done,
            QueueItemStatus::Running,
            QueueItemStatus::Running
        ]
    );
    assert_eq!(scattered.state.running.len(), 2);
    assert!(scattered.state.done.is_empty());
    assert_eq!(
        scattered
            .state
            .items
            .iter()
            .map(|item| item.status)
            .collect::<Vec<_>>(),
        vec![
            QueueItemStatus::Running,
            QueueItemStatus::Running,
            QueueItemStatus::Pending
        ]
    );
}

enum Command {
    Launch(u32),
    Join(Vec<u32>),
}
impl demlik_tea::Tagged for Command {
    fn tag(&self) -> &str {
        match self {
            Self::Launch(_) => "launch",
            Self::Join(_) => "join",
        }
    }
}
struct DetailedFailure(Rc<Cell<u32>>);
#[test]
fn failed_items_release_slots_and_each_wave_joins_only_its_own_successes_once() {
    let fan: FanOut<'_, Input, Reply, Command, DetailedFailure> = FanOut::new(FanOutConfig::new(
        1.0,
        |input: &Input| input.key.clone(),
        |input: &Rc<Input>| Command::Launch(input.n),
    ))
    .with_join(|results: &[Rc<Reply>]| {
        Command::Join(results.iter().map(|reply| reply.0).collect())
    });
    let input = |key: &str, n| {
        Rc::new(Input {
            key: key.into(),
            n,
            _local: Rc::new(()),
        })
    };
    let state = fan
        .scatter(&fan.init(), [input("a", 1), input("b", 2)])
        .state;
    let failed = Rc::new(DetailedFailure(Rc::new(Cell::new(77))));
    let after = fan.item_err(&state, &"a".into(), Rc::clone(&failed));
    assert!(matches!(after.commands.as_slice(), [Command::Launch(2)]));
    assert!(Rc::ptr_eq(&after.state.failed[0].error, &failed));
    assert_eq!(after.state.failed[0].error.0.get(), 77);
    let done = fan.item_ok(&after.state, &"b".into(), Rc::new(Reply(20)));
    assert!(matches!(done.commands.as_slice(),[Command::Join(values)] if values==&vec![20]));
    assert!(done.state.joined);
    assert!(fan.is_complete(&done.state));
    let stale = fan.item_ok(&done.state, &"b".into(), Rc::new(Reply(999)));
    assert!(Rc::ptr_eq(&stale.state, &done.state));
    assert!(stale.commands.is_empty());
    let second = fan.scatter(&done.state, [input("c", 3)]);
    assert_eq!(second.state.wave_done_from, 1.0);
    assert_eq!(second.state.wave_failed_from, 1.0);
    assert!(!second.state.joined);
    let ended = fan.item_ok(&second.state, &"c".into(), Rc::new(Reply(30)));
    assert!(matches!(ended.commands.as_slice(),[Command::Join(values)] if values==&vec![30]));
    assert_eq!(
        ended
            .state
            .done
            .iter()
            .map(|entry| entry.result.0)
            .collect::<Vec<_>>(),
        vec![20, 30]
    );
}

#[test]
fn completion_uses_the_current_wave_and_repeated_observations_remain_observable() {
    use demlik_tea::flow::fan_out::FanOutPorts;
    let fan: FanOut<'_, Input, Reply, Launch> = FanOut::new(FanOutConfig::new(
        1.0,
        |item: &Input| item.key.clone(),
        |item: &Rc<Input>| Launch(Rc::clone(item)),
    ));
    let port = demlik_tea::ports::define_port("flow.fan-out.current-wave-results").unwrap();
    let complete = fan.completion(FanOutPorts { complete: port });
    let mut emitted = vec![];
    let initial = fan.init();
    complete.emit_on_complete(
        |_, results| emitted.push(results.iter().map(|r| r.0).collect::<Vec<_>>()),
        &initial,
    );
    assert!(emitted.is_empty());
    let started = fan.scatter(
        &initial,
        [Rc::new(Input {
            key: "x".into(),
            n: 1,
            _local: Rc::new(()),
        })],
    );
    let done = fan.item_ok(&started.state, &"x".into(), Rc::new(Reply(20)));
    complete.emit_on_complete(
        |_, results| emitted.push(results.iter().map(|r| r.0).collect::<Vec<_>>()),
        &done.state,
    );
    complete.emit_on_complete(
        |_, results| emitted.push(results.iter().map(|r| r.0).collect::<Vec<_>>()),
        &done.state,
    );
    let empty_wave = fan.scatter(&done.state, []);
    complete.emit_on_complete(
        |_, results| emitted.push(results.iter().map(|r| r.0).collect::<Vec<_>>()),
        &empty_wave.state,
    );
    assert_eq!(emitted, vec![vec![20], vec![20], vec![]]);
}
