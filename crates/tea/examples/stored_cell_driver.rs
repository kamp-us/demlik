use demlik_tea::{
    PlainData,
    data::JsText,
    durable_object::{DoStoreError, DurableObjectStorage, do_store_with},
    storage::{Fencing, Migrated, StoreConflictError, StoredCell},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    cell::RefCell,
    collections::BTreeMap,
    io::{self, BufRead},
    rc::Rc,
};
#[allow(dead_code)]
#[path = "../tests/support/controlled_storage.rs"]
mod controlled_storage;
#[allow(dead_code)]
#[path = "../tests/support/durable_storage.rs"]
mod durable_storage;
#[allow(dead_code)]
#[path = "../../parity/src/paginate_queue/wire.rs"]
mod wire;
use controlled_storage::{
    Behavior, ControlledStorage, Gate, Operation, Rule, Stage, StorageFailure,
};
use durable_storage::{Call, MemoryStorage};
use wire::{data, normalized, text};
type Calls = Rc<RefCell<Vec<&'static str>>>;
macro_rules! observe {($calls:expr,$function:path $(,$arg:expr)*$(,)?)=>{{ $calls.borrow_mut().push(stringify!($function));$function($($arg),*) }};}

#[derive(Deserialize)]
#[serde(tag = "target", rename_all = "camelCase", deny_unknown_fields)]
enum Script {
    Cells {
        #[serde(rename = "cloneReads")]
        clone_reads: bool,
        values: Vec<Named>,
        actions: Vec<Action>,
    },
    Runtime {
        profile: ProfileInput,
        seed: Value,
    },
}
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
enum ProfileInput {
    Promise,
    Effect,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Named {
    id: String,
    value: Value,
}
#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", deny_unknown_fields)]
enum Action {
    Seed {
        key: String,
        reference: String,
    },
    Put {
        key: String,
        reference: String,
    },
    Get {
        key: String,
        alias: String,
    },
    List {
        prefix: String,
        alias: String,
    },
    Clone {
        reference: String,
        alias: String,
    },
    Same {
        left: String,
        right: String,
    },
    Peek {
        reference: String,
    },
    ReplaceArray {
        reference: String,
        values: Vec<Value>,
    },
    Insert {
        reference: String,
        key: String,
        value: Value,
    },
    LoadFenced {
        alias: String,
    },
    SaveFenced {
        expected: String,
        state: Value,
        alias: String,
    },
    NewError {
        expected: String,
        actual: String,
        alias: String,
    },
    ErrorView {
        reference: String,
    },
    CodecMutation {
        reference: String,
        values: Vec<Value>,
    },
    CodecFault {
        message: String,
        value: Value,
    },
    Fault {
        at: Operation,
        stage: Stage,
        key: Option<String>,
        message: String,
        value: Value,
    },
    Race {
        expected: String,
        first: Value,
        second: Value,
        at: Operation,
        stage: Stage,
        alias: String,
        mutation: Option<Vec<Value>>,
    },
    ParallelGet {
        first: String,
        second: String,
        stage: Stage,
        order: CompletionOrder,
        alias: String,
    },
}
#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum CompletionOrder {
    Forward,
    Reverse,
}
#[derive(Debug)]
struct CodecIssue {
    message: String,
    value: PlainData,
}
impl std::fmt::Display for CodecIssue {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
type Error = DoStoreError<StorageFailure, CodecIssue>;
fn view(error: &Error) -> Value {
    match error {
        DoStoreError::Conflict(error) => {
            json!({"kind":"conflict","name":error.name(),"tag":error.tag(),"message":text(error.message()),"expected":normalized(&error.expected_version.snapshot()),"actual":normalized(&error.actual_version.snapshot())})
        }
        DoStoreError::Coercion(error) => {
            json!({"kind":"type","name":error.name,"message":error.message})
        }
        DoStoreError::Storage { operation, cause } => {
            json!({"kind":"storage","at":operation,"stage":cause.stage.name(),"message":cause.message,"value":normalized(&cause.value)})
        }
        DoStoreError::Encode(error) => {
            json!({"kind":"codec","message":error.message,"value":normalized(&error.value)})
        }
        error => json!({"kind":"unexpected","message":error.to_string()}),
    }
}
fn storage_calls(storage: &ControlledStorage) -> Vec<Value> {
    storage
        .inner
        .calls
        .borrow()
        .iter()
        .map(|call| match call {
            Call::Get(key) => json!({"op":"get","key":text(key)}),
            Call::Put(key, value) => json!({"op":"put","key":text(key),"value":normalized(value)}),
            Call::Delete(keys) => {
                json!({"op":"delete","keys":keys.iter().map(text).collect::<Vec<_>>()})
            }
            Call::List(prefix) => json!({"op":"list","prefix":text(prefix)}),
            Call::Begin => json!({"op":"transactionBegin"}),
            Call::Commit => json!({"op":"transactionCommit"}),
            Call::Rollback => json!({"op":"transactionRollback"}),
            Call::Control(value) => normalized(value),
        })
        .collect()
}
fn cells(storage: &ControlledStorage) -> Value {
    json!(
        storage
            .inner
            .cells()
            .iter()
            .map(|(key, value)| json!([text(key), normalized(value)]))
            .collect::<Vec<_>>()
    )
}
fn reference(values: &BTreeMap<String, StoredCell>, id: &str) -> Result<StoredCell, String> {
    values
        .get(id)
        .cloned()
        .ok_or_else(|| format!("missing fixture reference {id}"))
}
struct Model(PlainData);
async fn execute_cells(
    clone_reads: bool,
    initial: Vec<Named>,
    actions: Vec<Action>,
) -> Result<Value, String> {
    let calls = Calls::default();
    let storage = Rc::new(ControlledStorage::with_inner(
        MemoryStorage::with_cloned_reads(clone_reads),
    ));
    let mut values = initial
        .into_iter()
        .map(|value| (value.id, StoredCell::from(data(&value.value))))
        .collect::<BTreeMap<_, _>>();
    let mut errors = BTreeMap::<String, Error>::new();
    let hooks = Rc::new(RefCell::new(Vec::<Value>::new()));
    let mutation = Rc::new(RefCell::new(None::<(StoredCell, Vec<PlainData>)>));
    let fault = Rc::new(RefCell::new(None::<CodecIssue>));
    let (h, m, f) = (Rc::clone(&hooks), Rc::clone(&mutation), Rc::clone(&fault));
    let store = observe!(
        &calls,
        do_store_with,
        Rc::clone(&storage),
        |raw| Migrated::State(Model(raw)),
        move |model: &Model| {
            h.borrow_mut()
                .push(json!({"op":"serialize","state":normalized(&model.0)}));
            let pending = m.borrow_mut().take();
            if let Some((StoredCell::Array(array), replacement)) = pending {
                let old = array.replace(replacement);
                h.borrow_mut()
                    .push(json!({"op":"codecMutation","old":normalized(&PlainData::Array(old))}));
            }
            let failure = f.borrow_mut().take();
            if let Some(error) = failure {
                return Err(error);
            }
            Ok(model.0.clone())
        },
        Default::default()
    )
    .fenced();
    let mut comparison = vec![];
    let (mut call_cursor, mut hook_cursor) = (0, 0);
    for action in actions {
        let result: Value = match action {
            Action::Seed { key, reference: id } => {
                storage.inner.seed(key, reference(&values, &id)?);
                Value::Null
            }
            Action::Put { key, reference: id } => {
                observe!(
                    &calls,
                    DurableObjectStorage::put,
                    &*storage,
                    key.into(),
                    reference(&values, &id)?
                )
                .await
                .map_err(|e| e.to_string())?;
                Value::Null
            }
            Action::Get { key, alias } => {
                let value = observe!(&calls, DurableObjectStorage::get, &*storage, key.into())
                    .await
                    .map_err(|e| e.to_string())?;
                let output = normalized(&value.snapshot());
                values.insert(alias, value);
                output
            }
            Action::List { prefix, alias } => {
                let rows = observe!(&calls, DurableObjectStorage::list, &*storage, prefix.into())
                    .await
                    .map_err(|e| e.to_string())?;
                let output = json!(
                    rows.iter()
                        .map(|(key, value)| json!([text(key), normalized(&value.snapshot())]))
                        .collect::<Vec<_>>()
                );
                for (index, (_, value)) in rows.into_iter().enumerate() {
                    values.insert(format!("{alias}:{index}"), value);
                }
                output
            }
            Action::Clone {
                reference: id,
                alias,
            } => {
                values.insert(alias, StoredCell::from(reference(&values, &id)?.snapshot()));
                Value::Null
            }
            Action::Same { left, right } => {
                json!(reference(&values, &left)? == reference(&values, &right)?)
            }
            Action::Peek { reference: id } => normalized(&reference(&values, &id)?.snapshot()),
            Action::ReplaceArray {
                reference: id,
                values: replacement,
            } => {
                let StoredCell::Array(array) = reference(&values, &id)? else {
                    return Err("fixture array required".into());
                };
                normalized(&PlainData::Array(observe!(
                    &calls,
                    demlik_tea::storage::StoredArray::replace,
                    &array,
                    replacement.iter().map(data).collect()
                )))
            }
            Action::Insert {
                reference: id,
                key,
                value,
            } => {
                let StoredCell::Object(object) = reference(&values, &id)? else {
                    return Err("fixture object required".into());
                };
                normalized(
                    &observe!(
                        &calls,
                        demlik_tea::storage::StoredObject::insert,
                        &object,
                        key.into(),
                        data(&value)
                    )
                    .unwrap_or(PlainData::Undefined),
                )
            }
            Action::LoadFenced { alias } => {
                match observe!(&calls, Fencing::load_fenced, &store).await {
                    Ok(read) => {
                        let output = json!({"ok":true,"raw":normalized(&read.raw),"version":normalized(&read.version.snapshot())});
                        values.insert(alias, read.version);
                        output
                    }
                    Err(error) => {
                        let output = json!({"ok":false,"error":view(&error)});
                        errors.insert(alias, error);
                        output
                    }
                }
            }
            Action::SaveFenced {
                expected,
                state,
                alias,
            } => {
                let state = Model(data(&state));
                match observe!(
                    &calls,
                    Fencing::save_fenced,
                    &store,
                    &state,
                    reference(&values, &expected)?
                )
                .await
                {
                    Ok(version) => {
                        let output = json!({"ok":true,"version":normalized(&version.snapshot())});
                        values.insert(alias, version);
                        output
                    }
                    Err(error) => {
                        let output = json!({"ok":false,"error":view(&error)});
                        errors.insert(alias, error);
                        output
                    }
                }
            }
            Action::NewError {
                expected,
                actual,
                alias,
            } => match observe!(
                &calls,
                StoreConflictError::new,
                reference(&values, &expected)?,
                reference(&values, &actual)?
            ) {
                Ok(error) => {
                    let error = DoStoreError::Conflict(error);
                    let output = view(&error);
                    errors.insert(alias, error);
                    output
                }
                Err(error) => {
                    let error = DoStoreError::Coercion(error);
                    let output = view(&error);
                    errors.insert(alias, error);
                    output
                }
            },
            Action::ErrorView { reference: id } => {
                view(errors.get(&id).ok_or("missing fixture error")?)
            }
            Action::CodecMutation {
                reference: id,
                values: replacement,
            } => {
                let value = reference(&values, &id)?;
                if !matches!(value, StoredCell::Array(_)) {
                    return Err("fixture array required".into());
                }
                mutation.replace(Some((value, replacement.iter().map(data).collect())));
                Value::Null
            }
            Action::CodecFault { message, value } => {
                fault.replace(Some(CodecIssue {
                    message,
                    value: data(&value),
                }));
                Value::Null
            }
            Action::Fault {
                at,
                stage,
                key,
                message,
                value,
            } => {
                storage.rule(Rule {
                    operation: at,
                    stage,
                    key: key.map(Into::into),
                    remaining: 1,
                    behavior: Behavior::Fail {
                        message,
                        value: Rc::new(data(&value)),
                    },
                });
                Value::Null
            }
            Action::ParallelGet {
                first,
                second,
                stage,
                order,
                alias,
            } => {
                let gates = [Rc::new(Gate::new("first")), Rc::new(Gate::new("second"))];
                let start = |key: String| {
                    let storage = Rc::clone(&storage);
                    let calls = Rc::clone(&calls);
                    let hooks = Rc::clone(&hooks);
                    tokio::task::spawn_local(async move {
                        let value = observe!(
                            &calls,
                            DurableObjectStorage::get,
                            &*storage,
                            key.clone().into()
                        )
                        .await?;
                        hooks.borrow_mut().push(json!({"op":"getCompletion","key":key,"value":normalized(&value.snapshot())}));
                        Ok::<_, StorageFailure>((key, value))
                    })
                };
                storage.rule(Rule {
                    operation: Operation::Get,
                    stage,
                    key: Some(first.clone().into()),
                    remaining: 1,
                    behavior: Behavior::Hold(Rc::clone(&gates[0])),
                });
                storage.rule(Rule {
                    operation: Operation::Get,
                    stage,
                    key: Some(second.clone().into()),
                    remaining: 1,
                    behavior: Behavior::Hold(Rc::clone(&gates[1])),
                });
                let first = start(first);
                gates[0].wait(1).await;
                let second = start(second);
                gates[1].wait(1).await;
                let mut handles = [Some(first), Some(second)];
                let order = match order {
                    CompletionOrder::Forward => [0, 1],
                    CompletionOrder::Reverse => [1, 0],
                };
                let mut output = vec![];
                for index in order {
                    gates[index].release();
                    let (key, value) = handles[index]
                        .take()
                        .unwrap()
                        .await
                        .map_err(|e| e.to_string())?
                        .map_err(|e| e.to_string())?;
                    output.push(json!([key, normalized(&value.snapshot())]));
                    values.insert(format!("{alias}:{index}"), value);
                }
                json!(output)
            }
            Action::Race {
                expected,
                first,
                second,
                at,
                stage,
                alias,
                mutation,
            } => {
                let key = match at {
                    Operation::Get => Some(JsText::from("@@state@@version")),
                    Operation::Put => Some(JsText::from("@@state")),
                    _ => None,
                };
                let gate = Rc::new(Gate::new("writer"));
                storage.rule(Rule {
                    operation: at,
                    stage,
                    key,
                    remaining: 1,
                    behavior: Behavior::Hold(Rc::clone(&gate)),
                });
                let a = store.clone();
                let version = reference(&values, &expected)?;
                let first = Model(data(&first));
                let log = Rc::clone(&calls);
                let one = tokio::task::spawn_local(async move {
                    observe!(&log, Fencing::save_fenced, &a, &first, version).await
                });
                gate.wait(1).await;
                let b = store.clone();
                let version = reference(&values, &expected)?;
                let second = Model(data(&second));
                let log = Rc::clone(&calls);
                let requested = storage.transaction_requests();
                let two = tokio::task::spawn_local(async move {
                    observe!(&log, Fencing::save_fenced, &b, &second, version).await
                });
                storage.wait_for_transactions(requested + 1).await;
                if let Some(replacement) = mutation {
                    let StoredCell::Array(array) = reference(&values, &expected)? else {
                        return Err("fixture array required".into());
                    };
                    array.replace(replacement.iter().map(data).collect());
                }
                gate.release();
                let mut output = vec![];
                for (index, result) in [
                    one.await.map_err(|e| e.to_string())?,
                    two.await.map_err(|e| e.to_string())?,
                ]
                .into_iter()
                .enumerate()
                {
                    let id = format!("{alias}:{index}");
                    output.push(match result {
                        Ok(version) => {
                            let result =
                                json!({"ok":true,"version":normalized(&version.snapshot())});
                            values.insert(id, version);
                            result
                        }
                        Err(error) => {
                            let result = json!({"ok":false,"error":view(&error)});
                            errors.insert(id, error);
                            result
                        }
                    });
                }
                json!(output)
            }
        };
        let all_calls = storage_calls(&storage);
        let all_hooks = hooks.borrow();
        comparison.push(json!({"result":result,"calls":all_calls[call_cursor..],"hooks":all_hooks[hook_cursor..],"cells":cells(&storage)}));
        call_cursor = all_calls.len();
        hook_cursor = all_hooks.len();
    }
    Ok(json!({"comparison":comparison,"observedRustCalls":&*calls.borrow()}))
}

mod runtime_case {
    use super::*;
    use demlik_tea::{
        Machine, Step, Sub, Tagged, Update,
        command::{CommandContractError, CommandFamily},
        core::Message,
        runtime::{self, NoInterpreter, NoSubscriptions, Options, Persistence, Profile, Runtime},
    };
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
            update: Update::reducer(|state: &Model, msg: &Msg| {
                let _ = &msg.local;
                Step::new(
                    Model {
                        n: state.n + msg.by,
                        local: Rc::clone(&state.local),
                    },
                    vec![],
                )
            }),
            subscriptions: demlik_tea::core::subscriptions(|_| vec![]),
        }
    }
    pub async fn execute(profile: ProfileInput, seed: Value) -> Result<Value, String> {
        let calls = Calls::default();
        let storage = Rc::new(ControlledStorage::new());
        storage.inner.seed("@@state@@version", data(&seed));
        let store = observe!(
            &calls,
            do_store_with,
            Rc::clone(&storage),
            |raw| {
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
            },
            |state: &Model| Ok::<_, CodecIssue>(PlainData::Object(
                [("n".into(), PlainData::Number(state.n))]
                    .into_iter()
                    .collect()
            )),
            Default::default()
        )
        .fenced();
        let profile = match profile {
            ProfileInput::Promise => Profile::Promise,
            ProfileInput::Effect => Profile::Effect,
        };
        let mut trace = vec![];
        for round in 0..2 {
            let mut options: Options<Model, Msg, Error, std::convert::Infallible> =
                Options::new(profile);
            options.store = Some(observe!(&calls, Persistence::new, store.clone()));
            options.clock = Rc::new(|| 0.0);
            let runtime = observe!(
                &calls,
                runtime::launch,
                machine(),
                (),
                NoInterpreter::new(),
                NoSubscriptions::new(),
                options
            );
            observe!(&calls, Runtime::ready, &runtime)
                .await
                .map_err(|e| e.to_string())?;
            let mut snapshot = |phase: &str| {
                let state = observe!(&calls, Runtime::get_state, &runtime).expect("ready state");
                trace.push(json!({"phase":phase,"n":state.n,"version":normalized(&storage.inner.cell(&"@@state@@version".into()).snapshot())}));
            };
            snapshot(if round == 0 { "boot" } else { "restart" });
            if round == 0 {
                for by in [1.0, 2.0] {
                    observe!(
                        &calls,
                        Runtime::dispatch,
                        &runtime,
                        Msg {
                            by,
                            local: Rc::new(())
                        }
                    )
                    .await
                    .map_err(|e| e.to_string())?;
                    snapshot("dispatch");
                }
            }
            observe!(&calls, Runtime::stop, &runtime).await;
            snapshot(if round == 0 { "stop" } else { "restart-stop" });
        }
        Ok(json!({"comparison":trace,"observedRustCalls":&*calls.borrow()}))
    }
}
#[tokio::main(flavor = "current_thread")]
async fn main() {
    tokio::task::LocalSet::new()
        .run_until(async {
            for line in io::stdin().lock().lines() {
                let response = match line.map_err(|e| e.to_string()).and_then(|line| {
                    serde_json::from_str::<Script>(&line).map_err(|e| e.to_string())
                }) {
                    Ok(script) => tokio::task::spawn_local(async move {
                        match script {
                            Script::Cells {
                                clone_reads,
                                values,
                                actions,
                            } => execute_cells(clone_reads, values, actions).await,
                            Script::Runtime { profile, seed } => {
                                runtime_case::execute(profile, seed).await
                            }
                        }
                    })
                    .await
                    .map_err(|error| error.to_string())
                    .and_then(std::convert::identity),
                    Err(error) => Err(error),
                };
                match response {
                    Ok(value) => println!("{value}"),
                    Err(error) => println!("{}", json!({"error":error})),
                }
            }
        })
        .await;
}
