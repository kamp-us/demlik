use super::{Calls, wire};
use demlik_tea::{
    Machine, PlainData, Step, Sub, Tagged, Update,
    core::Message,
    data::JsText,
    idempotency::intake::{self, Config, Intake, IntakeValue, State},
    pbt::fold_events,
};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{Value, json};
use std::{cell::RefCell, collections::BTreeMap, rc::Rc, sync::Arc};
struct HostValue(PlainData);
impl Serialize for HostValue {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        self.0.serialize(s)
    }
}
impl<'de> Deserialize<'de> for HostValue {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        PlainData::deserialize(d).map(Self)
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Script {
    ttl_ms: Option<wire::Number>,
    loaded: bool,
    round_trip_seed: bool,
    init_boot: bool,
    init_command: bool,
    seed: Vec<Action>,
    messages: Vec<Action>,
}
#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", deny_unknown_fields)]
enum Action {
    Receive {
        slot: usize,
        id: String,
        at: wire::Number,
    },
    Complete {
        key: String,
        slot: usize,
        at: wire::Number,
    },
    Claim {
        at: wire::Number,
    },
    Boot,
    Noop,
    Reuse {
        index: usize,
    },
}
enum Msg {
    Receive {
        payload: Rc<HostValue>,
        id: JsText,
        at: f64,
    },
    Complete {
        key: JsText,
        result: Rc<HostValue>,
        at: f64,
    },
    Claim {
        at: f64,
    },
    Boot,
    Noop,
}
impl Tagged for Msg {
    fn tag(&self) -> &str {
        match self {
            Self::Receive { .. } => "receive",
            Self::Complete { .. } => "complete",
            Self::Claim { .. } => "claim",
            Self::Boot => "boot",
            Self::Noop => "noop",
        }
    }
}
impl Message for Msg {
    const TYPES: &'static [&'static str] = &["receive", "complete", "claim", "boot", "noop"];
}
struct Model(Rc<State<HostValue, HostValue>>);
impl Tagged for Model {
    fn tag(&self) -> &str {
        "intake"
    }
}
enum Cmd {
    Domain(intake::Cmd<HostValue, HostValue>),
    Resume,
}
fn apply(
    intake: &Intake<'_, HostValue, HostValue>,
    s: &Rc<State<HostValue, HostValue>>,
    m: &Msg,
) -> Step<Rc<State<HostValue, HostValue>>, intake::Cmd<HostValue, HostValue>> {
    match m {
        Msg::Receive { payload, id, at } => intake
            .receive(s, Rc::clone(payload), *at, id.clone())
            .unwrap(),
        Msg::Complete { key, result, at } => intake
            .complete(s, key.clone(), IntakeValue::Value(Rc::clone(result)), *at)
            .unwrap(),
        Msg::Claim { at } => Step::new(
            intake
                .claim_next(s, *at)
                .unwrap()
                .map_or_else(|| Rc::clone(s), |c| c.state),
            vec![],
        ),
        Msg::Boot => intake.boot(s).unwrap(),
        Msg::Noop => Step::new(Rc::clone(s), vec![]),
    }
}
#[allow(
    clippy::arc_with_non_send_sync,
    reason = "The fold's original message handles intentionally contain local opaque payloads, without Send bounds."
)]
fn msg(a: Action, p: &[Rc<HostValue>], r: &[Rc<HostValue>], previous: &[Arc<Msg>]) -> Arc<Msg> {
    Arc::new(match a {
        Action::Receive { slot, id, at } => Msg::Receive {
            payload: Rc::clone(&p[slot]),
            id: id.into(),
            at: at.value(),
        },
        Action::Complete { key, slot, at } => Msg::Complete {
            key: key.into(),
            result: Rc::clone(&r[slot]),
            at: at.value(),
        },
        Action::Claim { at } => Msg::Claim { at: at.value() },
        Action::Boot => Msg::Boot,
        Action::Noop => Msg::Noop,
        Action::Reuse { index } => return Arc::clone(&previous[index]),
    })
}
fn index(v: &Rc<HostValue>, pool: &[Rc<HostValue>]) -> Option<usize> {
    pool.iter().position(|x| Rc::ptr_eq(v, x))
}
fn id(ids: &mut BTreeMap<usize, usize>, p: usize) -> usize {
    let next = ids.len();
    *ids.entry(p).or_insert(next)
}
fn state(s: &Model, p: &[Rc<HostValue>], r: &[Rc<HostValue>]) -> Value {
    let encoded =
        demlik_tea::data::stringify_json(&demlik_tea::data::plain_data(&s.0).unwrap()).unwrap();
    let cached =
        s.0.seen
            .entries
            .own_entries()
            .filter_map(|(key, entry)| match entry {
                demlik_tea::js_record::RecordValue::Entry(row) => match &row.value.as_ref() {
                    intake::Entry::Done {
                        result: IntakeValue::Value(v),
                    } => Some(json!([wire::text(key), index(v, r)])),
                    _ => None,
                },
                _ => None,
            })
            .collect::<Vec<_>>();
    json!({"wire":encoded,"queuePayloadRefs":s.0.queue.iter().map(|q|index(&q.input,p)).collect::<Vec<_>>(),"cachedResultRefs":cached})
}
fn command(c: &Cmd, p: &[Rc<HostValue>], r: &[Rc<HostValue>]) -> Value {
    match c {
        Cmd::Resume => json!({"type":"resume"}),
        Cmd::Domain(c) => {
            let (payload, result) = match c {
                intake::Cmd::Process(c) => (index(&c.input().payload, p), None),
                intake::Cmd::Replay(c) => (
                    None,
                    match &c.input().result {
                        IntakeValue::Value(v) => index(v, r),
                        _ => None,
                    },
                ),
            };
            json!({"value":wire::snapshot(c),"wire":serde_json::to_string(c).unwrap(),"payloadRef":payload,"resultRef":result})
        }
    }
}
fn message(m: &Msg, p: &[Rc<HostValue>], r: &[Rc<HostValue>]) -> Value {
    match m {
        Msg::Receive { payload, id, at } => {
            json!({"type":m.tag(),"payload":wire::normalized(&payload.0),"payloadRef":index(payload,p),"id":wire::text(id),"at":wire::number(*at)})
        }
        Msg::Complete { key, result, at } => {
            json!({"type":m.tag(),"key":wire::text(key),"result":wire::normalized(&result.0),"resultRef":index(result,r),"at":wire::number(*at)})
        }
        Msg::Claim { at } => json!({"type":m.tag(),"at":wire::number(*at)}),
        _ => json!({"type":m.tag()}),
    }
}
pub fn run(script: Script, calls: &Calls) -> Value {
    let p = [
        json!({"id":"a","amount":5}),
        json!({"id":"b","amount":9}),
        json!({"id":"a","amount":7}),
    ]
    .map(|v| Rc::new(HostValue(wire::data(&v))));
    let r = [json!({"chargedCents":500}), json!({"chargedCents":900})]
        .map(|v| Rc::new(HostValue(wire::data(&v))));
    let mut config = Config::new(|p: &HostValue| match &p.0 {
        PlainData::Object(v) => match v.get("id") {
            Some(PlainData::String(key)) => Ok(key.clone()),
            _ => panic!("payload id"),
        },
        _ => panic!("payload record"),
    });
    config.ttl_ms = script.ttl_ms.map(wire::Number::value);
    let intake = Rc::new(Intake::new(config));
    let mut seed = intake.init();
    let mut seed_messages = vec![];
    for a in script.seed {
        let m = msg(a, &p, &r, &seed_messages);
        seed = apply(&intake, &seed, &m).state;
        seed_messages.push(m);
    }
    if script.round_trip_seed {
        seed = serde_json::from_str(&serde_json::to_string(&seed).unwrap()).unwrap();
    }
    let loaded = script.loaded.then(|| Model(Rc::clone(&seed)));
    let original = loaded.as_ref().map(|s| Rc::clone(&s.0));
    let log = Rc::new(RefCell::new(vec![]));
    let initial_log = Rc::clone(&log);
    let update_log = Rc::clone(&log);
    let init = Rc::clone(&intake);
    let mut messages = vec![];
    for a in script.messages {
        messages.push(msg(a, &p, &r, &messages));
    }
    let machine: Machine<'_, Model, Msg, Cmd, Sub> = Machine {
        init: Box::new(move |loaded, _| {
            initial_log
                .borrow_mut()
                .push(json!(["init", loaded.is_some()]));
            let mut s = loaded.unwrap_or_else(|| Model(init.init()));
            if script.init_boot {
                s.0 = init.boot(&s.0).unwrap().state;
            }
            Step::new(
                s,
                if script.init_command {
                    vec![Cmd::Resume]
                } else {
                    vec![]
                },
            )
        }),
        update: Update::reducer(move |s: &Model, m: &Msg| {
            update_log.borrow_mut().push(json!(["cell", m.tag()]));
            let t = apply(&intake, &s.0, m);
            Step::new(
                Model(t.state),
                t.commands.into_iter().map(Cmd::Domain).collect(),
            )
        }),
        subscriptions: demlik_tea::core::subscriptions(|_| vec![]),
    };
    let trace = observe!(
        calls,
        fold_events,
        &machine,
        &(),
        loaded,
        messages.iter().cloned()
    )
    .unwrap();
    let mut state_ids = BTreeMap::new();
    if let Some(s) = original {
        id(&mut state_ids, Rc::as_ptr(&s) as usize);
    }
    let state_labels = trace
        .states
        .iter()
        .map(|s| id(&mut state_ids, Rc::as_ptr(&s.0) as usize))
        .collect::<Vec<_>>();
    let mut msg_ids = BTreeMap::new();
    let input_ids = messages
        .iter()
        .map(|m| id(&mut msg_ids, Arc::as_ptr(m) as usize))
        .collect::<Vec<_>>();
    json!({"status":"ok","log":log.borrow().clone(),"inputMsgIds":input_ids,"states":trace.states.iter().zip(&state_labels).map(|(s,id)|json!({"id":id,"value":state(s,&p,&r)})).collect::<Vec<_>>(),"steps":trace.steps.iter().enumerate().map(|(i,t)|json!({"prev":id(&mut state_ids,Rc::as_ptr(&t.prev.0)as usize),"next":id(&mut state_ids,Rc::as_ptr(&t.next.0)as usize),"msgId":id(&mut msg_ids,Arc::as_ptr(&t.msg)as usize),"msg":message(&t.msg,&p,&r),"commands":t.commands.iter().map(|c|command(c,&p,&r)).collect::<Vec<_>>(),"sameState":Rc::ptr_eq(&t.prev.0,&t.next.0),"sameMsg":Arc::ptr_eq(&t.msg,&messages[i]),"prevLink":Arc::ptr_eq(&t.prev,&trace.states[i]),"nextLink":Arc::ptr_eq(&t.next,&trace.states[i+1])})).collect::<Vec<_>>(),"final":id(&mut state_ids,Rc::as_ptr(&trace.final_state.0)as usize),"finalLink":Arc::ptr_eq(&trace.final_state,trace.states.last().unwrap())})
}
