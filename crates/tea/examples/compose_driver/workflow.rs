use super::{Calls, Item, Text, ValueSpec, items, view, wire};
use demlik_tea::{Machine, ReadStep, Step, Sub, Tagged, Update, core::Row};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{cell::RefCell, convert::Infallible, rc::Rc, sync::Arc};
macro_rules! observe {($calls:expr,$function:path $(,$arg:expr)*$(,)?)=>{{$calls.borrow_mut().push(stringify!($function));$function($($arg),*)}};}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Cached {
    key: Text,
    slot: usize,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Pending {
    key: Text,
    at: wire::Number,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Loaded {
    cache: Vec<Cached>,
    pending: Vec<Pending>,
    asked: u64,
}
#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", deny_unknown_fields)]
enum Action {
    Ask { key: Text, at: wire::Number },
    Arrive { key: Text, slot: usize },
    Unknown,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Script {
    values: Vec<ValueSpec>,
    messages: Vec<Action>,
    queries: Vec<Text>,
    reversed: bool,
    boot_command: bool,
    loaded: Option<Loaded>,
}
struct Opaque {
    _capability: Box<dyn Fn()>,
}
struct Answer<'a> {
    slot: usize,
    value: &'a Item<'a>,
}
type Cache<'a> = Vec<(demlik_tea::data::JsText, Rc<Answer<'a>>)>;
struct Model<'a> {
    cache: Rc<Cache<'a>>,
    pending: Rc<Vec<(demlik_tea::data::JsText, f64)>>,
    asked: u64,
    context: &'a Opaque,
}
impl Tagged for Model<'_> {
    fn tag(&self) -> &str {
        "lookup"
    }
}
struct Command<'a> {
    kind: &'static str,
    key: Option<demlik_tea::data::JsText>,
    slot: Option<usize>,
    value: Option<&'a Item<'a>>,
}
enum Msg<'a> {
    Ask {
        key: demlik_tea::data::JsText,
        at: f64,
    },
    Arrive {
        key: demlik_tea::data::JsText,
        answer: Rc<Answer<'a>>,
    },
    Unknown,
}
impl Tagged for Msg<'_> {
    fn tag(&self) -> &str {
        match self {
            Self::Ask { .. } => "ask",
            Self::Arrive { .. } => "arrive",
            Self::Unknown => "unknown",
        }
    }
}
enum Status<'a> {
    Ready(Rc<Answer<'a>>),
    Pending(f64),
    Unknown,
}
fn state_view(s: &Model<'_>) -> Value {
    json!({"asked":s.asked,"cache":s.cache.iter().map(|(k,a)|json!({"key":k.as_units(),"slot":a.slot,"value":view(a.value)})).collect::<Vec<_>>(),"pending":s.pending.iter().map(|(k,at)|json!({"key":k.as_units(),"at":wire::number(*at)})).collect::<Vec<_>>()})
}
fn command_view(c: &Command<'_>, values: &[Item<'_>]) -> Value {
    json!({"type":c.kind,"key":c.key.as_ref().map(|k|k.as_units()),"slot":c.slot,"sameOriginal":c.value.zip(c.slot).is_none_or(|(v,i)|std::ptr::eq(v,&values[i]))})
}
fn status(
    s: &Model<'_>,
    key: &demlik_tea::data::JsText,
    reversed: bool,
    calls: &Calls,
    values: &[Item<'_>],
) -> Value {
    let cache = ReadStep {
        name: "cache".into(),
        read: Box::new(|actual: &demlik_tea::data::JsText| {
            Ok::<_, Infallible>(
                s.cache
                    .iter()
                    .find(|(k, _)| k == actual)
                    .map(|(_, v)| Status::Ready(Rc::clone(v))),
            )
        }),
    };
    let pending = ReadStep {
        name: "inFlight".into(),
        read: Box::new(|actual: &demlik_tea::data::JsText| {
            Ok(s.pending
                .iter()
                .find(|(k, _)| k == actual)
                .map(|(_, at)| Status::Pending(*at)))
        }),
    };
    let order = if reversed {
        [&pending, &cache]
    } else {
        [&cache, &pending]
    };
    let answer = match observe!(
        calls,
        demlik_tea::read_in_order,
        key,
        order,
        Status::Unknown
    ) {
        Ok(s) => s,
        Err(never) => match never {},
    };
    match answer {
        Status::Ready(a) => {
            json!({"state":"ready","slot":a.slot,"value":view(a.value),"sameOriginal":std::ptr::eq(a.value,&values[a.slot])})
        }
        Status::Pending(at) => json!({"state":"pending","at":wire::number(at)}),
        Status::Unknown => json!({"state":"unknown"}),
    }
}
struct Context<'a> {
    label: &'a str,
}
pub(super) fn run(script: &Script, calls: &Calls) -> Value {
    let values = items(&script.values);
    let opaque = Opaque {
        _capability: Box::new(|| {}),
    };
    let context_label = String::from("invoice-host");
    let ctx = Context {
        label: &context_label,
    };
    let log = RefCell::new(vec![]);
    let lifts = RefCell::new(vec![]);
    let loaded = script.loaded.as_ref().map(|v| {
        Arc::new(Model {
            cache: Rc::new(
                v.cache
                    .iter()
                    .map(|e| {
                        (
                            e.key.value(),
                            Rc::new(Answer {
                                slot: e.slot,
                                value: &values[e.slot],
                            }),
                        )
                    })
                    .collect(),
            ),
            pending: Rc::new(
                v.pending
                    .iter()
                    .map(|e| (e.key.value(), e.at.value()))
                    .collect(),
            ),
            asked: v.asked,
            context: &opaque,
        })
    });
    let mut row: Row<'_, Arc<Model<'_>>, Msg<'_>, Command<'_>> = Row::new();
    row.insert("ask".into(),Box::new(|s,m|{let Msg::Ask{key,at}=m else{unreachable!()};log.borrow_mut().push(json!(["update","ask",key.as_units()]));
  let mut pending=s.pending.as_ref().clone();match pending.iter_mut().find(|(k,_)|k==key){Some((_,v))=>*v = *at,None=>pending.push((key.clone(),*at))};let pending=Rc::new(pending);let expected=Rc::clone(&pending);let host=Arc::new(Model{cache:Rc::clone(&s.cache),pending:Rc::clone(&s.pending),asked:s.asked+1,context:s.context});let commands=vec![Command{kind:"fetch",key:Some(key.clone()),slot:None,value:None},Command{kind:"audit",key:Some(key.clone()),slot:None,value:None}];let ptr=commands.as_ptr();let capacity=commands.capacity();
  let out=observe!(calls,demlik_tea::lift_slice,Arc::clone(&host),Step::new(pending,commands),|h,pending|Arc::new(Model{cache:Rc::clone(&h.cache),pending,asked:h.asked,context:h.context}));
  lifts.borrow_mut().push(json!({"field":"pending","fresh":!Arc::ptr_eq(&out.state,&host),"sliceIdentity":Rc::ptr_eq(&out.state.pending,&expected),"siblingIdentity":Rc::ptr_eq(&out.state.cache,&host.cache),"contextIdentity":std::ptr::eq(out.state.context,host.context),"commandsOwner":out.commands.as_ptr()==ptr&&out.commands.capacity()==capacity}));log.borrow_mut().push(json!(["read",key.as_units(),status(&out.state,key,script.reversed,calls,&values)]));out
 }));
    row.insert("arrive".into(),Box::new(|s,m|{let Msg::Arrive{key,answer}=m else{unreachable!()};log.borrow_mut().push(json!(["update","arrive",key.as_units()]));let pending=Rc::new(s.pending.iter().filter(|(k,_)|k!=key).cloned().collect::<Vec<_>>());let expected=Rc::clone(&pending);let commands=Vec::<Command<'_>>::new();let ptr=commands.as_ptr();let capacity=commands.capacity();
  let ended=observe!(calls,demlik_tea::lift_slice,Arc::clone(s),Step::new(pending,commands),|h,pending|Arc::new(Model{cache:Rc::clone(&h.cache),pending,asked:h.asked,context:h.context}));
  lifts.borrow_mut().push(json!({"field":"pending","fresh":!Arc::ptr_eq(&ended.state,s),"sliceIdentity":Rc::ptr_eq(&ended.state.pending,&expected),"siblingIdentity":Rc::ptr_eq(&ended.state.cache,&s.cache),"contextIdentity":std::ptr::eq(ended.state.context,s.context),"commandsOwner":ended.commands.as_ptr()==ptr&&ended.commands.capacity()==capacity}));
  let mut cache=ended.state.cache.as_ref().clone();match cache.iter_mut().find(|(k,_)|k==key){Some((_,a))=>*a=Rc::clone(answer),None=>cache.push((key.clone(),Rc::clone(answer)))};let cache=Rc::new(cache);let expected=Rc::clone(&cache);let commands=vec![Command{kind:"ack",key:Some(key.clone()),slot:Some(answer.slot),value:Some(answer.value)},Command{kind:"audit",key:Some(key.clone()),slot:None,value:None}];let ptr=commands.as_ptr();let capacity=commands.capacity();let host=ended.state;
  let out=observe!(calls,demlik_tea::lift_slice,Arc::clone(&host),Step::new(cache,commands),|h,cache|Arc::new(Model{cache,pending:Rc::clone(&h.pending),asked:h.asked,context:h.context}));
  lifts.borrow_mut().push(json!({"field":"cache","fresh":!Arc::ptr_eq(&out.state,&host),"sliceIdentity":Rc::ptr_eq(&out.state.cache,&expected),"siblingIdentity":Rc::ptr_eq(&out.state.pending,&host.pending),"contextIdentity":std::ptr::eq(out.state.context,host.context),"commandsOwner":out.commands.as_ptr()==ptr&&out.commands.capacity()==capacity}));log.borrow_mut().push(json!(["read",key.as_units(),status(&out.state,key,script.reversed,calls,&values)]));out
 }));
    let machine: Machine<'_, Arc<Model<'_>>, Msg<'_>, Command<'_>, Sub, Context<'_>> = Machine {
        init: Box::new(|loaded, ctx| {
            log.borrow_mut().push(json!([
                "init",
                loaded.as_ref().map(|s| state_view(s)),
                ctx.label
            ]));
            Step::new(
                loaded.unwrap_or_else(|| {
                    Arc::new(Model {
                        cache: Rc::new(vec![]),
                        pending: Rc::new(vec![]),
                        asked: 0,
                        context: &opaque,
                    })
                }),
                if script.boot_command {
                    vec![Command {
                        kind: "boot",
                        key: None,
                        slot: None,
                        value: None,
                    }]
                } else {
                    vec![]
                },
            )
        }),
        update: Update::RawReducer(row),
        subscriptions: demlik_tea::core::subscriptions(|s: &Arc<Model<'_>>| {
            log.borrow_mut().push(json!(["subs", s.asked]));
            vec![]
        }),
    };
    let messages = script
        .messages
        .iter()
        .map(|m| match m {
            Action::Ask { key, at } => Msg::Ask {
                key: key.value(),
                at: at.value(),
            },
            Action::Arrive { key, slot } => Msg::Arrive {
                key: key.value(),
                answer: Rc::new(Answer {
                    slot: *slot,
                    value: &values[*slot],
                }),
            },
            Action::Unknown => Msg::Unknown,
        })
        .collect::<Vec<_>>();
    let result = observe!(calls, demlik_tea::replay, &machine, loaded, &ctx, messages);
    match result {
        Ok(done) => {
            json!({"status":"ok","state":state_view(&done.state),"commands":done.commands.iter().map(|c|command_view(c,&values)).collect::<Vec<_>>(),"queries":script.queries.iter().map(|k|{let k=k.value();json!({"key":k.as_units(),"answer":status(&done.state,&k,script.reversed,calls,&values)})}).collect::<Vec<_>>(),"log":log.borrow().clone(),"lifts":lifts.borrow().clone()})
        }
        Err(error) => {
            json!({"status":"refusal","error":{"msg":error.msg_type,"state":error.state_name,"accepted":error.accepted_types},"log":log.borrow().clone(),"lifts":lifts.borrow().clone()})
        }
    }
}
