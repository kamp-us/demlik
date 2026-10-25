use super::*;
use crate::data::{JsonData, plain_data};
use serde::{Deserialize, Serializer, de::DeserializeOwned};
use serde_json::value::RawValue;
type Record = indexmap::IndexMap<JsText, PlainData>;
type Completed<A, R> = Rc<Vec<Rc<CompletedStep<A, R>>>>;
fn value<T: Serialize + ?Sized, X: serde::ser::Error>(value: &T) -> Result<PlainData, X> {
    plain_data(value).map_err(X::custom)
}
fn field<T: Serialize, X: serde::ser::Error>(
    record: &mut Record,
    key: &str,
    field: &WorkflowValue<Rc<T>>,
) -> Result<(), X> {
    match field {
        WorkflowValue::Absent => {}
        WorkflowValue::Undefined => {
            record.insert(key.into(), PlainData::Undefined);
        }
        WorkflowValue::Value(inner) => {
            record.insert(key.into(), value::<_, X>(inner)?);
        }
    }
    Ok(())
}
fn render<S: Serializer>(record: Record, serializer: S) -> Result<S::Ok, S::Error> {
    JsonData(&PlainData::Object(record)).serialize(serializer)
}
impl<A: Serialize> Serialize for WorkflowStep<A> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut record = Record::new();
        record.insert("name".into(), PlainData::String(self.name.clone()));
        field::<_, S::Error>(&mut record, "activity", &self.activity)?;
        field::<_, S::Error>(&mut record, "compensation", &self.compensation)?;
        render(record, serializer)
    }
}
impl<'de, A: Deserialize<'de>> Deserialize<'de> for WorkflowStep<A> {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(bound(deserialize = "A:Deserialize<'de>"))]
        struct Raw<A> {
            name: JsText,
            #[serde(default)]
            activity: WorkflowValue<Rc<A>>,
            #[serde(default)]
            compensation: WorkflowValue<Rc<A>>,
        }
        let raw = Raw::deserialize(deserializer)?;
        Ok(Self {
            name: raw.name,
            activity: raw.activity,
            compensation: raw.compensation,
        })
    }
}
impl<A: Serialize, R: Serialize> Serialize for CompletedStep<A, R> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut record = Record::new();
        record.insert("step".into(), value::<_, S::Error>(&self.step)?);
        field::<_, S::Error>(&mut record, "result", &self.result)?;
        render(record, serializer)
    }
}
impl<'de, A: Deserialize<'de>, R: Deserialize<'de>> Deserialize<'de> for CompletedStep<A, R> {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(bound(deserialize = "A:Deserialize<'de>,R:Deserialize<'de>"))]
        struct Raw<A, R> {
            step: Rc<WorkflowStep<A>>,
            #[serde(default)]
            result: WorkflowValue<Rc<R>>,
        }
        let raw = Raw::deserialize(deserializer)?;
        Ok(Self {
            step: raw.step,
            result: raw.result,
        })
    }
}
impl<A: Serialize> Serialize for InFlightActivity<A> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut record = Record::new();
        record.insert("index".into(), value::<_, S::Error>(&self.index)?);
        record.insert("step".into(), value::<_, S::Error>(&self.step)?);
        record.insert("id".into(), value::<_, S::Error>(&self.id)?);
        render(record, serializer)
    }
}
impl<'de, A: Deserialize<'de>> Deserialize<'de> for InFlightActivity<A> {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(bound(deserialize = "A:Deserialize<'de>"))]
        struct Raw<A> {
            index: WorkflowIndex,
            step: Rc<WorkflowStep<A>>,
            id: DeliveryId,
        }
        let raw = Raw::deserialize(deserializer)?;
        Ok(Self {
            index: raw.index,
            step: raw.step,
            id: raw.id,
        })
    }
}
impl<A: Serialize> Serialize for WorkflowSteps<A> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.0.serialize(serializer)
    }
}
impl<'de, A: Deserialize<'de>> Deserialize<'de> for WorkflowSteps<A> {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let steps = Rc::<Vec<Rc<WorkflowStep<A>>>>::deserialize(deserializer)?;
        if steps.is_empty() {
            return Err(serde::de::Error::custom("workflow steps must be non-empty"));
        }
        Ok(Self(steps))
    }
}
fn failure_fields<A: Serialize, F: Serialize, X: serde::ser::Error>(
    record: &mut Record,
    failure: &WorkflowFailure<A, F>,
) -> Result<(), X> {
    record.insert("failedStep".into(), value::<_, X>(&failure.failed_step)?);
    field::<_, X>(record, "failure", &failure.failure)
}
impl<A: Serialize, R: Serialize, F: Serialize> Serialize for WorkflowState<A, R, F> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut record = Record::new();
        record.insert(
            "status".into(),
            PlainData::String(self.status.as_str().into()),
        );
        record.insert("steps".into(), value::<_, S::Error>(&self.steps)?);
        record.insert("completed".into(), value::<_, S::Error>(&self.completed)?);
        match &self.status {
            WorkflowPhase::Running { current } => {
                record.insert("current".into(), value::<_, S::Error>(current)?);
            }
            WorkflowPhase::Completed { output } => {
                field::<_, S::Error>(&mut record, "output", output)?
            }
            WorkflowPhase::Failed { failure } | WorkflowPhase::FailedCompensated { failure } => {
                failure_fields::<_, _, S::Error>(&mut record, failure)?
            }
            WorkflowPhase::Compensating {
                failure,
                current,
                compensated,
            } => {
                failure_fields::<_, _, S::Error>(&mut record, failure)?;
                record.insert("compensated".into(), value::<_, S::Error>(compensated)?);
                record.insert("current".into(), value::<_, S::Error>(current)?);
            }
            WorkflowPhase::CompensationFailed {
                failure,
                compensated,
                failed_compensation_step,
                compensation_failure,
            } => {
                failure_fields::<_, _, S::Error>(&mut record, failure)?;
                record.insert("compensated".into(), value::<_, S::Error>(compensated)?);
                record.insert(
                    "failedCompensationStep".into(),
                    value::<_, S::Error>(failed_compensation_step)?,
                );
                field::<_, S::Error>(&mut record, "compensationFailure", compensation_failure)?;
            }
        }
        render(record, serializer)
    }
}
impl<'de, A: Deserialize<'de>, R: Deserialize<'de>, F: Deserialize<'de>> Deserialize<'de>
    for WorkflowState<A, R, F>
{
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(
            rename_all = "camelCase",
            bound(deserialize = "A:Deserialize<'de>,R:Deserialize<'de>,F:Deserialize<'de>")
        )]
        struct Raw<A, R, F> {
            status: String,
            steps: Rc<Vec<Rc<WorkflowStep<A>>>>,
            completed: Rc<Vec<Rc<CompletedStep<A, R>>>>,
            current: Option<Rc<InFlightActivity<A>>>,
            #[serde(default)]
            output: WorkflowValue<Rc<R>>,
            failed_step: Option<Rc<WorkflowStep<A>>>,
            #[serde(default)]
            failure: WorkflowValue<Rc<F>>,
            compensated: Option<Completed<A, R>>,
            failed_compensation_step: Option<Rc<WorkflowStep<A>>>,
            #[serde(default)]
            compensation_failure: WorkflowValue<Rc<F>>,
        }
        let raw = Raw::deserialize(deserializer)?;
        let failure = || -> Result<Rc<WorkflowFailure<A, F>>, D::Error> {
            Ok(Rc::new(WorkflowFailure {
                failed_step: raw
                    .failed_step
                    .clone()
                    .ok_or_else(|| serde::de::Error::missing_field("failedStep"))?,
                failure: raw.failure.clone(),
            }))
        };
        let current = || {
            raw.current
                .clone()
                .ok_or_else(|| serde::de::Error::missing_field("current"))
        };
        let compensated = || {
            raw.compensated
                .clone()
                .ok_or_else(|| serde::de::Error::missing_field("compensated"))
        };
        let status = match raw.status.as_str() {
            "running" => WorkflowPhase::Running {
                current: current()?,
            },
            "completed" => WorkflowPhase::Completed { output: raw.output },
            "failed" => WorkflowPhase::Failed {
                failure: failure()?,
            },
            "compensating" => WorkflowPhase::Compensating {
                failure: failure()?,
                current: current()?,
                compensated: compensated()?,
            },
            "failed_compensated" => WorkflowPhase::FailedCompensated {
                failure: failure()?,
            },
            "compensation_failed" => WorkflowPhase::CompensationFailed {
                failure: failure()?,
                compensated: compensated()?,
                failed_compensation_step: raw
                    .failed_compensation_step
                    .ok_or_else(|| serde::de::Error::missing_field("failedCompensationStep"))?,
                compensation_failure: raw.compensation_failure,
            },
            other => return Err(serde::de::Error::unknown_variant(other, &WORKFLOW_STATUSES)),
        };
        Ok(Self {
            status,
            steps: raw.steps,
            completed: raw.completed,
        })
    }
}
impl<A: Serialize> Serialize for WorkflowActivityInput<A> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut record = Record::new();
        record.insert("index".into(), value::<_, S::Error>(&self.index)?);
        record.insert("id".into(), value::<_, S::Error>(&self.id)?);
        field::<_, S::Error>(&mut record, "activity", &self.activity)?;
        render(record, serializer)
    }
}
impl<'de, A: Deserialize<'de>> Deserialize<'de> for WorkflowActivityInput<A> {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(bound(deserialize = "A:Deserialize<'de>"))]
        struct Raw<A> {
            index: WorkflowIndex,
            id: DeliveryId,
            #[serde(default)]
            activity: WorkflowValue<Rc<A>>,
        }
        let raw = Raw::deserialize(deserializer)?;
        Ok(Self {
            index: raw.index,
            id: raw.id,
            activity: raw.activity,
        })
    }
}
impl<A: Serialize> Serialize for WorkflowCompensationInput<A> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut record = Record::new();
        record.insert("index".into(), value::<_, S::Error>(&self.index)?);
        record.insert("id".into(), value::<_, S::Error>(&self.id)?);
        field::<_, S::Error>(&mut record, "compensation", &self.compensation)?;
        render(record, serializer)
    }
}
impl<'de, A: Deserialize<'de>> Deserialize<'de> for WorkflowCompensationInput<A> {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(bound(deserialize = "A:Deserialize<'de>"))]
        struct Raw<A> {
            index: WorkflowIndex,
            id: DeliveryId,
            #[serde(default)]
            compensation: WorkflowValue<Rc<A>>,
        }
        let raw = Raw::deserialize(deserializer)?;
        Ok(Self {
            index: raw.index,
            id: raw.id,
            compensation: raw.compensation,
        })
    }
}
impl<A: Serialize> Serialize for WorkflowCmd<A> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Activity(cmd) => cmd.serialize(serializer),
            Self::Compensation(cmd) => cmd.serialize(serializer),
        }
    }
}
impl<'de, A: DeserializeOwned> Deserialize<'de> for WorkflowCmd<A> {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = Box::<RawValue>::deserialize(deserializer)?;
        #[derive(Deserialize)]
        struct Kind {
            #[serde(rename = "type")]
            kind: String,
        }
        let kind = serde_json::from_str::<Kind>(raw.get()).map_err(serde::de::Error::custom)?;
        match kind.kind.as_str() {
            "workflow_activity" => serde_json::from_str(raw.get())
                .map(|input| Self::Activity(workflow_activity_def().from_record(input)))
                .map_err(serde::de::Error::custom),
            "workflow_compensation" => serde_json::from_str(raw.get())
                .map(|input| Self::Compensation(workflow_compensation_def().from_record(input)))
                .map_err(serde::de::Error::custom),
            other => Err(serde::de::Error::unknown_variant(
                other,
                &["workflow_activity", "workflow_compensation"],
            )),
        }
    }
}

fn message_header<X: serde::ser::Error>(kind: &str, id: DeliveryId) -> Result<Record, X> {
    Ok([
        ("type".into(), PlainData::String(kind.into())),
        ("id".into(), value::<_, X>(&id)?),
    ]
    .into_iter()
    .collect())
}
impl<R: Serialize> Serialize for ActivityOk<R> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut record = message_header::<S::Error>("activity_ok", self.id)?;
        field::<_, S::Error>(&mut record, "result", &self.result)?;
        render(record, serializer)
    }
}
impl<F: Serialize> Serialize for ActivityErr<F> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut record = message_header::<S::Error>("activity_err", self.id)?;
        field::<_, S::Error>(&mut record, "failure", &self.failure)?;
        render(record, serializer)
    }
}
impl Serialize for CompensationOk {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        render(
            message_header::<S::Error>("compensation_ok", self.id)?,
            serializer,
        )
    }
}
impl<F: Serialize> Serialize for CompensationErr<F> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut record = message_header::<S::Error>("compensation_err", self.id)?;
        field::<_, S::Error>(&mut record, "failure", &self.failure)?;
        render(record, serializer)
    }
}
impl<R: Serialize, F: Serialize> Serialize for WorkflowMsg<R, F> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::ActivityOk(msg) => msg.serialize(serializer),
            Self::ActivityErr(msg) => msg.serialize(serializer),
            Self::CompensationOk(msg) => msg.serialize(serializer),
            Self::CompensationErr(msg) => msg.serialize(serializer),
        }
    }
}
impl<'de, R: Deserialize<'de>> Deserialize<'de> for ActivityOk<R> {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(bound(deserialize = "R:Deserialize<'de>"))]
        struct Raw<R> {
            id: DeliveryId,
            #[serde(default)]
            result: WorkflowValue<Rc<R>>,
        }
        let raw = Raw::deserialize(deserializer)?;
        Ok(Self {
            id: raw.id,
            result: raw.result,
        })
    }
}
impl<'de, F: Deserialize<'de>> Deserialize<'de> for ActivityErr<F> {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(bound(deserialize = "F:Deserialize<'de>"))]
        struct Raw<F> {
            id: DeliveryId,
            #[serde(default)]
            failure: WorkflowValue<Rc<F>>,
        }
        let raw = Raw::deserialize(deserializer)?;
        Ok(Self {
            id: raw.id,
            failure: raw.failure,
        })
    }
}
impl<'de> Deserialize<'de> for CompensationOk {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        struct Raw {
            id: DeliveryId,
        }
        Ok(Self {
            id: Raw::deserialize(deserializer)?.id,
        })
    }
}
impl<'de, F: Deserialize<'de>> Deserialize<'de> for CompensationErr<F> {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(bound(deserialize = "F:Deserialize<'de>"))]
        struct Raw<F> {
            id: DeliveryId,
            #[serde(default)]
            failure: WorkflowValue<Rc<F>>,
        }
        let raw = Raw::deserialize(deserializer)?;
        Ok(Self {
            id: raw.id,
            failure: raw.failure,
        })
    }
}
impl<'de, R: DeserializeOwned, F: DeserializeOwned> Deserialize<'de> for WorkflowMsg<R, F> {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = Box::<RawValue>::deserialize(deserializer)?;
        #[derive(Deserialize)]
        struct Kind {
            #[serde(rename = "type")]
            kind: String,
        }
        let kind = serde_json::from_str::<Kind>(raw.get()).map_err(serde::de::Error::custom)?;
        match kind.kind.as_str() {
            "activity_ok" => serde_json::from_str(raw.get())
                .map(Self::ActivityOk)
                .map_err(serde::de::Error::custom),
            "activity_err" => serde_json::from_str(raw.get())
                .map(Self::ActivityErr)
                .map_err(serde::de::Error::custom),
            "compensation_ok" => serde_json::from_str(raw.get())
                .map(Self::CompensationOk)
                .map_err(serde::de::Error::custom),
            "compensation_err" => serde_json::from_str(raw.get())
                .map(Self::CompensationErr)
                .map_err(serde::de::Error::custom),
            other => Err(serde::de::Error::unknown_variant(
                other,
                &WORKFLOW_MSG_TYPES,
            )),
        }
    }
}
impl<A: Serialize, R: Serialize, F: Serialize> Serialize for WorkflowReducerStep<A, R, F> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        render(
            [
                ("state".into(), value::<_, S::Error>(&self.state)?),
                ("ledger".into(), value::<_, S::Error>(&self.ledger)?),
                ("cmds".into(), value::<_, S::Error>(&self.cmds)?),
            ]
            .into_iter()
            .collect(),
            serializer,
        )
    }
}
