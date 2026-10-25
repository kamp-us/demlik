use demlik_tea::persistence::recorder::{Recorder, RecorderOptions, StateKind};
use std::{
    cell::{Cell, RefCell},
    rc::Rc,
    sync::Arc,
};
struct State<'a> {
    label: &'a str,
    shared: Rc<Cell<u32>>,
}
struct Msg<'a> {
    label: &'a str,
    shared: Rc<Cell<u32>>,
}
#[allow(
    clippy::arc_with_non_send_sync,
    reason = "The recorder retains the local Runtime original Arc values without Send or value Clone."
)]
#[test]
fn opaque_borrowed_values_are_shared_but_dump_arrays_and_outer_values_are_independent() {
    let label = String::from("borrowed");
    let shared = Rc::new(Cell::new(7));
    let rec = Recorder::new(RecorderOptions {
        capture_steps: true,
        ..Default::default()
    });
    assert!(rec.dump().is_err());
    let boot = Arc::new(State {
        label: &label,
        shared: shared.clone(),
    });
    rec.record_boot(boot.clone());
    let first = Arc::new(Msg {
        label: &label,
        shared: shared.clone(),
    });
    let a = Arc::new(State {
        label: &label,
        shared: shared.clone(),
    });
    rec.record_step(first.clone(), a.clone());
    let second = Arc::new(Msg {
        label: &label,
        shared: shared.clone(),
    });
    let b = Arc::new(State {
        label: &label,
        shared: shared.clone(),
    });
    rec.record_step(second.clone(), b.clone());
    let mut one = rec.dump().unwrap();
    let two = rec.dump().unwrap();
    assert!(Arc::ptr_eq(one.loaded.as_ref().unwrap(), &boot));
    assert!(Arc::ptr_eq(&one.final_state, &b));
    assert_ne!(one.msgs.as_ptr(), two.msgs.as_ptr());
    assert!(Arc::ptr_eq(&one.msgs[0], &first));
    assert!(Arc::ptr_eq(&one.msgs[1], &second));
    let steps = one.steps.as_ref().unwrap();
    assert!(Arc::ptr_eq(&steps[0].msg, &first));
    assert!(Arc::ptr_eq(&steps[0].state, &a));
    assert!(Arc::ptr_eq(&steps[1].state, &b));
    one.msgs.clear();
    one.steps.as_mut().unwrap().clear();
    assert_eq!(rec.dump().unwrap().msgs.len(), 2);
    assert_eq!(rec.dump().unwrap().steps.unwrap().len(), 2);
    shared.set(9);
    assert_eq!(two.final_state.shared.get(), 9);
    assert_eq!(two.msgs[0].shared.get(), 9);
    assert_eq!(two.final_state.label, "borrowed");
    assert_eq!(two.msgs[0].label, "borrowed");
    rec.stop();
    rec.stop();
    rec.record_step(first, boot);
    assert_eq!(rec.dump().unwrap().msgs.len(), 2);
}
#[test]
fn dropped_samples_still_advance_final_state_and_rate_one_never_reads_rng() {
    let calls = Cell::new(0);
    let samples = [0.1, 0.5, f64::NAN, 0.9];
    let rec = Recorder::with_rng(
        RecorderOptions {
            sample_rate: Some(0.5),
            capture_steps: true,
        },
        || {
            let i = calls.get();
            calls.set(i + 1);
            samples[i]
        },
    );
    rec.record_boot(Arc::new(0_u32));
    for value in 1..=4 {
        rec.record_step(Arc::new(value), Arc::new(value));
    }
    let trace = rec.dump().unwrap();
    assert_eq!(*trace.final_state, 4);
    assert_eq!(
        trace.msgs.iter().map(|x| **x).collect::<Vec<_>>(),
        vec![1, 3]
    );
    assert_eq!(
        trace
            .steps
            .unwrap()
            .iter()
            .map(|step| *step.state)
            .collect::<Vec<_>>(),
        vec![1, 3]
    );
    assert_eq!(calls.get(), 4);
    for rate in [
        None,
        Some(f64::NAN),
        Some(-1.0),
        Some(0.0),
        Some(-0.0),
        Some(1.0),
        Some(2.0),
        Some(f64::INFINITY),
        Some(f64::NEG_INFINITY),
    ] {
        let rec = Recorder::with_rng(
            RecorderOptions {
                sample_rate: rate,
                capture_steps: false,
            },
            || panic!("full-rate recorder cannot read RNG"),
        );
        rec.record_boot(Arc::new(0));
        rec.record_step(Arc::new(1), Arc::new(1));
        let trace = rec.dump().unwrap();
        assert_eq!(trace.msgs.len(), 1);
        assert!(trace.steps.is_none());
    }
}
#[test]
fn boot_anchor_and_optional_steps_keep_null_and_undefined_boundary_classification() {
    use demlik_tea::PlainData;
    fn kind(value: &PlainData) -> StateKind {
        match value {
            PlainData::Null => StateKind::Null,
            PlainData::Undefined => StateKind::Undefined,
            _ => StateKind::Value,
        }
    }
    let rec = Recorder::with_state_kind(RecorderOptions::default(), || 0.0, kind);
    rec.record_step(Arc::new(1), Arc::new(PlainData::Number(1.0)));
    assert!(rec.dump().unwrap().loaded.is_none());
    rec.record_boot(Arc::new(PlainData::Null));
    let null = rec.dump().unwrap();
    assert!(null.loaded.is_none());
    assert!(matches!(null.final_state.as_ref(), PlainData::Null));
    rec.record_boot(Arc::new(PlainData::Undefined));
    assert!(rec.dump().is_err());
    rec.record_step(Arc::new(2), Arc::new(PlainData::Bool(true)));
    assert!(matches!(
        rec.dump().unwrap().loaded.as_deref(),
        Some(PlainData::Undefined)
    ));
    rec.record_step(Arc::new(3), Arc::new(PlainData::Undefined));
    assert!(rec.dump().is_err());
    let captured = Recorder::<u32, u32>::new(RecorderOptions {
        capture_steps: true,
        ..Default::default()
    });
    captured.record_boot(Arc::new(0));
    assert_eq!(captured.dump().unwrap().steps.unwrap().len(), 0);
}
#[test]
fn sampler_reentry_records_inner_then_outer_and_keeps_the_latest_observed_state() {
    type Handle = Recorder<'static, u32, u32>;
    let slot: Rc<RefCell<Option<std::rc::Weak<Handle>>>> = Rc::new(RefCell::new(None));
    let calls = Rc::new(Cell::new(0));
    let (inside_slot, inside_calls) = (slot.clone(), calls.clone());
    let rec = Rc::new(Recorder::with_rng(
        RecorderOptions {
            sample_rate: Some(0.5),
            capture_steps: true,
        },
        move || {
            let call = inside_calls.get() + 1;
            inside_calls.set(call);
            if call == 1 {
                inside_slot
                    .borrow()
                    .as_ref()
                    .unwrap()
                    .upgrade()
                    .unwrap()
                    .record_step(Arc::new(2), Arc::new(2));
            }
            0.1
        },
    ));
    *slot.borrow_mut() = Some(Rc::downgrade(&rec));
    rec.record_boot(Arc::new(0));
    rec.record_step(Arc::new(1), Arc::new(1));
    let trace = rec.dump().unwrap();
    assert_eq!(
        trace.msgs.iter().map(|x| **x).collect::<Vec<_>>(),
        vec![2, 1]
    );
    assert_eq!(*trace.final_state, 2);
    assert_eq!(calls.get(), 2);
    slot.borrow_mut().take();
}
