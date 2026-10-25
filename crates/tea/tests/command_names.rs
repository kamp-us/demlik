use demlik_tea::{
    Tagged,
    command::{
        Cmd, CmdDef, CommandContractError, CommandEdge, CommandFamily, CommandRecord, CommandSpec,
        Issue, Outcome, SchemaError, Settlement,
    },
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

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
fn input(key: &str) -> Input {
    Input { key: key.into() }
}

#[test]
fn paired_named_commands_own_their_name_through_settlement_and_wire_formats() {
    let edge = CommandEdge::new(|| 17.25);
    for name in ["alpha", "beta", "çağrı"] {
        let command = {
            let definition = CmdDef::<Family>::named(name.to_owned());
            assert_eq!(definition.cmd_type(), name);
            definition.from_record(input("key"))
        };
        let guard = command.dispatch_guard(&edge);
        assert_eq!(command.tag(), name);
        assert_eq!(command.definition().ok_type(), format!("{name}_ok"));
        let wire = serde_json::to_value(&command).unwrap();
        assert_eq!(wire, json!({"type":name,"key":"key"}));
        assert!(serde_json::from_value::<Cmd<Family>>(wire.clone()).is_err());
        let restored = CmdDef::<Family>::named(name).restore_command(wire).unwrap();
        assert_eq!(restored.tag(), name);
        let messages =
            CommandFamily::settle_in(command, Some(Outcome::ok(" value ".into())), &edge).unwrap();
        assert_eq!(messages[0].tag(), format!("{name}_ok"));
        assert_eq!(messages[0].cmd().tag(), name);
        assert!(matches!(messages[0].outcome(),Settlement::Ok(value) if value=="VALUE"));
        guard.check(&messages[0]).unwrap();
        let message_wire = serde_json::to_value(&messages[0]).unwrap();
        let replay = CmdDef::<Family>::named(name)
            .restore_settled(message_wire)
            .unwrap();
        assert_eq!(replay.tag(), format!("{name}_ok"));
        assert!(guard.check(&replay).is_err());
    }
}

#[test]
fn replay_builders_and_same_name_definitions_do_not_gain_identity_bans() {
    let alpha = CmdDef::<Family>::named("alpha");
    let beta = CmdDef::<Family>::named("beta");
    let same_alpha = CmdDef::<Family>::named("alpha");
    let edge = CommandEdge::new(|| 1.25);
    let other_edge = CommandEdge::new(|| 1.25);
    let guard_a = alpha.from_record(input("a")).dispatch_guard(&edge);
    let guard_b = beta.from_record(input("b")).dispatch_guard(&edge);
    let cross = alpha.ok(beta.from_record(input("b")), "replay".into(), Some(0.0));
    assert_eq!(cross.tag(), "alpha_ok");
    assert_eq!(cross.cmd().tag(), "beta");
    assert!(guard_a.check(&cross).is_err());
    guard_b.check(&cross).unwrap();
    let message = same_alpha
        .settle_in(
            alpha.from_record(input("a")),
            Some(Outcome::ok("x".into())),
            &edge,
        )
        .unwrap()
        .unwrap();
    guard_a.check(&message).unwrap();
    let other = same_alpha
        .settle_in(
            alpha.from_record(input("a")),
            Some(Outcome::ok("x".into())),
            &other_edge,
        )
        .unwrap()
        .unwrap();
    assert!(guard_a.check(&other).is_err());
    let selected_by_command = alpha
        .settle(
            beta.from_record(input("b")),
            Some(Outcome::ok("x".into())),
            0.0,
        )
        .unwrap()
        .unwrap();
    assert_eq!(selected_by_command.tag(), "beta_ok");
    assert_eq!(selected_by_command.cmd().tag(), "beta");
}

#[test]
fn named_output_and_declared_error_guards_keep_the_actual_command_family() {
    let definition = CmdDef::<Family>::named("alpha");
    let malformed = definition
        .settle(
            definition.from_record(input("x")),
            Some(Outcome::ok("bad".into())),
            3.25,
        )
        .unwrap()
        .unwrap();
    assert_eq!(malformed.tag(), "alpha_err");
    assert!(matches!(
        malformed.outcome(),
        Settlement::Err(demlik_tea::command::Failure::Malformed(_))
    ));
    let error = definition.settle(
        definition.from_record(input("x")),
        Some(Outcome::err(Rejected {
            tag: "other".into(),
            detail: vec![0, 255],
        })),
        3.25,
    );
    match error {
        Err(CommandContractError::UndeclaredFailure {
            cmd_type, failure, ..
        }) => {
            assert_eq!(cmd_type, "alpha");
            assert_eq!(
                serde_json::to_value(failure).unwrap()["detail"],
                json!([0, 255])
            );
        }
        _ => panic!("undeclared failure"),
    }
    assert!(
        CmdDef::<Family>::named("beta")
            .restore_command(json!({"type":"alpha","key":"x"}))
            .is_err()
    );
}

#[test]
fn named_wire_adapter_selects_the_family_and_keeps_last_definition_precedence() {
    use demlik_tea::command::{CmdContract, ContractValue, WireDefinition};
    let definition = CmdDef::<Family>::named("alpha");
    let contract = CmdContract::new([definition.wire()]);
    let command = json!({"type":"alpha","key":"x"});
    let mut clock = || 17.25;
    let settled = contract
        .settle(
            &command,
            Some(json!({"_tag":"Ok","value":" value "})),
            &mut clock,
        )
        .unwrap()
        .unwrap();
    assert_eq!(
        settled.as_value(),
        &json!({"type":"alpha_ok","cmd":command,"value":"VALUE","at":17.25})
    );
    contract.check_dispatch(&command, &settled).unwrap();
    assert!(
        contract
            .check_dispatch(&command, &ContractValue::new(settled.as_value().clone()))
            .is_err()
    );
    let later = WireDefinition::new("alpha", &["declared"], |value| {
        Ok(json!(format!("later:{}", value.as_str().unwrap())))
    });
    let duplicate = CmdContract::new([definition.wire(), later]);
    let settled = duplicate
        .settle(
            &command,
            Some(json!({"_tag":"Ok","value":"value"})),
            &mut clock,
        )
        .unwrap()
        .unwrap();
    assert_eq!(settled.as_value()["value"], "later:value");
}

struct Unchecked;
impl CommandSpec for Unchecked {
    type Input = Input;
    type RawOutput = demlik_tea::PlainData;
    type Output = demlik_tea::PlainData;
    type Error = Rejected;
    const NAME: &'static str = "unchecked";
    const ERROR_TAGS: &'static [&'static str] = &["declared"];
    fn parse_input(value: Value) -> Result<Input, SchemaError> {
        serde_json::from_value(value).map_err(Into::into)
    }
    fn parse_output(value: Self::RawOutput) -> Result<Self::Output, SchemaError> {
        Ok(value)
    }
    fn missing_output() -> Option<Self::Output> {
        Some(demlik_tea::PlainData::Undefined)
    }
}
#[test]
fn settled_wire_omits_undefined_and_keeps_nonfinite_values_for_hashes() {
    use demlik_tea::{PlainData, data::plain_data};
    let definition = CmdDef::<Unchecked>::named("alpha");
    let edge = CommandEdge::new(|| 17.25);
    let command = definition.from_record(input("x"));
    let guard = command.dispatch_guard(&edge);
    let message = CommandFamily::settle_in(command, Some(Outcome::ok(PlainData::Undefined)), &edge)
        .unwrap()
        .pop()
        .unwrap();
    assert_eq!(
        serde_json::to_value(&message).unwrap(),
        json!({"type":"alpha_ok","cmd":{"key":"x","type":"alpha"},"at":17.25})
    );
    let restored = definition
        .restore_settled(serde_json::to_value(&message).unwrap())
        .unwrap();
    assert!(matches!(
        restored.outcome(),
        Settlement::Ok(PlainData::Undefined)
    ));
    assert!(guard.check(&restored).is_err());
    guard.check(&message).unwrap();
    let message = CommandFamily::settle_in(
        definition.from_record(input("x")),
        Some(Outcome::ok(PlainData::Number(f64::INFINITY))),
        &edge,
    )
    .unwrap()
    .pop()
    .unwrap();
    assert_eq!(
        serde_json::to_value(&message).unwrap()["value"],
        Value::Null
    );
    assert!(
        demlik_tea::structural_hash(&plain_data(&message).unwrap()).contains("\"value\":Infinity")
    );
}

#[derive(Serialize)]
#[serde(transparent)]
struct RawFailure(demlik_tea::PlainData);
impl Tagged for RawFailure {
    fn tag(&self) -> &str {
        "declared"
    }
}
struct RawFailureSpec;
impl CommandSpec for RawFailureSpec {
    type Input = Input;
    type RawOutput = ();
    type Output = ();
    type Error = RawFailure;
    const NAME: &'static str = "raw";
    const ERROR_TAGS: &'static [&'static str] = &["declared"];
    fn parse_input(value: Value) -> Result<Input, SchemaError> {
        serde_json::from_value(value).map_err(Into::into)
    }
    fn parse_output(_: ()) -> Result<(), SchemaError> {
        Ok(())
    }
}
#[test]
fn declared_and_undeclared_failure_data_keep_lone_units_and_nonfinite_values() {
    use demlik_tea::{
        PlainData,
        data::{decode_json, plain_data},
    };
    let definition = CmdDef::<RawFailureSpec>::named("alpha");
    for tag in ["declared", "other"] {
        let raw = decode_json(&format!(
            r#"{{"_tag":"{tag}","detail":"\ud800","overflow":1e400}}"#
        ))
        .unwrap();
        let result = definition.settle(
            definition.from_record(input("x")),
            Some(Outcome::err(RawFailure(raw))),
            17.25,
        );
        let data = if tag == "declared" {
            plain_data(&result.unwrap().unwrap()).unwrap()
        } else {
            plain_data(&result.err().unwrap()).unwrap()
        };
        let PlainData::Object(fields) = data else {
            panic!("record")
        };
        let value = fields
            .get(if tag == "declared" {
                "error"
            } else {
                "failure"
            })
            .unwrap();
        let PlainData::Object(fields) = value else {
            panic!("failure record")
        };
        assert!(
            matches!(fields.get("detail"),Some(PlainData::String(text)) if text.as_units()==[0xd800])
        );
        assert!(
            matches!(fields.get("overflow"),Some(PlainData::Number(value)) if *value==f64::INFINITY)
        );
    }
}
