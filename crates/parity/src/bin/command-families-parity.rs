use demlik_tea::{
    Tagged,
    command::{
        CmdContract, CmdDef, CommandContractError, CommandEdge, CommandRecord, CommandSpec,
        Completion, Issue, Outcome, SchemaError,
    },
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::io::{self, BufRead};

macro_rules! observe {($calls:expr,$call:path $(,$arg:expr)* $(,)?)=>{{let result=$call($($arg),*);$calls.push(stringify!($call));result}};}

#[derive(Serialize, Deserialize)]
struct Input {
    key: String,
}
impl CommandRecord for Input {}
#[derive(Serialize, Deserialize)]
struct Rejected {
    #[serde(rename = "_tag")]
    tag: String,
    detail: Vec<u8>,
}
impl Tagged for Rejected {
    fn tag(&self) -> &str {
        &self.tag
    }
}
struct Family;
impl CommandSpec for Family {
    type Input = Input;
    type RawOutput = String;
    type Output = String;
    type Error = Rejected;
    const NAME: &'static str = "default";
    const ERROR_TAGS: &'static [&'static str] = &["declared"];
    fn parse_input(value: Value) -> Result<Input, SchemaError> {
        serde_json::from_value(value).map_err(Into::into)
    }
    fn parse_output(value: String) -> Result<String, SchemaError> {
        if value == "bad" {
            Err(SchemaError::Issues(vec![Issue::new(
                "",
                "expected a useful result",
            )]))
        } else {
            Ok(value.trim().to_uppercase())
        }
    }
}
struct Prefix<const SECOND: bool>;
impl<const SECOND: bool> CommandSpec for Prefix<SECOND> {
    type Input = Input;
    type RawOutput = String;
    type Output = String;
    type Error = Rejected;
    const NAME: &'static str = "prefix";
    const ERROR_TAGS: &'static [&'static str] = &["declared"];
    fn parse_input(value: Value) -> Result<Input, SchemaError> {
        serde_json::from_value(value).map_err(Into::into)
    }
    fn parse_output(value: String) -> Result<String, SchemaError> {
        Ok(format!(
            "{}:{value}",
            if SECOND { "second" } else { "first" }
        ))
    }
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Mode {
    Ok,
    Malformed,
    Declared,
    Undeclared,
    None,
}
impl Mode {
    fn completion(self) -> Completion<Family> {
        match self {
            Self::Ok => Some(Outcome::ok(" value ".into())),
            Self::Malformed => Some(Outcome::ok("bad".into())),
            Self::Declared | Self::Undeclared => Some(Outcome::err(Rejected {
                tag: if matches!(self, Self::Declared) {
                    "declared"
                } else {
                    "other"
                }
                .into(),
                detail: vec![0, 255],
            })),
            Self::None => None,
        }
    }
    fn wire(self) -> Option<Value> {
        self.completion()
            .map(|value| serde_json::to_value(value).unwrap())
    }
}
#[derive(Deserialize)]
struct Case {
    id: String,
    input: Trace,
}
#[derive(Deserialize)]
struct Trace {
    left: String,
    right: String,
    at: f64,
    mode: Mode,
}
fn input(key: &str) -> Input {
    Input { key: key.into() }
}
fn result<T: Serialize>(result: Result<T, CommandContractError>) -> Value {
    match result {
        Ok(value) => serde_json::to_value(value).unwrap(),
        Err(error) => json!({"error":error}),
    }
}
fn check(result: Result<(), CommandContractError>) -> Value {
    match result {
        Ok(()) => json!({"accepted":true}),
        Err(error) => json!({"accepted":false,"error":error}),
    }
}
fn declaration(definition: &CmdDef<Family>) -> Value {
    json!({"cmdType":definition.cmd_type(),"okType":definition.ok_type(),"errType":definition.err_type(),"errorTags":definition.error_tags()})
}
fn execute(trace: Trace, calls: &mut Vec<&'static str>) -> Result<Value, String> {
    let left = observe!(
        calls,
        demlik_tea::command::CmdDef::<Family>::named,
        trace.left
    );
    let right = observe!(
        calls,
        demlik_tea::command::CmdDef::<Family>::named,
        trace.right
    );
    let a = observe!(
        calls,
        demlik_tea::command::CmdDef::<Family>::from_record,
        &left,
        input("a")
    );
    let b = observe!(
        calls,
        demlik_tea::command::CmdDef::<Family>::from_record,
        &right,
        input("b")
    );
    let declarations = json!([declaration(&left), declaration(&right)]);
    let commands = json!([a, b]);
    let a = observe!(
        calls,
        demlik_tea::command::CmdDef::<Family>::restore_command,
        &left,
        commands[0].clone()
    )
    .map_err(|error| error.to_string())?;
    let b = observe!(
        calls,
        demlik_tea::command::CmdDef::<Family>::restore_command,
        &right,
        commands[1].clone()
    )
    .map_err(|error| error.to_string())?;
    let owned = observe!(calls, demlik_tea::command::Cmd::<Family>::definition, &a);
    let owned_name = observe!(
        calls,
        demlik_tea::command::CmdDef::<Family>::cmd_type,
        &owned
    );
    let at = trace.at;
    let edge = CommandEdge::new(move || at);
    let guard_a = observe!(
        calls,
        demlik_tea::command::CommandFamily::dispatch_guard,
        &a,
        &edge
    );
    let guard_b = observe!(
        calls,
        demlik_tea::command::CommandFamily::dispatch_guard,
        &b,
        &edge
    );
    let typed = vec![
        result(observe!(
            calls,
            demlik_tea::command::CommandFamily::settle_in,
            a,
            trace.mode.completion(),
            &edge
        )),
        result(observe!(
            calls,
            demlik_tea::command::CommandFamily::settle_in,
            b,
            trace.mode.completion(),
            &edge
        )),
    ]
    .into_iter()
    .map(|value| {
        if let Value::Array(mut values) = value {
            values.pop().unwrap_or(Value::Null)
        } else {
            value
        }
    })
    .collect::<Vec<_>>();
    let wire = observe!(
        calls,
        demlik_tea::command::CmdContract::new,
        [
            observe!(calls, demlik_tea::command::CmdDef::<Family>::wire, &left),
            observe!(calls, demlik_tea::command::CmdDef::<Family>::wire, &right),
        ]
    );
    let mut clock = || at;
    let wire_settled = commands
        .as_array()
        .unwrap()
        .iter()
        .map(|command| {
            result(observe!(
                calls,
                demlik_tea::command::CmdContract::settle,
                &wire,
                command,
                trace.mode.wire(),
                &mut clock
            ))
        })
        .collect::<Vec<_>>();
    let cross = observe!(
        calls,
        demlik_tea::command::CmdDef::<Family>::ok,
        &left,
        right.from_record(input("b")),
        "replay".into(),
        Some(0.0)
    );
    let cross_checks = json!([
        check(observe!(
            calls,
            demlik_tea::command::DispatchGuard::check,
            &guard_a,
            &cross
        )),
        check(observe!(
            calls,
            demlik_tea::command::DispatchGuard::check,
            &guard_b,
            &cross
        )),
    ]);
    let cross_wire = json!(cross);
    let restored_cross = observe!(
        calls,
        demlik_tea::command::CmdDef::<Family>::restore_settled,
        &left,
        cross_wire.clone()
    )
    .map_err(|error| error.to_string())?;
    let restored_cross_wire = json!(restored_cross);
    let minted = observe!(
        calls,
        demlik_tea::command::CommandFamily::settle_in,
        left.from_record(input("a")),
        Mode::Ok.completion(),
        &edge
    )
    .map_err(|error| error.to_string())?
    .pop()
    .unwrap();
    let restored = observe!(
        calls,
        demlik_tea::command::CmdDef::<Family>::restore_settled,
        &left,
        json!(minted)
    )
    .map_err(|error| error.to_string())?;
    let other_edge = CommandEdge::new(move || at);
    let foreign = observe!(
        calls,
        demlik_tea::command::CommandFamily::settle_in,
        left.from_record(input("a")),
        Mode::Ok.completion(),
        &other_edge
    )
    .map_err(|error| error.to_string())?
    .pop()
    .unwrap();
    let alias = observe!(
        calls,
        demlik_tea::command::CmdDef::<Family>::named,
        left.cmd_type()
    );
    let alias_mint = observe!(
        calls,
        demlik_tea::command::CmdDef::<Family>::settle_in,
        &alias,
        left.from_record(input("a")),
        Mode::Ok.completion(),
        &edge
    )
    .map_err(|error| error.to_string())?
    .unwrap();
    let guards = json!({
        "minted":check(observe!(calls, demlik_tea::command::DispatchGuard::check, &guard_a, &minted)),
        "restored":check(observe!(calls, demlik_tea::command::DispatchGuard::check, &guard_a, &restored)),
        "foreign":check(observe!(calls, demlik_tea::command::DispatchGuard::check, &guard_a, &foreign)),
        "sameName":check(observe!(calls, demlik_tea::command::DispatchGuard::check, &guard_a, &alias_mint)),
    });
    let selected = result(observe!(
        calls,
        demlik_tea::command::CmdDef::<Family>::settle,
        &right,
        left.from_record(input("a")),
        Mode::Ok.completion(),
        at
    ));
    let first = CmdDef::<Prefix<false>>::named(left.cmd_type());
    let second = CmdDef::<Prefix<true>>::named(left.cmd_type());
    let ab = CmdContract::new([
        observe!(
            calls,
            demlik_tea::command::CmdDef::<Prefix<false>>::wire,
            &first
        ),
        observe!(
            calls,
            demlik_tea::command::CmdDef::<Prefix<true>>::wire,
            &second
        ),
    ]);
    let ba = CmdContract::new([
        observe!(
            calls,
            demlik_tea::command::CmdDef::<Prefix<true>>::wire,
            &second
        ),
        observe!(
            calls,
            demlik_tea::command::CmdDef::<Prefix<false>>::wire,
            &first
        ),
    ]);
    let duplicate = json!([
        result(observe!(
            calls,
            demlik_tea::command::CmdContract::settle,
            &ab,
            &commands[0],
            Some(json!({"_tag":"Ok","value":"value"})),
            &mut clock
        )),
        result(observe!(
            calls,
            demlik_tea::command::CmdContract::settle,
            &ba,
            &commands[0],
            Some(json!({"_tag":"Ok","value":"value"})),
            &mut clock
        )),
    ]);
    Ok(
        json!({"declarations":declarations,"commands":commands,"ownedName":owned_name,"typed":typed,"wire":wire_settled,"cross":cross_wire,"restoredCross":restored_cross_wire,"crossChecks":cross_checks,"guards":guards,"selectedByCommand":selected,"duplicate":duplicate}),
    )
}
fn main() {
    for line in io::stdin().lock().lines() {
        let response = match line {
            Ok(line) => match serde_json::from_str::<Case>(&line) {
                Ok(case) => {
                    let mut calls = Vec::new();
                    match execute(case.input, &mut calls) {
                        Ok(output) => {
                            json!({"id":case.id,"ok":true,"output":output,"observedCalls":calls})
                        }
                        Err(error) => json!({"id":case.id,"ok":false,"error":error}),
                    }
                }
                Err(error) => json!({"ok":false,"error":error.to_string()}),
            },
            Err(error) => json!({"ok":false,"error":error.to_string()}),
        };
        println!("{response}");
    }
}
