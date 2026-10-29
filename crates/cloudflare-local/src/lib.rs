//! Local SDK consumer of the existing borrowed scheduled-job Machine.
use demlik_tea::{
    PlainData,
    data::plain_data,
    durable_object::{
        DoStoreError, DoStoreOptions, DurableTimerError, do_store_with, durable_timer,
    },
    storage::{Migrated, Store},
};
use std::{cell::RefCell, rc::Rc};
use worker::{durable_object, event, js_sys, *};
#[path = "../../tea/examples/support/scheduled_jobs.rs"]
mod scheduled_jobs;
mod transactions;
use scheduled_jobs::{Fire, Model, machine, view};

mod sdk_fault;
mod sdk_storage;
use sdk_storage::{BindingError, SdkStorage};
fn binding_error(error: BindingError) -> worker::Error {
    match error {
        BindingError::Sdk(error) => error,
        other => host_error(other),
    }
}
fn snapshot_error(
    error: DoStoreError<BindingError, demlik_tea::data::DependencyError>,
) -> worker::Error {
    match error {
        DoStoreError::Storage { cause, .. } => binding_error(cause),
        other => host_error(other),
    }
}
fn timer_error(
    error: DurableTimerError<BindingError, worker::Error, worker::Error>,
) -> worker::Error {
    match error {
        DurableTimerError::Alarm(error) => binding_error(error),
        DurableTimerError::Deadline(error) | DurableTimerError::Fire(error) => error,
    }
}
fn host_error(error: impl std::fmt::Display) -> worker::Error {
    worker::Error::RustError(error.to_string())
}

#[durable_object(alarm)]
pub struct Jobs {
    state: State,
}
impl Jobs {
    async fn callback(&self, action: &str, schedule: Option<[f64; 3]>) -> worker::Result<Response> {
        let owner = Rc::new(());
        let storage = Rc::new(SdkStorage::new(self.state.storage()));
        let parse = |raw: PlainData| {
            let value = serde_json::to_value(raw).expect("plain JSON data");
            Migrated::State(Model {
                pending: serde_json::from_value(value["pending"].clone())
                    .expect("validated snapshot"),
                done: serde_json::from_value(value["done"].clone()).expect("validated snapshot"),
                owner: &owner,
            })
        };
        let store = do_store_with(
            storage.clone(),
            parse,
            |m: &Model<'_>| plain_data(&view(m)),
            DoStoreOptions::default(),
        );
        let raw = store.load().await.map_err(snapshot_error)?;
        let raw_value = serde_json::to_value(&raw).map_err(host_error)?;
        let loaded = if raw_value.is_null() {
            None
        } else {
            // Persisted data is validated before the domain migration boundary.
            #[derive(serde::Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Snapshot {
                pending: Vec<f64>,
                done: Vec<f64>,
            }
            let checked: Snapshot = serde_json::from_value(raw_value).map_err(host_error)?;
            if checked
                .pending
                .iter()
                .chain(&checked.done)
                .any(|x| !x.is_finite())
            {
                return Err(host_error("invalid stored deadline"));
            }
            let Migrated::State(model) = store.migrate(raw) else {
                return Err(host_error("snapshot migration failed"));
            };
            Some(model)
        };
        let machine = machine();
        let model = RefCell::new(
            (machine.init)(
                Some(loaded.unwrap_or(Model {
                    pending: vec![],
                    done: vec![],
                    owner: &owner,
                })),
                &(),
            )
            .state,
        );
        let timer = durable_timer(
            storage.as_ref(),
            || async { Ok::<_, worker::Error>(model.borrow().pending.first().copied()) },
            || async {
                let now = js_sys::Date::now();
                loop {
                    let due = model.borrow().pending.first().is_some_and(|at| *at <= now);
                    if !due {
                        break;
                    }
                    let next = machine
                        .update
                        .apply(&model.borrow(), &Fire)
                        .map_err(|e| host_error(format!("transition: {e:?}")))?
                        .state;
                    store.save(&next).await.map_err(snapshot_error)?;
                    console_log!(
                        "{}",
                        serde_json::json!({"event":"transition_saved", "model":view(&next)})
                    );
                    *model.borrow_mut() = next;
                }
                Ok::<_, worker::Error>(())
            },
        );
        match action {
            "seed" => {
                if !model.borrow().pending.is_empty() || !model.borrow().done.is_empty() {
                    return Response::error("already seeded", 409);
                }
                let now = js_sys::Date::now();
                model.borrow_mut().pending = schedule
                    .unwrap_or([now + 20_000.0, now + 40_000.0, now + 60_000.0])
                    .to_vec();
                let snapshot = model.borrow().clone();
                store.save(&snapshot).await.map_err(snapshot_error)?;
                timer.rearm().await.map_err(timer_error)?;
            }
            "alarm" | "repeat" => {
                console_log!(
                    "{}",
                    serde_json::json!({"event":"callback", "origin":action, "at":js_sys::Date::now(), "model":view(&model.borrow())})
                );
                timer.on_alarm().await.map_err(timer_error)?;
            }
            _ => {}
        }
        storage.storage.sync().await?;
        let alarm = storage.storage.get_alarm().await?;
        let stored_json = storage.storage.get::<String>("@@state").await?;
        Response::from_json(
            &serde_json::json!({"model":view(&model.borrow()), "alarm":alarm, "stored_json":stored_json}),
        )
    }
}
impl DurableObject for Jobs {
    fn new(state: State, _: Env) -> Self {
        console_log!(
            "{}",
            serde_json::json!({"event":"constructor", "at":js_sys::Date::now()})
        );
        Self { state }
    }
    async fn fetch(&self, mut request: Request) -> worker::Result<Response> {
        match (request.method(), request.path().as_str()) {
            (Method::Get, "/adapter-profile") => {
                transactions::profile(SdkStorage::new(self.state.storage())).await
            }
            (Method::Post, "/transactions") => {
                let body = request.text().await?;
                transactions::command(SdkStorage::new(self.state.storage()), &body).await
            }
            (Method::Post, "/seed") => {
                let body = request.text().await?;
                let schedule = if body.is_empty() {
                    None
                } else {
                    #[derive(serde::Deserialize)]
                    #[serde(deny_unknown_fields)]
                    struct Seed {
                        jobs: [f64; 3],
                    }
                    let Ok(seed) = serde_json::from_str::<Seed>(&body) else {
                        return Response::error("invalid schedule JSON", 400);
                    };
                    if seed.jobs.iter().any(|at| {
                        !at.is_finite() || at.fract() != 0.0 || !(0.0..=8.64e15).contains(at)
                    }) || seed.jobs[0] <= js_sys::Date::now()
                        || !seed.jobs.windows(2).all(|pair| pair[0] < pair[1])
                    {
                        return Response::error("invalid future schedule", 400);
                    }
                    Some(seed.jobs)
                };
                self.callback("seed", schedule).await
            }
            (Method::Post, "/repeat") => {
                request.bytes().await?;
                self.callback("repeat", None).await
            }
            (Method::Get, "/state") => self.callback("state", None).await,
            _ => Response::error("not found", 404),
        }
    }
    async fn alarm(&self) -> worker::Result<Response> {
        self.callback("alarm", None).await
    }
}
#[event(fetch)]
pub async fn fetch(request: Request, env: Env, _: Context) -> worker::Result<Response> {
    env.durable_object("JOBS")?
        .id_from_name("three-jobs")?
        .get_stub()?
        .fetch_with_request(request)
        .await
}
