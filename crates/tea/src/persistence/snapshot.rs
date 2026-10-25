//! Pure checkpoint cadence and acknowledgment, with storage supplied by handlers.

use crate::{
    PlainData, Step, Tagged,
    command::{Cmd, CmdDef, CommandRecord, CommandSpec, Issue, SchemaError, Settled},
    data::JsText,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{marker::PhantomData, rc::Rc};

/// A numeric state field can restore as JSON null after a nonfinite value.
pub use crate::work_queue::QueueTime as SnapshotNumber;

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotState {
    pub since_last: SnapshotNumber,
    pub seq: SnapshotNumber,
    pub last_saved_seq: Option<f64>,
    pub last_saved_at: Option<f64>,
}
#[derive(Debug, Clone)]
pub struct SnapshotConfig {
    pub every: f64,
    pub key: Option<JsText>,
}
#[derive(Debug, Serialize, Deserialize)]
pub struct SnapshotWriteInput<V> {
    pub key: JsText,
    pub seq: SnapshotNumber,
    pub at: SnapshotNumber,
    pub payload: Rc<V>,
}
impl<V> SnapshotWriteInput<V> {
    pub fn new(key: impl Into<JsText>, seq: f64, at: f64, payload: Rc<V>) -> Self {
        Self {
            key: key.into(),
            seq: seq.into(),
            at: at.into(),
            payload,
        }
    }
}
impl<V> CommandRecord for SnapshotWriteInput<V> {}
#[derive(Debug, Serialize, Deserialize)]
pub struct SnapshotLoadInput {
    pub key: JsText,
}
impl CommandRecord for SnapshotLoadInput {}
#[derive(Debug, Serialize, Deserialize)]
#[serde(transparent)]
pub struct SnapshotFailure(pub PlainData);
impl Tagged for SnapshotFailure {
    fn tag(&self) -> &str {
        match &self.0 {
            PlainData::Object(record) => match record.get(&JsText::from("_tag")) {
                Some(PlainData::String(tag)) => tag.as_utf8().unwrap_or(""),
                _ => "",
            },
            _ => "",
        }
    }
}
pub struct SnapshotWriteSpec<V>(PhantomData<fn() -> V>);
impl<V> CommandSpec for SnapshotWriteSpec<V> {
    type Input = SnapshotWriteInput<V>;
    type RawOutput = PlainData;
    type Output = PlainData;
    type Error = SnapshotFailure;
    const NAME: &'static str = "snapshot_write";
    const ERROR_TAGS: &'static [&'static str] = &["snapshot_write_failed"];
    fn parse_input(_: Value) -> Result<Self::Input, SchemaError> {
        Err(SchemaError::Issues(vec![Issue::new(
            "",
            "snapshot payload needs a caller-owned decoder",
        )]))
    }
    fn parse_output(value: PlainData) -> Result<PlainData, SchemaError> {
        crate::schema::undefined_only(value)
    }
    fn missing_output() -> Option<PlainData> {
        Some(PlainData::Undefined)
    }
}
pub struct SnapshotLoadSpec<V>(PhantomData<fn() -> V>);
impl<V> CommandSpec for SnapshotLoadSpec<V> {
    type Input = SnapshotLoadInput;
    type RawOutput = Option<Rc<V>>;
    type Output = Option<Rc<V>>;
    type Error = SnapshotFailure;
    const NAME: &'static str = "snapshot_load";
    const ERROR_TAGS: &'static [&'static str] = &["snapshot_load_failed"];
    fn parse_input(value: Value) -> Result<SnapshotLoadInput, SchemaError> {
        serde_json::from_value(value).map_err(SchemaError::from)
    }
    fn parse_output(value: Self::RawOutput) -> Result<Self::Output, SchemaError> {
        Ok(value)
    }
}
pub type SnapshotWriteCmd<V> = Cmd<SnapshotWriteSpec<V>>;
pub type SnapshotLoadCmd<V> = Cmd<SnapshotLoadSpec<V>>;
pub type SnapshotSavedMsg<V> = Settled<SnapshotWriteSpec<V>>;
pub type SnapshotFailedMsg<V> = Settled<SnapshotWriteSpec<V>>;
pub type SnapshotLoadedMsg<V> = Settled<SnapshotLoadSpec<V>>;
pub type SnapshotLoadFailedMsg<V> = Settled<SnapshotLoadSpec<V>>;
pub fn snapshot_write_def<V>() -> CmdDef<SnapshotWriteSpec<V>> {
    CmdDef::new()
}
pub fn snapshot_load_def<V>() -> CmdDef<SnapshotLoadSpec<V>> {
    CmdDef::new()
}
pub struct Snapshot<V> {
    pub write: CmdDef<SnapshotWriteSpec<V>>,
    pub load: CmdDef<SnapshotLoadSpec<V>>,
    every: f64,
    key: JsText,
}
pub fn create_snapshot<V>(config: SnapshotConfig) -> Snapshot<V> {
    Snapshot {
        write: snapshot_write_def(),
        load: snapshot_load_def(),
        every: if config.every >= 1.0 {
            config.every
        } else {
            1.0
        },
        key: config.key.unwrap_or_else(|| "@@snapshot".into()),
    }
}
impl<V> Snapshot<V> {
    pub fn init(&self) -> Rc<SnapshotState> {
        Rc::new(SnapshotState {
            since_last: 0.0.into(),
            seq: 0.0.into(),
            last_saved_seq: None,
            last_saved_at: None,
        })
    }
    fn emit_write(
        &self,
        state: &SnapshotState,
        payload: Rc<V>,
        at: f64,
    ) -> Step<Rc<SnapshotState>, SnapshotWriteCmd<V>> {
        let seq = state.seq.number().unwrap_or(0.0) + 1.0;
        let next = SnapshotState {
            since_last: 0.0.into(),
            seq: seq.into(),
            ..*state
        };
        Step::new(
            Rc::new(next),
            vec![self.write.from_record(SnapshotWriteInput {
                key: self.key.clone(),
                seq: seq.into(),
                at: at.into(),
                payload,
            })],
        )
    }
    pub fn record(
        &self,
        state: &Rc<SnapshotState>,
        payload: Rc<V>,
        at: f64,
    ) -> Step<Rc<SnapshotState>, SnapshotWriteCmd<V>> {
        let since_last = state.since_last.number().unwrap_or(0.0) + 1.0;
        if since_last < self.every {
            return Step::new(
                Rc::new(SnapshotState {
                    since_last: since_last.into(),
                    ..**state
                }),
                vec![],
            );
        }
        self.emit_write(state, payload, at)
    }
    pub fn force(
        &self,
        state: &Rc<SnapshotState>,
        payload: Rc<V>,
        at: f64,
    ) -> Step<Rc<SnapshotState>, SnapshotWriteCmd<V>> {
        self.emit_write(state, payload, at)
    }
    pub fn confirm(
        &self,
        state: &Rc<SnapshotState>,
        msg: &SnapshotSavedMsg<V>,
    ) -> Step<Rc<SnapshotState>, SnapshotWriteCmd<V>> {
        let input = msg.cmd().input();
        if state
            .last_saved_seq
            .is_some_and(|last| input.seq.number_or_zero() <= last)
        {
            return Step::new(Rc::clone(state), vec![]);
        }
        Step::new(
            Rc::new(SnapshotState {
                last_saved_seq: input.seq.number(),
                last_saved_at: input.at.number(),
                ..**state
            }),
            vec![],
        )
    }
    pub fn boot(&self, state: &Rc<SnapshotState>) -> Step<Rc<SnapshotState>, SnapshotWriteCmd<V>> {
        Step::new(
            Rc::new(SnapshotState {
                since_last: 0.0.into(),
                ..**state
            }),
            vec![],
        )
    }
    pub fn request_load(
        &self,
        state: &Rc<SnapshotState>,
    ) -> Step<Rc<SnapshotState>, SnapshotLoadCmd<V>> {
        Step::new(
            Rc::clone(state),
            vec![self.load.from_record(SnapshotLoadInput {
                key: self.key.clone(),
            })],
        )
    }
}
