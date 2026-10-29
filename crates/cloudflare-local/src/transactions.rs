//! Small consumer of the generic storage and fenced snapshot interfaces.
use super::{BindingError, SdkStorage, binding_error, host_error};
use demlik_tea::{
    data::plain_data,
    durable_object::{
        DoStoreError, DoStoreOptions, DurableObjectStorage, TransactionError, do_store_with,
    },
    storage::{DeletableStore, Fencing, Migrated, Store, StoredCell},
};
use futures::{
    channel::oneshot,
    future::{Either, pending, select},
};
use std::{cell::RefCell, rc::Rc};
use worker::{Response, js_sys, wasm_bindgen::JsValue};

type Value = serde_json::Value;
fn key(value: &str) -> demlik_tea::data::JsText {
    value.into()
}
fn text(value: &str) -> StoredCell {
    StoredCell::String(key(value))
}
fn sdk_value(error: &BindingError) -> Option<JsValue> {
    match error {
        BindingError::Sdk(
            worker::Error::UnknownJsError { original, .. } | worker::Error::Internal(original),
        ) => Some(original.clone()),
        _ => None,
    }
}
fn sdk_message(error: &BindingError) -> String {
    sdk_value(error)
        .and_then(|value| js_sys::Reflect::get(&value, &"message".into()).ok())
        .and_then(|value| value.as_string())
        .unwrap_or_else(|| error.to_string())
}
fn transaction_error<E: std::fmt::Display>(
    error: TransactionError<BindingError, E>,
) -> worker::Error {
    match error {
        TransactionError::Storage(error) => binding_error(error),
        TransactionError::Body(error) => host_error(error),
    }
}
enum RichError<'a> {
    Sdk(BindingError),
    Body {
        owner: &'a Rc<()>,
        payload: Box<u32>,
    },
}
struct Counter<'a> {
    count: i32,
    owner: &'a Rc<()>,
}

pub(super) async fn command(storage: SdkStorage, body: &str) -> worker::Result<Response> {
    #[derive(serde::Deserialize, serde::Serialize, PartialEq, Eq)]
    #[serde(rename_all = "kebab-case")]
    enum Action {
        Reset,
        Commit,
        Rollback,
        SdkError,
        SdkReject,
        CommitReject,
        Cancel,
        Fenced,
        Delete,
        FencedDelete,
        Inspect,
    }
    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Command {
        action: Action,
    }
    let Ok(command) = serde_json::from_str::<Command>(body) else {
        return Response::error("invalid transaction command", 400);
    };
    let mut outcome = Value::Null;
    let storage = Rc::new(storage);
    match command.action {
        Action::Reset => {
            let cells = storage.list(key("tx/")).await.map_err(binding_error)?;
            if !cells.is_empty() {
                storage
                    .delete(cells.into_iter().map(|(key, _)| key).collect())
                    .await
                    .map_err(binding_error)?;
            }
        }
        Action::Commit => {
            let owner = Rc::new(());
            let owner_ref = &owner;
            let result = storage
                .transaction(|txn| async move {
                    txn.put(key("tx/commit/a"), text("kept")).await?;
                    txn.put(key("tx/commit/b"), StoredCell::Number(7.0)).await?;
                    txn.put(key("tx/other"), StoredCell::Bool(false)).await?;
                    txn.put(key("tx/null"), StoredCell::Null).await?;
                    txn.put(
                        key("tx/commit/u"),
                        StoredCell::String(demlik_tea::data::JsText::from_units(vec![0xd800])),
                    )
                    .await?;
                    let cells = txn.list(key("tx/commit/")).await?;
                    if cells.len() != 3 {
                        return Err(BindingError::Sdk(host_error(
                            "transaction prefix query failed",
                        )));
                    }
                    Ok(owner_ref)
                })
                .await
                .map_err(transaction_error)?;
            outcome = serde_json::json!({"kind":"commit", "borrowed_result":std::ptr::eq(result, &owner)});
        }
        Action::Rollback => {
            let owner = Rc::new(());
            let payload = Box::new(41_u32);
            let original = &*payload as *const u32;
            let owner_ref = &owner;
            let result = storage
                .transaction(|txn| async move {
                    // The rich error deliberately has no Clone, Debug, Serialize or Display.
                    txn.put(key("tx/rollback/a"), text("must disappear"))
                        .await
                        .map_err(RichError::Sdk)?;
                    txn.put(key("tx/rollback/b"), StoredCell::Number(99.0))
                        .await
                        .map_err(RichError::Sdk)?;
                    txn.delete(vec![key("tx/commit/a")])
                        .await
                        .map_err(RichError::Sdk)?;
                    Err::<(), _>(RichError::Body {
                        owner: owner_ref,
                        payload,
                    })
                })
                .await;
            outcome = match result {
                Err(TransactionError::Body(RichError::Body {
                    owner: received_owner,
                    payload,
                })) => {
                    serde_json::json!({"kind":"body", "original_error":std::ptr::eq(&*payload, original), "borrowed_owner":std::ptr::eq(received_owner, &owner), "payload":*payload})
                }
                Err(TransactionError::Body(RichError::Sdk(error))) => {
                    return Err(binding_error(error));
                }
                Err(TransactionError::Storage(error)) => return Err(binding_error(error)),
                Ok(()) => return Err(host_error("body failure unexpectedly committed")),
            };
        }
        Action::SdkError => {
            let original = RefCell::new(None);
            let original_ref = &original;
            let result = storage
                .transaction(|txn| async move {
                    txn.put(key("tx/sdk/before"), text("must disappear"))
                        .await?;
                    txn.transaction
                        .as_ref()
                        .expect("transaction carrier")
                        .rollback()
                        .map_err(BindingError::Sdk)?;
                    match txn
                        .put(key("tx/sdk/after"), text("invalid after rollback"))
                        .await
                    {
                        Ok(()) => Ok(()),
                        Err(error) => {
                            *original_ref.borrow_mut() = sdk_value(&error);
                            Err(error)
                        }
                    }
                })
                .await;
            outcome = match result {
                Err(TransactionError::Body(error)) => {
                    let identity = sdk_value(&error)
                        .zip(original.into_inner())
                        .is_some_and(|(left, right)| js_sys::Object::is(&left, &right));
                    serde_json::json!({"kind":"sdk", "original_error":identity, "message":sdk_message(&error)})
                }
                Err(TransactionError::Storage(error)) => return Err(binding_error(error)),
                Ok(()) => {
                    return Err(host_error(
                        "rolled-back transaction unexpectedly accepted write",
                    ));
                }
            };
        }
        Action::SdkReject | Action::CommitReject => {
            let at_commit = command.action == Action::CommitReject;
            let fault = super::sdk_fault::Fault::install(&storage.storage, at_commit)?;
            let ran = std::cell::Cell::new(false);
            let ran_ref = &ran;
            let result = storage
                .transaction(|txn| async move {
                    ran_ref.set(true);
                    txn.put(key("tx/rejected"), text("must disappear")).await?;
                    Ok::<_, BindingError>(())
                })
                .await;
            outcome = match result {
                Err(TransactionError::Storage(error)) => {
                    serde_json::json!({"kind":command.action,"original_error":sdk_value(&error).is_some_and(|value| js_sys::Object::is(&value, &fault.error)),"body_ran":ran.get(),"message":sdk_message(&error)})
                }
                Err(TransactionError::Body(error)) => return Err(binding_error(error)),
                Ok(()) => return Err(host_error("SDK rejection unexpectedly accepted")),
            };
            fault.restore()?;
        }
        Action::Cancel => {
            let (ready, received) = oneshot::channel();
            let transaction = Box::pin(storage.transaction(|txn| async move {
                txn.put(key("tx/cancel/a"), text("must disappear")).await?;
                let _ = ready.send(());
                pending::<()>().await;
                Ok::<_, BindingError>(())
            }));
            match select(received, transaction).await {
                Either::Left((Ok(()), transaction)) => drop(transaction),
                _ => return Err(host_error("cancel checkpoint did not arrive")),
            }
            // A subsequent real transaction serializes after cancellation rollback.
            storage
                .transaction(|_| async { Ok::<_, BindingError>(()) })
                .await
                .map_err(transaction_error)?;
            outcome = serde_json::json!({"kind":"cancelled"});
        }
        Action::Fenced | Action::FencedDelete => {
            let owner = Rc::new(());
            let store = do_store_with(
                Rc::clone(&storage),
                |raw| {
                    let value = serde_json::to_value(raw).expect("plain counter");
                    Migrated::State(Counter {
                        count: value["count"].as_i64().expect("counter integer") as i32,
                        owner: &owner,
                    })
                },
                |state: &Counter<'_>| {
                    assert!(Rc::ptr_eq(state.owner, &owner));
                    plain_data(&serde_json::json!({"count":state.count}))
                },
                DoStoreOptions {
                    key: Some(key("tx/fenced")),
                },
            )
            .fenced();
            if command.action == Action::FencedDelete {
                let old_owner = store.load_fenced().await.map_err(host_error)?;
                store.delete().await.map_err(host_error)?;
                let deleted = store.load_fenced().await.map_err(host_error)?;
                outcome = match store
                    .save_fenced(
                        &Counter {
                            count: 200,
                            owner: &owner,
                        },
                        old_owner.version,
                    )
                    .await
                {
                    Err(DoStoreError::Conflict(error)) => serde_json::json!({
                        "kind":"fenced-delete", "deleted_version":deleted.version.snapshot(),
                        "deleted_state":deleted.raw, "expected":error.expected_version.snapshot(),
                        "actual":error.actual_version.snapshot(), "state":store.load().await.map_err(host_error)?,
                    }),
                    Err(error) => return Err(host_error(error)),
                    Ok(_) => {
                        return Err(host_error("deleted store unexpectedly accepted old owner"));
                    }
                };
            } else {
                let first = store.load_fenced().await.map_err(host_error)?;
                let stale = store.load_fenced().await.map_err(host_error)?;
                let version = store
                    .save_fenced(
                        &Counter {
                            count: 1,
                            owner: &owner,
                        },
                        first.version,
                    )
                    .await
                    .map_err(host_error)?;
                outcome = match store
                    .save_fenced(
                        &Counter {
                            count: 100,
                            owner: &owner,
                        },
                        stale.version,
                    )
                    .await
                {
                    Err(DoStoreError::Conflict(error)) => {
                        serde_json::json!({"kind":"fenced", "version":version.snapshot(), "expected":error.expected_version.snapshot(), "actual":error.actual_version.snapshot(), "state":store.load().await.map_err(host_error)?})
                    }
                    Err(error) => return Err(host_error(error)),
                    Ok(_) => return Err(host_error("stale writer unexpectedly accepted")),
                };
            }
        }
        Action::Delete => {
            storage
                .transaction(|txn| async move {
                    txn.delete(vec![
                        key("tx/commit/a"),
                        key("tx/commit/b"),
                        key("tx/commit/u"),
                    ])
                    .await
                })
                .await
                .map_err(transaction_error)?;
            outcome = serde_json::json!({"kind":"delete"});
        }
        Action::Inspect => (),
    }
    finish(storage, outcome).await
}
async fn finish(storage: Rc<SdkStorage>, outcome: Value) -> worker::Result<Response> {
    storage.storage.sync().await?;
    let cells = storage.list(key("tx/")).await.map_err(binding_error)?;
    let cells: Vec<_> = cells
        .into_iter()
        .map(|(key, value)| (key, value.snapshot()))
        .collect();
    #[derive(serde::Serialize)]
    struct Report {
        outcome: Value,
        cells: Vec<(demlik_tea::data::JsText, demlik_tea::PlainData)>,
    }
    Response::from_json(&Report { outcome, cells })
}

pub(super) async fn profile(storage: SdkStorage) -> worker::Result<Response> {
    let key_error = storage
        .get(demlik_tea::data::JsText::from_units(vec![0xd800]))
        .await;
    let key_rejected = matches!(key_error, Err(BindingError::UnsupportedKeyUtf16));
    let array = StoredCell::from(demlik_tea::PlainData::Array(vec![]));
    let array_write_rejected = matches!(
        storage.put(key("profile/array"), array).await,
        Err(BindingError::UnsupportedCell)
    );
    storage.storage.put("profile/raw", vec![1_u32]).await?;
    let raw_read_rejected = matches!(
        storage.get(key("profile/raw")).await,
        Err(BindingError::UnsupportedCell)
    );
    let raw_list_rejected = matches!(
        storage.list(key("profile/")).await,
        Err(BindingError::UnsupportedCell)
    );
    storage.storage.delete("profile/raw").await?;
    let nested_rejected = storage
        .transaction(|txn| async move {
            Ok::<_, BindingError>(matches!(
                txn.transaction(|_| async { Ok::<_, BindingError>(()) })
                    .await,
                Err(TransactionError::Storage(
                    BindingError::UnsupportedNestedTransaction
                ))
            ))
        })
        .await
        .map_err(transaction_error)?;
    let early_body_ran = std::cell::Cell::new(false);
    let mut abandoned = Box::pin(storage.transaction(|_| async {
        early_body_ran.set(true);
        Ok::<_, BindingError>(())
    }));
    if !futures::poll!(abandoned.as_mut()).is_pending() {
        return Err(host_error(
            "cancel-before-callback transaction unexpectedly settled",
        ));
    }
    drop(abandoned);
    storage
        .transaction(|_| async { Ok::<_, BindingError>(()) })
        .await
        .map_err(transaction_error)?;
    let cancel_before_callback = !early_body_ran.get();
    let missing = matches!(
        storage
            .get(key("profile/missing"))
            .await
            .map_err(binding_error)?,
        StoredCell::Undefined
    );
    let remaining = storage.list(key("profile/")).await.map_err(binding_error)?;
    Response::from_json(
        &serde_json::json!({"key_utf16_rejected":key_rejected,"array_write_rejected":array_write_rejected,"raw_array_read_rejected":raw_read_rejected,"raw_array_list_rejected":raw_list_rejected,"nested_rejected":nested_rejected,"missing_is_undefined":missing,"cancel_before_callback":cancel_before_callback,"no_profile_writes":remaining.is_empty()}),
    )
}
