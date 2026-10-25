use std::{cell::RefCell, collections::HashMap, rc::Rc};

use demlik_tea::storage::{DeletableStore, MemoryStoreError, Migrated};
use serde::Deserialize;
use serde_json::{Value, json};

type Shared = Rc<RefCell<Value>>;
#[derive(Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Parse {
    #[default]
    Identity,
    Strict,
    Refuse,
}
#[derive(Deserialize)]
#[serde(untagged)]
enum Key {
    Name(String),
    Index(usize),
}
#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
enum Action {
    Load {
        #[serde(rename = "as")]
        alias: Option<String>,
    },
    LoadFenced {
        #[serde(rename = "as")]
        alias: Option<String>,
    },
    Save {
        reference: String,
    },
    SaveFenced {
        reference: String,
        expected: super::super::Number,
    },
    Migrate {
        reference: Option<String>,
        #[serde(rename = "as")]
        alias: Option<String>,
    },
    Mutate {
        reference: String,
        path: Vec<Key>,
        value: Value,
        #[serde(default)]
        push: bool,
    },
    Same {
        left: String,
        right: String,
    },
    Snapshot {
        reference: String,
    },
    Delete,
}
#[derive(Deserialize)]
struct Input {
    #[serde(default)]
    objects: HashMap<String, Value>,
    initial: Option<String>,
    #[serde(default)]
    fenced: bool,
    #[serde(default)]
    parse: Parse,
    actions: Vec<Action>,
}
enum Observation {
    Frozen(Value),
    Live {
        op: &'static str,
        raw: Option<Shared>,
        version: Option<demlik_tea::storage::StoredCell>,
    },
}
impl Observation {
    fn value(self) -> Value {
        match self {
            Self::Frozen(value) => value,
            Self::Live { op, raw, version } => {
                let mut value = json!({ "op": op, "raw": raw.map(|value| value.borrow().clone()) });
                if let Some(version) = version {
                    value["version"] = super::normalized(&version.snapshot());
                }
                value
            }
        }
    }
}
fn parser(mode: Parse, raw: Option<Shared>) -> Migrated<Shared> {
    if matches!(mode, Parse::Refuse) {
        return Migrated::Refused(demlik_tea::storage::refuse("unsupported saved state"));
    }
    let Some(raw) = raw else {
        return Migrated::Fresh;
    };
    match mode {
        Parse::Identity => Migrated::State(raw),
        Parse::Refuse => Migrated::Refused(demlik_tea::storage::refuse("unsupported saved state")),
        Parse::Strict => {
            let parse = demlik_tea::storage::schema_migrate(|value: Value| -> Result<Value, ()> {
                value
                    .get("count")
                    .filter(|value| value.is_number())
                    .map(|value| json!({ "count": value }))
                    .ok_or(())
            });
            match parse(raw.borrow().clone()) {
                Migrated::Fresh => Migrated::Fresh,
                Migrated::Refused(refusal) => Migrated::Refused(refusal),
                Migrated::State(value) => Migrated::State(Rc::new(RefCell::new(value))),
            }
        }
    }
}
pub async fn execute(input: Value, calls: &mut Vec<&'static str>) -> Result<Value, String> {
    let input: Input = serde_json::from_value(input).map_err(|error| error.to_string())?;
    let objects: HashMap<_, _> = input
        .objects
        .into_iter()
        .map(|(name, value)| (name, Some(Rc::new(RefCell::new(value)))))
        .collect();
    let initial = input
        .initial
        .as_ref()
        .map(|name| {
            objects
                .get(name)
                .cloned()
                .ok_or("initial reference is missing")
        })
        .transpose()?
        .flatten();
    if matches!(input.parse, Parse::Identity) {
        let store = observe!(calls, demlik_tea::storage::memory_store, initial);
        if input.fenced {
            drive(store.fenced(), objects, input.actions, calls).await
        } else {
            drive(store, objects, input.actions, calls).await
        }
    } else {
        let mode = input.parse;
        let store = observe!(
            calls,
            demlik_tea::storage::MemoryStore::with_parser,
            initial,
            move |raw| parser(mode, raw)
        );
        if input.fenced {
            drive(store.fenced(), objects, input.actions, calls).await
        } else {
            drive(store, objects, input.actions, calls).await
        }
    }
}
async fn drive<P>(
    store: P,
    mut objects: HashMap<String, Option<Shared>>,
    actions: Vec<Action>,
    calls: &mut Vec<&'static str>,
) -> Result<Value, String>
where
    P: DeletableStore<Shared, Raw = Option<Shared>, Error = MemoryStoreError>,
{
    let fenced = observe!(calls, demlik_tea::storage::is_fenced_store, &store);
    let mut observations = Vec::new();
    for action in actions {
        match action {
            Action::Load { alias } => {
                let raw = observe_async!(calls, demlik_tea::storage::Store::load, &store).map_err(|error| error.to_string())?;
                if let Some(alias) = alias { objects.insert(alias, raw.clone()); }
                observations.push(Observation::Live { op: "load", raw, version: None });
            },
            Action::LoadFenced { alias } => {
                let fence = store.fencing().ok_or("store is not fenced")?;
                let read = observe_async!(calls, demlik_tea::storage::Fencing::load_fenced, fence).map_err(|error| error.to_string())?;
                if let Some(alias) = alias { objects.insert(alias, read.raw.clone()); }
                observations.push(Observation::Live { op: "loadFenced", raw: read.raw, version: Some(read.version) });
            },
            Action::Save { reference } => {
                let value = objects.get(&reference).and_then(Option::as_ref).ok_or("save reference is missing")?;
                observe_async!(calls, demlik_tea::storage::Store::save, &store, value).map_err(|error| error.to_string())?;
                observations.push(Observation::Frozen(json!({ "op": "save" })));
            },
            Action::SaveFenced { reference, expected } => {
                let value = objects.get(&reference).and_then(Option::as_ref).ok_or("save reference is missing")?;
                let fence = store.fencing().ok_or("store is not fenced")?;
                let output = match observe_async!(calls, demlik_tea::storage::Fencing::save_fenced, fence, value, expected.value().into()) {
                    Ok(version) => json!({ "op": "saveFenced", "version": super::normalized(&version.snapshot()) }),
                    Err(MemoryStoreError::Conflict(error)) => json!({ "op": "saveFenced", "error": super::conflict(&error) }),
                    Err(error) => return Err(error.to_string()),
                };
                observations.push(Observation::Frozen(output));
            },
            Action::Migrate { reference, alias } => {
                let raw = reference.as_ref().map(|name| objects.get(name).cloned().ok_or("migration reference is missing")).transpose()?.flatten();
                match observe!(calls, demlik_tea::storage::Store::migrate, &store, raw) {
                    Migrated::Fresh => { if let Some(alias) = alias { objects.insert(alias, None); } observations.push(Observation::Live { op: "migrate", raw: None, version: None }); },
                    Migrated::State(raw) => { if let Some(alias) = alias { objects.insert(alias, Some(Rc::clone(&raw))); } observations.push(Observation::Live { op: "migrate", raw: Some(raw), version: None }); },
                    Migrated::Refused(refusal) => observations.push(Observation::Frozen(json!({ "op": "migrate", "refusal": refusal }))),
                }
            },
            Action::Delete => { observe_async!(calls, demlik_tea::storage::DeletableStore::delete, &store).map_err(|error| error.to_string())?; observations.push(Observation::Frozen(json!({ "op": "delete" }))); },
            Action::Snapshot { reference } => observations.push(Observation::Frozen(json!({ "op": "snapshot", "raw": objects.get(&reference).and_then(Option::as_ref).map(|value| value.borrow().clone()) }))),
            Action::Same { left, right } => {
                let left = objects.get(&left).and_then(Option::as_ref);
                let right = objects.get(&right).and_then(Option::as_ref);
                let same = match (left, right) { (Some(left), Some(right)) if left.borrow().is_object() || left.borrow().is_array() => Rc::ptr_eq(left, right), (Some(left), Some(right)) => *left.borrow() == *right.borrow(), (None, None) => true, _ => false };
                observations.push(Observation::Frozen(json!({ "op": "same", "same": same })));
            },
            Action::Mutate { reference, path, value, push } => {
                let shared = objects.get(&reference).and_then(Option::as_ref).ok_or("mutation reference is missing")?;
                let mut data = shared.borrow_mut();
                let mut target = &mut *data;
                for key in &path {
                    target = match key { Key::Name(key) => target.get_mut(key), Key::Index(index) => target.get_mut(*index) }.ok_or("mutation path is missing")?;
                }
                if push { target.as_array_mut().ok_or("push target is not an array")?.push(value); } else { *target = value; }
                observations.push(Observation::Frozen(json!({ "op": "mutate" })));
            },
        }
    }
    Ok(
        json!({ "fenced": fenced, "observations": observations.into_iter().map(Observation::value).collect::<Vec<_>>() }),
    )
}
