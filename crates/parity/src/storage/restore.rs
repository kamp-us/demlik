use std::{
    cell::{Cell, RefCell},
    fmt,
    panic::{AssertUnwindSafe, catch_unwind},
};

use demlik_tea::storage::{Migrated, RestoreCause, Store, StoreRefusedError};
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub(super) enum Fault {
    Error {
        message: String,
    },
    Value {
        value: Value,
    },
    Refused {
        reason: String,
        cause: Option<Box<Fault>>,
    },
}
fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => {
            let value = value.as_f64().expect("JSON number");
            if value == 0.0 { "0".into() } else { ryu(value) }
        }
        Value::String(value) => value.clone(),
        Value::Object(_) => "[object Object]".into(),
        Value::Array(values) => values
            .iter()
            .map(|value| {
                if value.is_null() {
                    String::new()
                } else {
                    js_string(value)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
    }
}
fn ryu(value: f64) -> String {
    demlik_tea::data::stringify_json(&demlik_tea::PlainData::Number(value))
        .expect("finite JSON number")
}
impl Fault {
    pub(super) fn value(&self) -> Value {
        match self {
            Self::Error { message } => json!({ "name": "Error", "message": message }),
            Self::Value { value } => value.clone(),
            Self::Refused { reason, cause } => {
                let mut value = json!({ "name": "StoreRefusedError", "_tag": "store_refused", "reason": reason, "message": format!("@demlik/tea: store refused — {reason}. The saved state was not restored and nothing was written.") });
                if let Some(cause) = cause {
                    value["cause"] = cause.value();
                }
                value
            }
        }
    }
    fn preserve(&self) -> Option<StoreRefusedError<Self>> {
        match self {
            Self::Refused { reason, cause } => Some(StoreRefusedError {
                reason: reason.clone(),
                cause: cause.as_deref().cloned().map(RestoreCause::Load),
            }),
            _ => None,
        }
    }
}
impl fmt::Display for Fault {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Error { message } => f.write_str(message),
            Self::Value { value } => f.write_str(&js_string(value)),
            Self::Refused { reason, .. } => write!(
                f,
                "@demlik/tea: store refused — {reason}. The saved state was not restored and nothing was written."
            ),
        }
    }
}
impl std::error::Error for Fault {}
pub(super) fn panic_fault(fault: Fault) -> ! {
    std::panic::panic_any(Box::new(fault) as Box<dyn std::error::Error + Send>)
}
fn panic_value(panic: &demlik_tea::storage::PanicCause) -> Value {
    panic.with_payload(|payload| {
        payload
            .downcast_ref::<Box<dyn std::error::Error + Send>>()
            .and_then(|error| error.downcast_ref::<Fault>())
            .map(Fault::value)
            .or_else(|| {
                payload
                    .downcast_ref::<String>()
                    .map(|message| json!(message))
            })
            .or_else(|| payload.downcast_ref::<&str>().map(|message| json!(message)))
            .unwrap_or_else(|| json!({ "message": panic.summary }))
    })
}
pub(super) fn restore_error<E>(
    error: &StoreRefusedError<E>,
    mut load: impl FnMut(&E) -> Value,
) -> Value {
    let mut value = json!({ "name": error.name(), "_tag": error.tag(), "message": error.to_string(), "reason": error.reason });
    if let Some(cause) = &error.cause {
        value["cause"] = match cause {
            RestoreCause::Load(error) => load(error),
            RestoreCause::Panic(error) => panic_value(error),
        };
    }
    value
}
#[derive(Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Schema {
    #[default]
    Counter,
    Throw,
}
#[derive(Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Upcast {
    #[default]
    Identity,
    Legacy,
    Throw,
    Error,
    Invalid,
}
fn parse(mode: Schema, raw: Value) -> Result<Value, ()> {
    if matches!(mode, Schema::Throw) {
        panic_fault(Fault::Error {
            message: "schema failed".into(),
        });
    }
    let count = raw
        .get("count")
        .filter(|value| value.is_number())
        .ok_or(())?;
    let label = raw.get("label").and_then(Value::as_str).ok_or(())?;
    Ok(json!({ "count": count, "label": label.trim() }))
}
fn upcast(mode: Upcast, raw: Value) -> Result<Value, Fault> {
    match mode {
        Upcast::Identity => Ok(raw),
        Upcast::Legacy => {
            let mut value = json!({ "label": "legacy" });
            if let Some(raw) = raw.as_object() {
                value.as_object_mut().expect("object").extend(raw.clone());
            }
            Ok(value)
        }
        Upcast::Invalid => Ok(json!({ "invalid": true })),
        Upcast::Error => Err(Fault::Value {
            value: json!("upcast failed"),
        }),
        Upcast::Throw => panic_fault(Fault::Error {
            message: "upcast failed".into(),
        }),
    }
}
#[derive(Deserialize)]
struct SchemaInput {
    #[serde(default)]
    raw: Value,
    #[serde(default)]
    schema: Schema,
    #[serde(default)]
    upcast: Upcast,
}
fn migrated(value: Migrated<Value>) -> Value {
    match value {
        Migrated::Fresh => json!({ "kind": "fresh" }),
        Migrated::State(value) => json!({ "kind": "state", "value": value }),
        Migrated::Refused(refusal) => json!({ "kind": "refused", "refusal": refusal }),
    }
}
pub fn schema(input: Value, calls: &mut Vec<&'static str>) -> Result<Value, String> {
    let input: SchemaInput = serde_json::from_value(input).map_err(|error| error.to_string())?;
    let parse_calls = Cell::new(0);
    let upcast_calls = Cell::new(0);
    let parse = |raw| {
        parse_calls.set(parse_calls.get() + 1);
        parse(input.schema, raw)
    };
    let result = if matches!(input.upcast, Upcast::Identity) {
        let migrate = observe!(calls, demlik_tea::storage::schema_migrate, parse);
        catch_unwind(AssertUnwindSafe(|| migrate(input.raw)))
    } else {
        let upgrade = |raw| {
            upcast_calls.set(upcast_calls.get() + 1);
            upcast(input.upcast, raw)
        };
        let migrate = observe!(
            calls,
            demlik_tea::storage::schema_migrate_with_upcast,
            parse,
            upgrade
        );
        catch_unwind(AssertUnwindSafe(|| migrate(input.raw)))
    };
    let mut value = match result {
        Ok(value) => json!({ "migrated": migrated(value) }),
        Err(payload) => {
            json!({ "threw": panic_value(&demlik_tea::storage::PanicCause::new(payload)) })
        }
    };
    value["parseCalls"] = json!(parse_calls.get());
    value["upcastCalls"] = json!(upcast_calls.get());
    Ok(value)
}

#[derive(Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
enum Migration {
    #[default]
    Identity,
    Schema,
    Refuse,
    Throw,
    PlainRefusal,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Input {
    #[serde(default)]
    raw: Value,
    load_fault: Option<Fault>,
    #[serde(default)]
    migrate: Migration,
    migrate_fault: Option<Fault>,
    #[serde(default)]
    upcast: Upcast,
}
struct Adapter {
    raw: RefCell<Value>,
    input: Input,
    loads: Cell<usize>,
    migrations: Cell<usize>,
    saves: Cell<usize>,
}
impl Store<Value> for Adapter {
    type Raw = Value;
    type Error = Fault;
    async fn load(&self) -> Result<Value, Fault> {
        self.loads.set(self.loads.get() + 1);
        match &self.input.load_fault {
            Some(error) => Err(error.clone()),
            None => Ok(self.raw.borrow().clone()),
        }
    }
    async fn save(&self, state: &Value) -> Result<(), Fault> {
        self.saves.set(self.saves.get() + 1);
        *self.raw.borrow_mut() = state.clone();
        Ok(())
    }
    fn migrate(&self, raw: Value) -> Migrated<Value> {
        self.migrations.set(self.migrations.get() + 1);
        match self.input.migrate {
            Migration::Identity => {
                if raw.is_null() {
                    Migrated::Fresh
                } else {
                    Migrated::State(raw)
                }
            }
            Migration::Refuse => {
                Migrated::Refused(demlik_tea::storage::refuse("not a saved State"))
            }
            Migration::PlainRefusal => {
                Migrated::State(json!({ "_tag": "refusal", "reason": "ordinary model data" }))
            }
            Migration::Throw => {
                panic_fault(self.input.migrate_fault.clone().unwrap_or(Fault::Error {
                    message: "migration failed".into(),
                }))
            }
            Migration::Schema => {
                let migrate = demlik_tea::storage::schema_migrate_with_upcast(
                    |raw| parse(Schema::Counter, raw),
                    |raw| upcast(self.input.upcast, raw),
                );
                migrate(raw)
            }
        }
    }
    fn restore_failure(&self, cause: RestoreCause<Fault>) -> StoreRefusedError<Fault> {
        let preserved = match &cause {
            RestoreCause::Load(error) => error.preserve(),
            RestoreCause::Panic(error) => error.with_payload(|payload| {
                payload
                    .downcast_ref::<Box<dyn std::error::Error + Send>>()
                    .and_then(|error| error.downcast_ref::<Fault>())
                    .and_then(Fault::preserve)
            }),
        };
        preserved.unwrap_or_else(|| {
            let description = match &cause {
                RestoreCause::Load(error) => error.to_string(),
                RestoreCause::Panic(error) => error.summary.clone(),
            };
            StoreRefusedError {
                reason: format!("the saved state could not be read ({description})"),
                cause: Some(cause),
            }
        })
    }
}
pub async fn execute(input: Value, calls: &mut Vec<&'static str>) -> Result<Value, String> {
    let input: Input = serde_json::from_value(input).map_err(|error| error.to_string())?;
    let store = Adapter {
        raw: RefCell::new(input.raw.clone()),
        input,
        loads: Cell::new(0),
        migrations: Cell::new(0),
        saves: Cell::new(0),
    };
    let result = observe_async!(calls, demlik_tea::storage::restore, &store);
    let mut output = match result {
        Ok(restored) => json!({ "restored": restored }),
        Err(error) => json!({ "error": restore_error(&error, Fault::value) }),
    };
    output["loadCalls"] = json!(store.loads.get());
    output["migrateCalls"] = json!(store.migrations.get());
    output["saveCalls"] = json!(store.saves.get());
    output["rawAfter"] = store.raw.borrow().clone();
    Ok(output)
}
