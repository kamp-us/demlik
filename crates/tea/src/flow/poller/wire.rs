use super::*;
use crate::data::{JsonData, plain_data};
use serde::{Deserialize, Serialize};
type Record = indexmap::IndexMap<JsText, PlainData>;
fn value<T: Serialize + ?Sized, E: serde::ser::Error>(value: &T) -> Result<PlainData, E> {
    plain_data(value).map_err(E::custom)
}
fn slot<T: Serialize, E: serde::ser::Error>(
    record: &mut Record,
    key: &str,
    field: &QueueField<T>,
) -> Result<(), E> {
    match field {
        QueueField::Absent => {}
        QueueField::Undefined => {
            record.insert(key.into(), PlainData::Undefined);
        }
        QueueField::Value(inner) => {
            record.insert(key.into(), value::<_, E>(inner)?);
        }
    }
    Ok(())
}
impl<F: Serialize> Serialize for PollerRetry<F> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut record = Record::new();
        record.insert("attempt".into(), value::<_, S::Error>(&self.attempt)?);
        slot::<_, S::Error>(&mut record, "lastError", &self.last_error)?;
        slot::<_, S::Error>(&mut record, "firstFailureAtMs", &self.first_failure_at_ms)?;
        JsonData(&PlainData::Object(record)).serialize(serializer)
    }
}
impl<'de, F: Deserialize<'de>> Deserialize<'de> for PollerRetry<F> {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", bound(deserialize = "F:Deserialize<'de>"))]
        struct Raw<F> {
            attempt: PollerNumber,
            #[serde(default)]
            last_error: QueueField<Rc<F>>,
            #[serde(default)]
            first_failure_at_ms: QueueField<PollerNumber>,
        }
        let raw = Raw::deserialize(deserializer)?;
        Ok(Self {
            attempt: raw.attempt,
            last_error: raw.last_error,
            first_failure_at_ms: raw.first_failure_at_ms,
        })
    }
}
impl<R: Serialize, F: Serialize> Serialize for PollerState<R, F> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut record = Record::new();
        record.insert(
            "phase".into(),
            PlainData::String(self.phase.as_str().into()),
        );
        record.insert("tick".into(), value::<_, S::Error>(&self.tick)?);
        slot::<_, S::Error>(&mut record, "lastResult", &self.last_result)?;
        record.insert("retry".into(), value::<_, S::Error>(&self.retry)?);
        if let PollerPhase::Polling { next_at_ms } = &self.phase {
            record.insert("nextAtMs".into(), value::<_, S::Error>(next_at_ms)?);
        }
        record.insert("dedupe".into(), value::<_, S::Error>(&self.dedupe)?);
        JsonData(&PlainData::Object(record)).serialize(serializer)
    }
}
impl<'de, R: Deserialize<'de>, F: Deserialize<'de>> Deserialize<'de> for PollerState<R, F> {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(
            rename_all = "camelCase",
            bound(deserialize = "R:Deserialize<'de>,F:Deserialize<'de>")
        )]
        struct Raw<R, F> {
            phase: String,
            tick: PollerNumber,
            #[serde(default)]
            last_result: QueueField<Rc<R>>,
            retry: Rc<PollerRetry<F>>,
            #[serde(default)]
            next_at_ms: QueueField<PollerNumber>,
            dedupe: Rc<IdempotencyStore<bool>>,
        }
        let raw = Raw::deserialize(deserializer)?;
        let phase = match raw.phase.as_str() {
            "polling" => PollerPhase::Polling {
                next_at_ms: match raw.next_at_ms {
                    QueueField::Value(value) => value,
                    _ => return Err(serde::de::Error::missing_field("nextAtMs")),
                },
            },
            "done" => PollerPhase::Done,
            "gave_up" => PollerPhase::GaveUp,
            other => {
                return Err(serde::de::Error::unknown_variant(
                    other,
                    &["polling", "done", "gave_up"],
                ));
            }
        };
        Ok(Self {
            phase,
            tick: raw.tick,
            last_result: raw.last_result,
            retry: raw.retry,
            dedupe: raw.dedupe,
        })
    }
}
