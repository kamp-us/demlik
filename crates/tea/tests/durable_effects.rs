use demlik_tea::durable_effects::{
    EffectLedgerEvent, LedgerRestore, fold_ledger, pending_effects_ledger, surviving_effects,
};
use std::rc::Rc;

struct Effect {
    label: &'static str,
    _local: Rc<()>,
}
#[test]
fn restoring_all_confirmed_events_still_allocates_after_the_last_issued_id() {
    let recorder = pending_effects_ledger(LedgerRestore::default());
    let first = recorder.owe(Rc::new(Effect {
        label: "first",
        _local: Rc::new(()),
    }));
    let second = recorder.owe(Rc::new(Effect {
        label: "second",
        _local: Rc::new(()),
    }));
    assert_eq!(first.id.number(), Some(1.0));
    assert_eq!(second.id.number(), Some(2.0));
    let before = recorder.ledger();
    let confirmed_first = recorder.confirm(first.id);
    let confirmed_second = recorder.confirm(second.id);
    assert!(confirmed_first.confirmed && confirmed_second.confirmed);
    assert_eq!(before.len(), 2);
    assert_eq!(before.get(first.id).unwrap().label, "first");
    let events = vec![
        first.event,
        second.event,
        confirmed_first.event,
        confirmed_second.event,
    ];
    assert!(surviving_effects(&fold_ledger(&events)).is_empty());
    let restored = pending_effects_ledger(LedgerRestore::from_events(events));
    let third = restored.owe(Rc::new(Effect {
        label: "third",
        _local: Rc::new(()),
    }));
    assert_eq!(third.id.number(), Some(3.0));
    assert_eq!(restored.surviving()[0].effect.label, "third");
    let EffectLedgerEvent::Owed(owed) = third.event.as_ref() else {
        panic!("owed event")
    };
    assert!(Rc::ptr_eq(&owed.effect, &restored.surviving()[0].effect));
    let unknown = restored.confirm(99.0.into());
    assert!(!unknown.confirmed);
    assert_eq!(restored.surviving().len(), 1);
}

#[test]
fn ledger_keys_follow_map_same_value_zero_and_preserve_overwrite_order() {
    use demlik_tea::durable_effects::{
        DeliveryId, EffectConfirmed, EffectOwed, apply_effect_event, is_owed,
    };
    let owed = |id: DeliveryId, label| {
        Rc::new(EffectLedgerEvent::Owed(EffectOwed::new(
            id,
            Rc::new(Effect {
                label,
                _local: Rc::new(()),
            }),
        )))
    };
    let events = [
        owed((-0.0).into(), "zero"),
        owed(f64::NAN.into(), "old"),
        owed(2.0.into(), "two"),
        owed(f64::NAN.into(), "new"),
        owed(DeliveryId(None), "null"),
    ];
    let ledger = fold_ledger(&events);
    assert_eq!(ledger.len(), 4);
    let survivors = surviving_effects(&ledger);
    assert_eq!(
        survivors
            .iter()
            .map(|owed| owed.effect.label)
            .collect::<Vec<_>>(),
        vec!["zero", "new", "two", "null"]
    );
    assert!(!survivors[0].id.number().unwrap().is_sign_negative());
    assert!(is_owed(&ledger, f64::NAN.into()));
    assert_eq!(ledger.get(f64::NAN.into()).unwrap().label, "new");
    let next = apply_effect_event(
        &ledger,
        &EffectLedgerEvent::Confirmed(EffectConfirmed {
            id: f64::NAN.into(),
        }),
    );
    assert_eq!(ledger.len(), 4);
    assert_eq!(next.len(), 3);
    assert!(!is_owed(&next, f64::NAN.into()));
    assert!(is_owed(&next, 0.0.into()));
    assert!(is_owed(&next, DeliveryId(None)));
}

#[test]
fn an_explicit_null_counter_overrides_history_and_an_omitted_effect_roundtrips_as_undefined() {
    use demlik_tea::{
        PlainData,
        data::{plain_data, stringify_json},
        durable_effects::{DeliveryId, EffectConfirmed},
        work_queue::QueueField,
    };
    let confirmed = Rc::new(EffectLedgerEvent::<PlainData>::Confirmed(EffectConfirmed {
        id: 40.0.into(),
    }));
    let restored = pending_effects_ledger(LedgerRestore {
        events: vec![confirmed],
        last_id: QueueField::Value(DeliveryId(None)),
    });
    assert_eq!(
        restored.owe(Rc::new(PlainData::Null)).id.number(),
        Some(1.0)
    );
    let encoded = r#"{"type":"effect_owed","id":null}"#;
    let restored: EffectLedgerEvent<PlainData> = serde_json::from_str(encoded).unwrap();
    let EffectLedgerEvent::Owed(owed) = &restored else {
        panic!("owed event")
    };
    assert!(!owed.effect_present());
    assert!(matches!(owed.effect.as_ref(), PlainData::Undefined));
    assert_eq!(
        stringify_json(&plain_data(&restored).unwrap()).unwrap(),
        encoded
    );
    let surviving = surviving_effects(&fold_ledger([Rc::new(restored)]));
    let PlainData::Object(record) = plain_data(&surviving[0]).unwrap() else {
        panic!("surviving record")
    };
    assert!(matches!(record.get("effect"), Some(PlainData::Undefined)));
    assert!(serde_json::from_str::<EffectLedgerEvent<String>>(encoded).is_err());
    let null: EffectLedgerEvent<PlainData> =
        serde_json::from_str(r#"{"type":"effect_owed","id":1,"effect":null}"#).unwrap();
    let EffectLedgerEvent::Owed(owed) = null else {
        panic!("owed null")
    };
    assert!(owed.effect_present());
    assert!(matches!(owed.effect.as_ref(), PlainData::Null));
}
