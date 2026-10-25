use demlik_tea::{
    PlainData, Tagged,
    command::{CmdDef, CommandFamily, DecodedInput, InputFields, Outcome},
    data::{JsText, NumberOrNull, decode_json, plain_data},
    idempotency::intake::{
        ProcessInput, ProcessSpec, ReplayInput, intake_process_def, intake_replay_def,
    },
    persistence::snapshot::{SnapshotWriteInput, snapshot_write_def},
    work_queue::QueueField,
};
use std::{cell::Cell, rc::Rc};
fn text(fields: &mut InputFields, name: &str) -> Result<JsText, &'static str> {
    match fields.take(name) {
        Some(PlainData::String(v)) => Ok(v),
        _ => Err("expected text"),
    }
}
fn process(raw: PlainData) -> Result<DecodedInput<ProcessInput<PlainData>>, &'static str> {
    let mut fields = InputFields::try_from(raw).map_err(|_| "expected record")?;
    let key = text(&mut fields, "key")?;
    let item_id = text(&mut fields, "itemId")?;
    let payload = Rc::new(fields.take("payload").unwrap_or(PlainData::Undefined));
    Ok(fields.finish(ProcessInput {
        key,
        item_id,
        payload,
    }))
}
#[test]
fn caller_decoding_preserves_unknown_order_utf16_and_missing_versus_undefined() {
    let def = intake_process_def::<PlainData>();
    let raw=decode_json(r#"{"extra":4,"key":"k","payload":null,"itemId":"i","__proto__":{"own":true},"\ud800":"kept"}"#).unwrap();
    let cmd = def.decode_input(raw, process).unwrap();
    assert_eq!(
        serde_json::to_string(&cmd).unwrap(),
        r#"{"extra":4,"key":"k","payload":null,"itemId":"i","__proto__":{"own":true},"\ud800":"kept","type":"intake:process"}"#
    );
    assert!(cmd.fields().unwrap().has_own("payload"));
    assert!(!cmd.fields().unwrap().remaining().contains_key("payload"));
    let raw = decode_json(r#"{"key":"k","itemId":"i"}"#).unwrap();
    let cmd = def.decode_input(raw, process).unwrap();
    assert!(!cmd.fields().unwrap().has_own("payload"));
    assert_eq!(
        serde_json::to_string(&cmd).unwrap(),
        r#"{"key":"k","itemId":"i","type":"intake:process"}"#
    );
    let mut raw = match decode_json(r#"{"key":"k","itemId":"i"}"#).unwrap() {
        PlainData::Object(v) => v,
        _ => unreachable!(),
    };
    raw.insert("payload".into(), PlainData::Undefined);
    let cmd = def.decode_input(PlainData::Object(raw), process).unwrap();
    let PlainData::Object(projected) = plain_data(&cmd).unwrap() else {
        panic!("record")
    };
    assert!(matches!(
        projected.get("payload"),
        Some(PlainData::Undefined)
    ));
    assert!(cmd.fields().unwrap().has_own("payload"));
}
struct Opaque {
    value: Cell<u32>,
    _capability: Box<dyn Fn()>,
}
struct Cause {
    _capability: Box<dyn Fn()>,
}
#[test]
fn decoder_has_no_payload_or_cause_bounds_and_retains_named_family_settlement() {
    let value = Rc::new(Opaque {
        value: Cell::new(1),
        _capability: Box::new(|| {}),
    });
    let cause = Rc::new(Cause {
        _capability: Box::new(|| {}),
    });
    let def = CmdDef::<ProcessSpec<Opaque>>::named("owned intake");
    let failed = def.decode_input((), |()| {
        Err::<DecodedInput<ProcessInput<Opaque>>, _>(Rc::clone(&cause))
    });
    assert!(matches!(failed,Err(ref e) if Rc::ptr_eq(e,&cause)));
    let cmd = def
        .decode_input(Rc::clone(&value), |payload| {
            Ok::<_, Rc<Cause>>(DecodedInput::new(ProcessInput {
                key: "k".into(),
                item_id: "i".into(),
                payload,
            }))
        })
        .unwrap_or_else(|_| panic!("decode"));
    assert!(Rc::ptr_eq(&cmd.input().payload, &value));
    value.value.set(7);
    let messages =
        CommandFamily::settle(cmd, Some(Outcome::ok(PlainData::Undefined)), 17.25).unwrap();
    assert_eq!(messages[0].tag(), "owned intake_ok");
    assert_eq!(messages[0].cmd().input().payload.value.get(), 7);
    assert!(Rc::ptr_eq(&messages[0].cmd().input().payload, &value));
}
#[test]
fn replay_presence_and_snapshot_nullable_fields_use_the_same_record_owner() {
    for present in [false, true] {
        let mut raw = match decode_json(r#"{"key":"k","other":null}"#).unwrap() {
            PlainData::Object(v) => v,
            _ => unreachable!(),
        };
        if present {
            raw.insert("result".into(), PlainData::Undefined);
        }
        let cmd = intake_replay_def::<PlainData>()
            .decode_input(PlainData::Object(raw), |raw| {
                let mut fields = InputFields::try_from(raw).map_err(|_| "record")?;
                let key = text(&mut fields, "key")?;
                let result = match fields.take("result") {
                    None => QueueField::Absent,
                    Some(PlainData::Undefined) => QueueField::Undefined,
                    Some(v) => QueueField::Value(Rc::new(v)),
                };
                Ok::<_, &str>(fields.finish(ReplayInput { key, result }))
            })
            .unwrap();
        let PlainData::Object(record) = plain_data(&cmd).unwrap() else {
            panic!("record")
        };
        assert_eq!(record.contains_key("result"), present);
    }
    let cmd = snapshot_write_def::<PlainData>()
        .decode_input(
            decode_json(r#"{"key":"k","seq":null,"at":null,"payload":2,"extra":true}"#).unwrap(),
            |raw| {
                let mut fields = InputFields::try_from(raw).map_err(|_| "record")?;
                let key = text(&mut fields, "key")?;
                assert!(matches!(fields.take("seq"), Some(PlainData::Null)));
                assert!(matches!(fields.take("at"), Some(PlainData::Null)));
                let payload = Rc::new(fields.take("payload").unwrap());
                Ok::<_, &str>(fields.finish(SnapshotWriteInput {
                    key,
                    seq: NumberOrNull(None),
                    at: NumberOrNull(None),
                    payload,
                }))
            },
        )
        .unwrap();
    assert_eq!(
        serde_json::to_value(&cmd).unwrap()["seq"],
        serde_json::Value::Null
    );
    assert_eq!(serde_json::to_value(&cmd).unwrap()["extra"], true);
}
#[test]
fn unconsumed_typed_fields_refuse_projection_instead_of_discarding_either_value() {
    let cmd = intake_process_def::<PlainData>()
        .decode_input(decode_json(r#"{"key":"raw"}"#).unwrap(), |raw| {
            let fields = InputFields::try_from(raw).map_err(|_| "record")?;
            Ok::<_, &str>(fields.finish(ProcessInput {
                key: "typed".into(),
                item_id: "i".into(),
                payload: Rc::new(PlainData::Null),
            }))
        })
        .unwrap();
    assert!(
        serde_json::to_string(&cmd)
            .unwrap_err()
            .to_string()
            .contains("unconsumed")
    );
}
