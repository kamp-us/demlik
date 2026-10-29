use demlik_tea::{
    Machine, PlainData, Step, Sub, Tagged, Update,
    data::plain_data,
    durable_object::{
        AlarmStorage, DoStoreOptions, DurableTimerError, do_store_with, durable_timer,
    },
    storage::{Migrated, Store},
};
use serde_json::{Value, json};
use std::{
    cell::RefCell,
    io::{self, Read},
    rc::Rc,
};
#[path = "../tests/support/durable_storage.rs"]
#[allow(dead_code)]
mod durable_storage;
use durable_storage::{Call, MemoryStorage};
type Trace = RefCell<Vec<Value>>;
#[derive(Clone, Debug)]
struct Failure(Rc<Value>);
struct Alarm<'a> {
    trace: &'a Trace,
    alarms: &'a RefCell<Vec<f64>>,
    fault: Option<Failure>,
}
impl AlarmStorage for Alarm<'_> {
    type Error = Failure;
    async fn set_alarm(&self, at: f64) -> Result<(), Failure> {
        self.trace.borrow_mut().push(json!(["alarm", at]));
        if let Some(f) = &self.fault {
            return Err(f.clone());
        }
        self.alarms.borrow_mut().push(at);
        Ok(())
    }
}
#[derive(Clone)]
struct Model<'a> {
    pending: Vec<f64>,
    done: Vec<f64>,
    owner: &'a Rc<()>,
}
fn view(m: &Model<'_>) -> Value {
    json!({"pending":m.pending,"done":m.done})
}
struct Fire;
impl Tagged for Fire {
    fn tag(&self) -> &str {
        "fire"
    }
}
impl demlik_tea::core::Message for Fire {
    const TYPES: &'static [&'static str] = &["fire"];
}
fn machine<'a>() -> Machine<'a, Model<'a>, Fire, (), Sub> {
    Machine {
        init: Box::new(|loaded, _| Step::new(loaded.unwrap(), vec![])),
        update: Update::reducer(|s: &Model<'a>, _: &Fire| {
            let mut done = s.done.clone();
            if let Some(at) = s.pending.first() {
                done.push(*at)
            }
            Step::new(
                Model {
                    pending: s.pending.iter().skip(1).copied().collect(),
                    done,
                    owner: s.owner,
                },
                vec![],
            )
        }),
        subscriptions: demlik_tea::core::subscriptions(|_| vec![]),
    }
}
fn calls(storage: &MemoryStorage, trace: &Trace) {
    for call in storage.calls.borrow_mut().drain(..) {
        trace.borrow_mut().push(match call {
            Call::Get(k) => json!(["get", k]),
            Call::Put(k, v) => json!(["put", k, v]),
            _ => panic!("unexpected storage call"),
        });
    }
}
fn cells(storage: &MemoryStorage) -> Value {
    json!(storage.cells().into_iter().collect::<Vec<_>>())
}
#[tokio::main(flavor = "current_thread")]
async fn main() {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input).unwrap();
    let scripts: Vec<Value> = serde_json::from_str(&input).unwrap();
    let mut out = vec![];
    for script in scripts {
        let owner = Rc::new(());
        let storage = Rc::new(MemoryStorage::new());
        let trace = Trace::default();
        let alarms = RefCell::new(vec![]);
        let mut results = vec![];
        let parse = |raw: PlainData| {
            let v = serde_json::to_value(raw).unwrap();
            Migrated::State(Model {
                pending: serde_json::from_value(v["pending"].clone()).unwrap(),
                done: serde_json::from_value(v["done"].clone()).unwrap(),
                owner: &owner,
            })
        };
        let store = do_store_with(
            storage.clone(),
            parse,
            |m: &Model<'_>| plain_data(&view(m)),
            DoStoreOptions::default(),
        );
        let model = RefCell::new(Model {
            pending: serde_json::from_value(script["jobs"].clone()).unwrap(),
            done: vec![],
            owner: &owner,
        });
        let saved = model.borrow().clone();
        store.save(&saved).await.unwrap();
        calls(&storage, &trace);
        let failure = Failure(Rc::new(
            json!({"phase":script["fault"],"message":"scheduled failure","payload":{"code":17}}),
        ));
        let fault = script["fault"].as_str();
        let alarm = Alarm {
            trace: &trace,
            alarms: &alarms,
            fault: (fault == Some("alarm")).then(|| failure.clone()),
        };
        let held = RefCell::new(false);
        let gate = tokio::sync::Notify::new();
        let machine = machine();
        let new_host = || {
            durable_timer(
                &alarm,
                || async {
                    trace.borrow_mut().push(json!(["deadline"]));
                    if fault == Some("deadline") {
                        return Err(failure.clone());
                    }
                    Ok(model.borrow().pending.first().copied())
                },
                || async {
                    trace.borrow_mut().push(json!(["fire-start"]));
                    if fault == Some("fire") {
                        return Err(failure.clone());
                    }
                    if *held.borrow() {
                        gate.notified().await
                    }
                    let next = machine.update.apply(&model.borrow(), &Fire).unwrap().state;
                    store.save(&next).await.unwrap();
                    *model.borrow_mut() = next;
                    calls(&storage, &trace);
                    trace.borrow_mut().push(json!(["fire-end"]));
                    Ok(())
                },
            )
        };
        let mut host = new_host();
        for action in script["actions"].as_array().unwrap() {
            let action = action.as_str().unwrap();
            let result = match action {
                "cold" => {
                    let raw = store.load().await.unwrap();
                    calls(&storage, &trace);
                    let Migrated::State(state) = store.migrate(raw) else {
                        panic!()
                    };
                    *model.borrow_mut() = state;
                    host = new_host();
                    Ok(())
                }
                "change" => {
                    model.borrow_mut().pending[0] = 777.;
                    let saved = model.borrow().clone();
                    store.save(&saved).await.unwrap();
                    calls(&storage, &trace);
                    Ok(())
                }
                "held" => {
                    *held.borrow_mut() = true;
                    let pending = host.on_alarm();
                    tokio::pin!(pending);
                    tokio::select! {biased; _=&mut pending=>panic!("fire must wait"),_ = std::future::ready(())=>{}}
                    results.push(json!({"held":{"trace":*trace.borrow(),"alarms":*alarms.borrow(),"model":view(&model.borrow()),"cells":cells(&storage)}}));
                    gate.notify_one();
                    let result = pending.await;
                    *held.borrow_mut() = false;
                    result
                }
                "rearm" => host.rearm().await,
                _ => host.on_alarm().await,
            };
            match result {
                Ok(()) => results.push(json!({"action":action,"ok":true})),
                Err(error) => {
                    let cause = match error {
                        DurableTimerError::Fire(e)
                        | DurableTimerError::Deadline(e)
                        | DurableTimerError::Alarm(e) => e,
                    };
                    results.push(json!({"action":action,"ok":false,"error":*cause.0,"sameOriginal":Rc::ptr_eq(&cause.0,&failure.0)}))
                }
            }
        }
        out.push(json!({"name":script["name"],"trace":*trace.borrow(),"alarms":*alarms.borrow(),"model":view(&model.borrow()),"cells":cells(&storage),"results":results}));
    }
    println!("{}", json!(out));
}
