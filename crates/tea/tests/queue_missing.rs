use demlik_tea::{PlainData, work_queue::Queue};
use serde::Deserialize;
const MISSING: &str = r#"[{"id":"stage:0","status":"running","enqueuedAt":0,"startedAt":0}]"#;

#[test]
fn a_reloaded_undefined_stage_keeps_its_missing_input_property() {
    let queue: Queue<PlainData> = serde_json::from_str(MISSING).unwrap();
    assert!(matches!(
        queue.get(0).unwrap().input.as_ref(),
        PlainData::Undefined
    ));
    assert_eq!(serde_json::to_string(&queue).unwrap(), MISSING);
    let reset = demlik_tea::work_queue::reset_running_op(&queue).next;
    let claimed = demlik_tea::work_queue::claim_next_op(&reset, 100.0).unwrap();
    assert!(matches!(
        claimed.claimed.input.as_ref(),
        PlainData::Undefined
    ));
    assert!(
        serde_json::to_value(&claimed.next).unwrap()[0]
            .get("input")
            .is_none()
    );
    assert!(
        demlik_tea::work_queue::mark_done_op(&claimed.next, "stage:0")
            .next
            .is_empty()
    );
}
#[derive(Deserialize)]
struct Opaque {
    _id: u32,
}
#[test]
fn an_opaque_input_cannot_be_silently_defaulted_or_changed_to_json_null() {
    assert!(serde_json::from_str::<Queue<Opaque>>(MISSING).is_err());
    assert!(serde_json::from_str::<Queue<String>>(MISSING).is_err());
    assert!(serde_json::from_str::<Queue<serde_json::Value>>(MISSING).is_err());
    let null = r#"[{"id":"stage:0","status":"running","input":null,"enqueuedAt":0,"startedAt":0}]"#;
    let queue: Queue<PlainData> = serde_json::from_str(null).unwrap();
    assert!(matches!(
        queue.get(0).unwrap().input.as_ref(),
        PlainData::Null
    ));
    assert_eq!(serde_json::to_string(&queue).unwrap(), null);
}

struct CallerOwned;
impl<'de> Deserialize<'de> for CallerOwned {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Unit;
        impl<'de> serde::de::Visitor<'de> for Unit {
            type Value = CallerOwned;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("a payload-free stage")
            }
            fn visit_unit<E: serde::de::Error>(self) -> Result<CallerOwned, E> {
                Ok(CallerOwned)
            }
        }
        deserializer.deserialize_unit(Unit)
    }
}
#[test]
fn a_caller_owned_decoder_can_explicitly_accept_the_absence() {
    let queue: Queue<CallerOwned> = serde_json::from_str(MISSING).unwrap();
    assert_eq!(queue.len(), 1);
}

#[test]
fn ordinary_json_null_and_marker_shaped_records_stay_ordinary_json() {
    assert!(matches!(
        serde_json::from_str::<PlainData>("null").unwrap(),
        PlainData::Null
    ));
    assert!(matches!(
        serde_json::from_value::<PlainData>(serde_json::Value::Null).unwrap(),
        PlainData::Null
    ));
    let value = serde_json::from_str::<PlainData>(r#"{"$demlik::Undefined":true}"#).unwrap();
    assert!(
        matches!(value,PlainData::Object(fields) if matches!(fields.get("$demlik::Undefined"),Some(PlainData::Bool(true))))
    );
}
