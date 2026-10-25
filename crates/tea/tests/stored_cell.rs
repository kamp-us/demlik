use demlik_tea::{
    PlainData,
    data::{JsText, decode_json, stringify_json},
    storage::{StoreConflictError, StoredArray, StoredCell, StoredObject},
};
use indexmap::IndexMap;
#[allow(dead_code)]
#[path = "support/durable_storage.rs"]
mod durable_storage;

#[test]
fn primitives_compare_by_value_and_containers_by_the_original_shared_reference() {
    fn send_sync<T: Send + Sync>() {}
    send_sync::<StoredCell>();
    assert_ne!(StoredCell::Number(f64::NAN), StoredCell::Number(f64::NAN));
    assert_eq!(StoredCell::Number(0.0), StoredCell::Number(-0.0));
    assert_ne!(StoredCell::Bool(false), StoredCell::Number(0.0));
    assert_ne!(StoredCell::Null, StoredCell::Undefined);
    assert_eq!(
        StoredCell::String(JsText::from_units(vec![0xd800])),
        StoredCell::String(JsText::from_units(vec![0xd800])),
    );
    let original = StoredCell::from(decode_json(r#"{"n":1}"#).unwrap());
    assert_eq!(original, original.clone());
    assert_ne!(original, StoredCell::from(original.snapshot()));
    let array = StoredCell::Array(StoredArray::new(vec![PlainData::Number(1.0)]));
    assert_eq!(array, array.clone());
    assert_ne!(array, StoredCell::from(array.snapshot()));
}

#[test]
fn formatting_a_container_releases_its_lock_before_calling_the_writer() {
    use std::fmt::Write;
    struct Writer {
        value: StoredArray,
        text: String,
    }
    impl std::fmt::Write for Writer {
        fn write_str(&mut self, text: &str) -> std::fmt::Result {
            self.value.replace(vec![PlainData::Number(9.0)]);
            self.text.push_str(text);
            Ok(())
        }
    }
    let value = StoredArray::new(vec![PlainData::Number(1.0)]);
    let actual = value.clone();
    let (send, receive) = std::sync::mpsc::channel();
    let worker = std::thread::spawn(move || {
        let mut writer = Writer {
            value: actual.clone(),
            text: String::new(),
        };
        write!(&mut writer, "{actual:?}").unwrap();
        send.send(writer.text).unwrap();
    });
    let output = receive
        .recv_timeout(std::time::Duration::from_secs(1))
        .expect("a reentrant formatting sink must not wait on the container lock");
    worker.join().unwrap();
    assert!(output.contains("Number(1.0)"));
    assert!(matches!(
        value.snapshot().as_slice(),
        [PlainData::Number(9.0)]
    ));
}

#[test]
fn a_conflict_freezes_its_message_but_retains_both_mutable_actual_payloads() {
    let expected = StoredArray::new(vec![PlainData::Number(1.0)]);
    let actual = StoredArray::new(vec![PlainData::Number(2.0)]);
    let error = StoreConflictError::new(
        StoredCell::Array(expected.clone()),
        StoredCell::Array(actual.clone()),
    )
    .unwrap();
    let message = "@demlik/tea: store conflict — expected version 1, found 2. Another process has written this state; this run is no longer the single writer and has stopped.";
    assert_eq!(error.message().as_utf8(), Some(message));
    expected.replace(vec![PlainData::Number(3.0)]);
    actual.replace(vec![PlainData::Number(4.0)]);
    assert_eq!(error.message().as_utf8(), Some(message));
    assert_eq!(error.to_string(), message);
    assert_eq!(
        stringify_json(&error.expected_version.snapshot()).unwrap(),
        "[3]"
    );
    assert_eq!(
        stringify_json(&error.actual_version.snapshot()).unwrap(),
        "[4]"
    );
    assert_eq!(error.expected_version, StoredCell::Array(expected));
    assert_eq!(error.actual_version, StoredCell::Array(actual));
}

#[test]
fn a_conflict_preserves_utf16_and_refuses_a_failed_source_string_conversion() {
    let error = StoreConflictError::new(
        StoredCell::String(JsText::from_units(vec![0xd800])),
        StoredCell::Number(0.0),
    )
    .unwrap();
    let mut message = "@demlik/tea: store conflict — expected version "
        .encode_utf16()
        .collect::<Vec<_>>();
    message.push(0xd800);
    message.extend(", found 0".encode_utf16());
    message.extend(". Another process has written this state; this run is no longer the single writer and has stopped.".encode_utf16());
    assert_eq!(error.message().as_units(), message);
    let unprintable = StoredObject::new(IndexMap::from([("toString".into(), PlainData::Null)]));
    let cause = StoreConflictError::new(StoredCell::Object(unprintable), StoredCell::Number(0.0))
        .unwrap_err();
    assert_eq!(cause.name, "TypeError");
    assert_eq!(cause.message, "Cannot convert object to primitive value");
}

#[tokio::test]
async fn storage_get_list_and_put_carry_the_same_actual_container() {
    use demlik_tea::durable_object::DurableObjectStorage;
    let storage = durable_storage::MemoryStorage::new();
    let actual = StoredObject::new(IndexMap::from([("n".into(), PlainData::Number(1.0))]));
    let value = StoredCell::Object(actual.clone());
    storage.put("raw".into(), value.clone()).await.unwrap();
    let read = storage.get("raw".into()).await.unwrap();
    let rows = storage.list("r".into()).await.unwrap();
    assert_eq!(read, value);
    assert_eq!(rows[0].1, value);
    assert!(matches!(
        actual.insert("n".into(), PlainData::Number(2.0)),
        Some(PlainData::Number(1.0))
    ));
    assert_eq!(stringify_json(&read.snapshot()).unwrap(), r#"{"n":2}"#);
    assert_eq!(stringify_json(&rows[0].1.snapshot()).unwrap(), r#"{"n":2}"#);
    assert_ne!(read, StoredCell::from(read.snapshot()));
}

#[tokio::test]
async fn numeric_memory_storage_retains_a_failed_conversion_as_the_actual_cause() {
    use demlik_tea::storage::{Fencing, MemoryStoreError, memory_store};
    let store = memory_store(Some(())).fenced();
    let invalid = StoredCell::from(decode_json(r#"{"toString":null}"#).unwrap());
    let error = store.save_fenced(&(), invalid).await.unwrap_err();
    assert_eq!(error.name(), "TypeError");
    assert_eq!(error.tag(), None);
    assert_eq!(
        std::error::Error::source(&error).unwrap().to_string(),
        "Cannot convert object to primitive value"
    );
    assert!(matches!(error, MemoryStoreError::Coercion(_)));
}

mod runtime_lease {
    use super::*;
    use demlik_tea::{
        Machine, Step, Sub, Tagged, Update,
        command::{CommandContractError, CommandFamily},
        core::Message,
        durable_object::{DoStoreError, do_store_with},
        runtime::{NoInterpreter, NoSubscriptions, Options, Persistence, Profile, launch},
        storage::{Migrated, Store},
    };
    use std::{convert::Infallible, rc::Rc};

    struct Model {
        n: f64,
        local: Rc<()>,
    }
    impl Tagged for Model {
        fn tag(&self) -> &str {
            "counting"
        }
    }
    struct Msg {
        by: f64,
        local: Rc<()>,
    }
    impl Tagged for Msg {
        fn tag(&self) -> &str {
            "inc"
        }
    }
    impl Message for Msg {
        const TYPES: &'static [&'static str] = &["inc"];
    }
    enum Never {}
    impl Tagged for Never {
        fn tag(&self) -> &str {
            match *self {}
        }
    }
    impl CommandFamily for Never {
        type Msg = Msg;
        type Completion = Vec<Msg>;
        fn settle(self, _: Vec<Msg>, _: f64) -> Result<Vec<Msg>, CommandContractError> {
            match self {}
        }
    }
    fn machine() -> Machine<'static, Model, Msg, Never, Sub, ()> {
        Machine {
            init: Box::new(|loaded, _| {
                Step::new(
                    loaded.unwrap_or(Model {
                        n: 0.0,
                        local: Rc::new(()),
                    }),
                    vec![],
                )
            }),
            update: Update::reducer(|state: &Model, message: &Msg| {
                let _opaque_message = &message.local;
                Step::new(
                    Model {
                        n: state.n + message.by,
                        local: Rc::clone(&state.local),
                    },
                    vec![],
                )
            }),
            subscriptions: demlik_tea::core::subscriptions(|_| vec![]),
        }
    }
    fn parse(raw: PlainData) -> Migrated<Model> {
        let PlainData::Object(values) = raw else {
            return Migrated::Fresh;
        };
        match values.get("n") {
            Some(PlainData::Number(n)) => Migrated::State(Model {
                n: *n,
                local: Rc::new(()),
            }),
            _ => Migrated::Fresh,
        }
    }
    fn encode(model: &Model) -> Result<PlainData, Infallible> {
        Ok(PlainData::Object(IndexMap::from([(
            "n".into(),
            PlainData::Number(model.n),
        )])))
    }
    #[tokio::test]
    async fn opaque_models_restart_with_the_actual_raw_version_in_both_runtime_profiles() {
        tokio::task::LocalSet::new()
            .run_until(async {
                for profile in [Profile::Promise, Profile::Effect] {
                    let storage = Rc::new(durable_storage::MemoryStorage::new());
                    storage.seed("@@state@@version", StoredCell::String("v".into()));
                    let store =
                        do_store_with(Rc::clone(&storage), parse, encode, Default::default())
                            .fenced();
                    let mut config: Options<
                        Model,
                        Msg,
                        DoStoreError<Infallible, Infallible>,
                        Infallible,
                    > = Options::new(profile);
                    config.store = Some(Persistence::new(store.clone()));
                    let runtime = launch(
                        machine(),
                        (),
                        NoInterpreter::new(),
                        NoSubscriptions::new(),
                        config,
                    );
                    runtime.ready().await.unwrap();
                    assert_eq!(
                        storage.cell(&"@@state@@version".into()),
                        StoredCell::String("v1".into())
                    );
                    for by in [1.0, 2.0] {
                        runtime
                            .dispatch(Msg {
                                by,
                                local: Rc::new(()),
                            })
                            .await
                            .unwrap();
                    }
                    assert_eq!(runtime.get_state().unwrap().n, 3.0);
                    assert_eq!(
                        storage.cell(&"@@state@@version".into()),
                        StoredCell::String("v111".into())
                    );
                    runtime.stop().await;
                    assert_eq!(
                        storage.cell(&"@@state@@version".into()),
                        StoredCell::String("v1111".into())
                    );
                    let mut config: Options<
                        Model,
                        Msg,
                        DoStoreError<Infallible, Infallible>,
                        Infallible,
                    > = Options::new(profile);
                    config.store = Some(Persistence::new(store.clone()));
                    let resumed = launch(
                        machine(),
                        (),
                        NoInterpreter::new(),
                        NoSubscriptions::new(),
                        config,
                    );
                    resumed.ready().await.unwrap();
                    assert_eq!(resumed.get_state().unwrap().n, 3.0);
                    assert_eq!(
                        storage.cell(&"@@state@@version".into()),
                        StoredCell::String("v11111".into())
                    );
                    assert_eq!(
                        stringify_json(&store.load().await.unwrap()).unwrap(),
                        r#"{"n":3}"#
                    );
                    resumed.stop().await;
                    assert_eq!(
                        storage.cell(&"@@state@@version".into()),
                        StoredCell::String("v111111".into())
                    );
                }
            })
            .await;
    }
}
