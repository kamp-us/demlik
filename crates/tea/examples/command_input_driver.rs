use demlik_tea::{
    PlainData,
    command::{
        Cmd, CmdDef, CommandEdge, CommandFamily, CommandRecord, CommandSpec, DecodedInput,
        InputFields, Outcome,
    },
    data::{JsText, NumberOrNull, decode_json, plain_data},
    idempotency::intake::{ProcessInput, ReplayInput, intake_process_def, intake_replay_def},
    persistence::snapshot::{SnapshotWriteInput, snapshot_write_def},
    work_queue::QueueField,
};
use serde::{Deserialize, Serialize, Serializer};
use serde_json::{Value, json};
use std::{
    cell::RefCell,
    io::{self, BufRead},
    rc::Rc,
};
#[path = "../../parity/src/paginate_queue/wire.rs"]
mod wire;
type Calls = Rc<RefCell<Vec<&'static str>>>;
macro_rules! observe{($calls:expr,$function:path $(,$arg:expr)*$(,)?)=>{{let value=$function($($arg),*);$calls.borrow_mut().push(stringify!($function));value}};}
struct HostValue(RefCell<PlainData>);
impl Serialize for HostValue {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        self.0.borrow().serialize(s)
    }
}
struct Cause {
    _capability: Box<dyn Fn()>,
}
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Family {
    Process,
    Replay,
    Snapshot,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Script {
    family: Family,
    fields: Value,
    #[serde(default)]
    round_trip: bool,
    mutate: Option<Value>,
    #[serde(default)]
    fail_decoder: bool,
    name: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Case {
    id: String,
    input: Script,
}
fn take(fields: &mut InputFields, key: &str, calls: &Calls) -> Option<PlainData> {
    observe!(calls, InputFields::take, fields, key)
}
fn text(
    fields: &mut InputFields,
    key: &str,
    calls: &Calls,
    cause: &Rc<Cause>,
) -> Result<JsText, Rc<Cause>> {
    match take(fields, key, calls) {
        Some(PlainData::String(t)) => Ok(t),
        _ => Err(Rc::clone(cause)),
    }
}
fn num(
    fields: &mut InputFields,
    key: &str,
    calls: &Calls,
    cause: &Rc<Cause>,
) -> Result<NumberOrNull, Rc<Cause>> {
    match take(fields, key, calls) {
        Some(PlainData::Number(n)) => Ok(n.into()),
        Some(PlainData::Null) => Ok(NumberOrNull(None)),
        _ => Err(Rc::clone(cause)),
    }
}
fn fields(value: PlainData, calls: &Calls, cause: &Rc<Cause>) -> Result<InputFields, Rc<Cause>> {
    observe!(calls, InputFields::try_from, value).map_err(|_| Rc::clone(cause))
}
fn view<D: CommandSpec>(
    cmd: &Cmd<D>,
    known: impl Fn(&D::Input) -> Option<Rc<HostValue>>,
    original: &Option<Rc<HostValue>>,
    reference: bool,
) -> Value
where
    D::Input: Serialize,
{
    let data = plain_data(cmd).unwrap();
    let PlainData::Object(record) = &data else {
        panic!("record")
    };
    json!({"command":wire::snapshot(cmd),"wire":serde_json::to_string(cmd).unwrap(),"keys":record.keys().map(wire::text).collect::<Vec<_>>(),"knownReferenceSame":if reference{Some(known(cmd.input()).zip(original.clone()).is_some_and(|(a,b)|Rc::ptr_eq(&a,&b)))}else{None}})
}
fn run<D, F, K>(
    def: CmdDef<D>,
    raw: PlainData,
    script: &Script,
    decode: F,
    known: K,
    calls: &Calls,
    cause: &Rc<Cause>,
) -> Value
where
    D: CommandSpec<RawOutput = PlainData, Output = PlainData>,
    D::Input: CommandRecord + Serialize,
    D::Error: Serialize,
    F: Fn(PlainData) -> Result<DecodedInput<D::Input>, Rc<Cause>>,
    K: Fn(&D::Input) -> Option<Rc<HostValue>> + Copy,
{
    let mut invoked = 0;
    let result = observe!(calls, CmdDef::decode_input, &def, raw, |raw| {
        invoked += 1;
        if script.fail_decoder {
            Err(Rc::clone(cause))
        } else {
            decode(raw)
        }
    });
    let mut cmd = match result {
        Ok(cmd) => cmd,
        Err(error) => {
            return json!({"status":"decoderError","sameCause":Rc::ptr_eq(&error,cause),"called":invoked});
        }
    };
    let original = known(cmd.input());
    let reference = original
        .as_ref()
        .is_some_and(|v| matches!(*v.0.borrow(), PlainData::Object(_) | PlainData::Array(_)));
    let before = view(&cmd, known, &original, reference);
    if script.round_trip {
        let PlainData::Object(mut raw) =
            decode_json(&serde_json::to_string(&cmd).unwrap()).unwrap()
        else {
            panic!("record")
        };
        let stored_type = raw.shift_remove("type");
        if !matches!(&stored_type, Some(PlainData::String(t)) if t.as_utf8() == Some(def.cmd_type()))
        {
            return json!({"status":"restoreFamilyRefused","expected":def.cmd_type(),"actual":stored_type.as_ref().map(wire::normalized)});
        }
        cmd = observe!(
            calls,
            CmdDef::decode_input,
            &def,
            PlainData::Object(raw),
            &decode
        )
        .unwrap_or_else(|_| panic!("restore"));
    }
    if let Some(value) = &script.mutate {
        let mut data = original.as_ref().unwrap().0.borrow_mut();
        let PlainData::Object(record) = &mut *data else {
            panic!("mutable object")
        };
        record.insert("changed".into(), wire::data(value));
    }
    let after = view(&cmd, known, &original, reference);
    let edge = CommandEdge::new(|| 17.25);
    let guard = CommandFamily::dispatch_guard(&cmd, &edge);
    let message = observe!(
        calls,
        CommandFamily::settle_in,
        cmd,
        Some(Outcome::ok(PlainData::Undefined)),
        &edge
    )
    .unwrap()
    .pop()
    .unwrap();
    guard.check(&message).unwrap();
    json!({"status":"ok","called":invoked,"before":before,"after":after,"settled":wire::snapshot(&message),"provenanceAccepted":true})
}
fn execute(case: Case) -> Value {
    let calls = Calls::default();
    let cause = Rc::new(Cause {
        _capability: Box::new(|| {}),
    });
    let script = case.input;
    let raw = wire::data(&script.fields);
    let comparison = match script.family {
        Family::Process => {
            let def = observe!(calls, intake_process_def::<HostValue>);
            let def = script
                .name
                .as_ref()
                .map_or(def, |name| observe!(calls, CmdDef::named, name.clone()));
            run(
                def,
                raw,
                &script,
                |raw| {
                    let mut f = fields(raw, &calls, &cause)?;
                    let key = text(&mut f, "key", &calls, &cause)?;
                    let item_id = text(&mut f, "itemId", &calls, &cause)?;
                    let payload = Rc::new(HostValue(RefCell::new(
                        take(&mut f, "payload", &calls).unwrap_or(PlainData::Undefined),
                    )));
                    Ok(f.finish(ProcessInput {
                        key,
                        item_id,
                        payload,
                    }))
                },
                |v| Some(Rc::clone(&v.payload)),
                &calls,
                &cause,
            )
        }
        Family::Replay => {
            let def = observe!(calls, intake_replay_def::<HostValue>);
            let def = script
                .name
                .as_ref()
                .map_or(def, |name| observe!(calls, CmdDef::named, name.clone()));
            run(
                def,
                raw,
                &script,
                |raw| {
                    let mut f = fields(raw, &calls, &cause)?;
                    let key = text(&mut f, "key", &calls, &cause)?;
                    let result = match take(&mut f, "result", &calls) {
                        None => QueueField::Absent,
                        Some(PlainData::Undefined) => QueueField::Undefined,
                        Some(v) => QueueField::Value(Rc::new(HostValue(RefCell::new(v)))),
                    };
                    Ok(f.finish(ReplayInput { key, result }))
                },
                |v| match &v.result {
                    QueueField::Value(v) => Some(Rc::clone(v)),
                    _ => None,
                },
                &calls,
                &cause,
            )
        }
        Family::Snapshot => {
            let def = observe!(calls, snapshot_write_def::<HostValue>);
            let def = script
                .name
                .as_ref()
                .map_or(def, |name| observe!(calls, CmdDef::named, name.clone()));
            run(
                def,
                raw,
                &script,
                |raw| {
                    let mut f = fields(raw, &calls, &cause)?;
                    let key = text(&mut f, "key", &calls, &cause)?;
                    let seq = num(&mut f, "seq", &calls, &cause)?;
                    let at = num(&mut f, "at", &calls, &cause)?;
                    let payload = Rc::new(HostValue(RefCell::new(
                        take(&mut f, "payload", &calls).unwrap_or(PlainData::Undefined),
                    )));
                    Ok(f.finish(SnapshotWriteInput {
                        key,
                        seq,
                        at,
                        payload,
                    }))
                },
                |v| Some(Rc::clone(&v.payload)),
                &calls,
                &cause,
            )
        }
    };
    json!({"id":case.id,"comparison":comparison,"observedRustCalls":calls.borrow().clone()})
}
fn main() {
    for line in io::stdin().lock().lines() {
        let line = line.unwrap();
        if line.trim().is_empty() {
            continue;
        }
        let input: Case = serde_json::from_str(&line).unwrap();
        println!("{}", execute(input));
    }
}
