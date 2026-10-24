use demlik_tea::Tagged;
use demlik_tea::command::{
    Cmd, CmdContract, CmdDef, CommandContractError, CommandEdge, CommandFamily, CommandSpec,
    Completion, ContractValue, EngineStamp, Outcome, SchemaError, Settled, WireDefinition,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Serialize, Deserialize)]
struct FetchInput {
    url: String,
}

#[derive(Debug, PartialEq, Serialize, Deserialize)]
struct Body {
    body: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "_tag", rename_all = "snake_case")]
enum FetchError {
    Timeout { after_ms: u64 },
}
impl Tagged for FetchError {
    fn tag(&self) -> &str {
        "timeout"
    }
}

struct Fetch;
impl CommandSpec for Fetch {
    type Input = FetchInput;
    type RawOutput = Value;
    type Output = Body;
    type Error = FetchError;
    const NAME: &'static str = "fetch";
    const ERROR_TAGS: &'static [&'static str] = &["timeout"];
    fn parse_input(value: Value) -> Result<FetchInput, SchemaError> {
        serde_json::from_value(value).map_err(SchemaError::from)
    }
    fn parse_output(value: Value) -> Result<Body, SchemaError> {
        serde_json::from_value(value).map_err(SchemaError::from)
    }
}

#[test]
fn a_declared_command_stays_data_and_its_engine_edge_mints_a_parsed_stamped_message() {
    let def = CmdDef::<Fetch>::new();
    let cmd = def
        .build(FetchInput {
            url: "/users".into(),
        })
        .unwrap();
    assert_eq!(
        serde_json::to_value(&cmd).unwrap(),
        json!({ "type": "fetch", "url": "/users" })
    );
    let settled = def
        .settle(
            cmd,
            Some(Outcome::ok(json!({ "body": "kept", "extra": "stripped" }))),
            42.0,
        )
        .unwrap()
        .unwrap();
    assert_eq!(
        serde_json::to_value(settled).unwrap(),
        json!({
            "type": "fetch_ok", "cmd": { "type": "fetch", "url": "/users" },
            "value": { "body": "kept" }, "at": 42.0,
        })
    );
}

#[test]
fn only_the_same_engine_edges_minted_terminal_message_may_be_dispatched() {
    let definition = || WireDefinition::new("fetch", &["timeout"], Ok);
    let contract = CmdContract::new(vec![definition()]);
    let foreign = CmdContract::new(vec![definition()]);
    let cmd = json!({ "type": "fetch", "url": "/" });
    let minted = contract
        .settle(
            &cmd,
            Some(json!({ "_tag": "Ok", "value": { "body": "x" } })),
            &mut || 9.0,
        )
        .unwrap()
        .unwrap();
    assert!(contract.check_dispatch(&cmd, &minted).is_ok());
    assert!(contract.check_dispatch(&cmd, &minted.clone()).is_ok());
    let forged = ContractValue::new(minted.as_value().clone());
    assert_eq!(
        contract.check_dispatch(&cmd, &forged).unwrap_err().name(),
        "OutcomeContractError"
    );
    assert!(foreign.check_dispatch(&cmd, &minted).is_err());
    assert!(
        contract
            .check_dispatch(&cmd, &ContractValue::new(json!({ "type": "progress" })))
            .is_ok()
    );
}

#[test]
fn an_owned_send_guard_survives_command_consumption_and_refuses_replay_builders() {
    let def = CmdDef::<Fetch>::new();
    let edge = CommandEdge::new(|| 71.0);
    let cmd = def.build(FetchInput { url: "/".into() }).unwrap();
    let guard = cmd.dispatch_guard(&edge);
    fn require_send<T: Send>(_: &T) {}
    require_send(&guard);
    let settled = cmd
        .settle_in(Some(Outcome::ok(json!({ "body": "engine" }))), &edge)
        .unwrap()
        .pop()
        .unwrap();
    assert_eq!(settled.at(), Some(71.0));
    assert!(guard.check(&settled).is_ok());
    let restored: Settled<Fetch> =
        serde_json::from_value(serde_json::to_value(&settled).unwrap()).unwrap();
    assert_eq!(restored.at(), Some(71.0));
    assert!(guard.check(&restored).is_err());
    let replay = def.ok(
        def.build(FetchInput { url: "/".into() }).unwrap(),
        Body {
            body: "replay".into(),
        },
        Some(71.0),
    );
    assert!(guard.check(&replay).is_err());
    let other = CommandEdge::new(|| 71.0);
    let cmd = def.build(FetchInput { url: "/".into() }).unwrap();
    let foreign = cmd
        .settle_in(
            Some(Outcome::err(FetchError::Timeout { after_ms: 10 })),
            &other,
        )
        .unwrap()
        .pop()
        .unwrap();
    assert!(guard.check(&foreign).is_err());
}

#[derive(Serialize)]
#[serde(tag = "_tag", rename_all = "snake_case")]
enum SaveError {
    Full,
}
impl Tagged for SaveError {
    fn tag(&self) -> &str {
        "full"
    }
}
struct Save;
impl CommandSpec for Save {
    type Input = Value;
    type RawOutput = u64;
    type Output = bool;
    type Error = SaveError;
    const NAME: &'static str = "save";
    const ERROR_TAGS: &'static [&'static str] = &["full"];
    fn parse_input(value: Value) -> Result<Value, SchemaError> {
        Ok(value)
    }
    fn parse_output(value: u64) -> Result<bool, SchemaError> {
        Ok(value > 0)
    }
}
enum FamilyCmd {
    Fetch(Cmd<Fetch>),
    Save(Cmd<Save>),
    Plain,
}
enum FamilyMsg {
    Fetch(Settled<Fetch>),
    Save(Settled<Save>),
    Progress,
}
enum FamilyCompletion {
    Fetch(Completion<Fetch>),
    Save(Completion<Save>),
    Plain(Vec<FamilyMsg>),
}
impl Tagged for FamilyCmd {
    fn tag(&self) -> &str {
        match self {
            Self::Fetch(cmd) => cmd.tag(),
            Self::Save(cmd) => cmd.tag(),
            Self::Plain => "plain",
        }
    }
}
impl Tagged for FamilyMsg {
    fn tag(&self) -> &str {
        match self {
            Self::Fetch(msg) => msg.tag(),
            Self::Save(msg) => msg.tag(),
            Self::Progress => "progress",
        }
    }
}
impl Tagged for FamilyCompletion {
    fn tag(&self) -> &str {
        match self {
            Self::Fetch(_) => "fetch",
            Self::Save(_) => "save",
            Self::Plain(_) => "plain",
        }
    }
}
impl CommandFamily for FamilyCmd {
    type Msg = FamilyMsg;
    type Completion = FamilyCompletion;
    fn is_defined(&self) -> bool {
        !matches!(self, Self::Plain)
    }
    fn engine_stamp(message: &FamilyMsg) -> Option<&EngineStamp> {
        match message {
            FamilyMsg::Fetch(msg) => msg.engine_stamp(),
            FamilyMsg::Save(msg) => msg.engine_stamp(),
            FamilyMsg::Progress => None,
        }
    }
    fn settle(
        self,
        completion: FamilyCompletion,
        at: f64,
    ) -> Result<Vec<FamilyMsg>, CommandContractError> {
        match (self, completion) {
            (Self::Fetch(cmd), FamilyCompletion::Fetch(completion)) => Ok(cmd
                .settle(completion, at)?
                .into_iter()
                .map(FamilyMsg::Fetch)
                .collect()),
            (Self::Save(cmd), FamilyCompletion::Save(completion)) => Ok(cmd
                .settle(completion, at)?
                .into_iter()
                .map(FamilyMsg::Save)
                .collect()),
            (Self::Plain, FamilyCompletion::Plain(messages)) => Ok(messages),
            (cmd, completion) => Err(CommandContractError::mismatched(
                cmd.tag(),
                completion.tag(),
            )),
        }
    }
    fn settle_in(
        self,
        completion: FamilyCompletion,
        edge: &CommandEdge,
    ) -> Result<Vec<FamilyMsg>, CommandContractError> {
        match (self, completion) {
            (Self::Fetch(cmd), FamilyCompletion::Fetch(completion)) => Ok(cmd
                .settle_in(completion, edge)?
                .into_iter()
                .map(FamilyMsg::Fetch)
                .collect()),
            (Self::Save(cmd), FamilyCompletion::Save(completion)) => Ok(cmd
                .settle_in(completion, edge)?
                .into_iter()
                .map(FamilyMsg::Save)
                .collect()),
            (Self::Plain, FamilyCompletion::Plain(messages)) => Ok(messages),
            (cmd, completion) => Err(CommandContractError::mismatched(
                cmd.tag(),
                completion.tag(),
            )),
        }
    }
}

#[test]
fn a_heterogeneous_family_keeps_both_outcome_types_and_refuses_wrong_family_completion() {
    let edge = CommandEdge::new(|| 4.0);
    let fetch = FamilyCmd::Fetch(
        CmdDef::<Fetch>::new()
            .build(FetchInput { url: "/".into() })
            .unwrap(),
    );
    let guard = fetch.dispatch_guard(&edge);
    let messages = fetch
        .settle_in(
            FamilyCompletion::Fetch(Some(Outcome::ok(json!({ "body": "hello" })))),
            &edge,
        )
        .unwrap();
    assert!(guard.check(&messages[0]).is_ok());
    assert_eq!(messages[0].tag(), "fetch_ok");
    assert!(guard.check(&FamilyMsg::Progress).is_ok());

    let save = FamilyCmd::Save(
        CmdDef::<Save>::new()
            .build(json!({ "text": "hi" }))
            .unwrap(),
    );
    let messages = save
        .settle_in(FamilyCompletion::Save(Some(Outcome::ok(2_u64))), &edge)
        .unwrap();
    let FamilyMsg::Save(saved) = &messages[0] else {
        panic!("save outcome must remain save typed")
    };
    assert!(matches!(
        saved.outcome(),
        demlik_tea::command::Settlement::Ok(true)
    ));

    let fetch = FamilyCmd::Fetch(
        CmdDef::<Fetch>::new()
            .build(FetchInput { url: "/".into() })
            .unwrap(),
    );
    let error = fetch
        .settle_in(
            FamilyCompletion::Save(Some(Outcome::err(SaveError::Full))),
            &edge,
        )
        .err()
        .unwrap();
    assert_eq!(error.name(), "CompletionMismatchError");
    assert_eq!(
        serde_json::to_value(error).unwrap()["completionType"],
        "save"
    );
    let plain = FamilyCmd::Plain;
    assert!(!plain.is_defined());
    assert_eq!(
        plain
            .settle_in(FamilyCompletion::Plain(vec![FamilyMsg::Progress]), &edge)
            .unwrap()[0]
            .tag(),
        "progress"
    );
}

#[test]
fn typed_failure_serialization_cannot_sneak_an_undeclared_wire_tag_into_model() {
    #[derive(Serialize)]
    struct MissingTag {
        reason: &'static str,
    }
    impl Tagged for MissingTag {
        fn tag(&self) -> &str {
            "timeout"
        }
    }
    struct IncorrectFailure;
    impl CommandSpec for IncorrectFailure {
        type Input = Value;
        type RawOutput = Value;
        type Output = Value;
        type Error = MissingTag;
        const NAME: &'static str = "fetch";
        const ERROR_TAGS: &'static [&'static str] = &["timeout"];
        fn parse_input(value: Value) -> Result<Value, SchemaError> {
            Ok(value)
        }
        fn parse_output(value: Value) -> Result<Value, SchemaError> {
            Ok(value)
        }
    }
    let def = CmdDef::<IncorrectFailure>::new();
    let cmd = def.build(json!({})).unwrap();
    let error = def
        .settle(
            cmd,
            Some(Outcome::err(MissingTag { reason: "offline" })),
            1.0,
        )
        .err()
        .expect("a missing serialized tag must be refused");
    assert_eq!(
        serde_json::to_value(error).unwrap()["failure"],
        json!({ "reason": "offline" })
    );
}

#[test]
fn restoring_a_raw_failure_channel_keeps_kernel_malformed_results_distinct() {
    #[derive(Serialize, Deserialize)]
    #[serde(transparent)]
    struct RawFailure(Value);
    impl Tagged for RawFailure {
        fn tag(&self) -> &str {
            self.0["_tag"].as_str().unwrap_or("")
        }
    }
    struct RawCommand;
    impl CommandSpec for RawCommand {
        type Input = Value;
        type RawOutput = Value;
        type Output = Value;
        type Error = RawFailure;
        const NAME: &'static str = "fetch";
        const ERROR_TAGS: &'static [&'static str] = &["timeout"];
        fn parse_input(value: Value) -> Result<Value, SchemaError> {
            Ok(value)
        }
        fn parse_output(value: Value) -> Result<Value, SchemaError> {
            Ok(value)
        }
    }
    let wire = json!({ "type": "fetch_err", "cmd": { "type": "fetch" }, "error": { "_tag": "malformed_result", "issues": [{ "path": "body", "message": "Expected string" }] }, "at": 3.0 });
    let restored: Settled<RawCommand> = serde_json::from_value(wire.clone()).unwrap();
    assert!(matches!(
        restored.outcome(),
        demlik_tea::command::Settlement::Err(demlik_tea::command::Failure::Malformed(_))
    ));
    assert_eq!(serde_json::to_value(restored).unwrap(), wire);
}
