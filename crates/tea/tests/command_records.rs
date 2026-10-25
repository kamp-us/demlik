use demlik_tea::{
    Tagged,
    command::{
        CmdDef, CommandFamily, CommandRecord, CommandSpec, Issue, Outcome, SchemaError, Settlement,
    },
    data::plain_data,
};
use serde::Serialize;
use serde_json::Value;
use std::{cell::Cell, marker::PhantomData};

struct BorrowedInput<'a> {
    label: &'a str,
    visits: &'a Cell<u32>,
}
impl CommandRecord for BorrowedInput<'_> {}
struct BorrowedSpec<'a>(PhantomData<&'a ()>);
#[derive(Serialize)]
struct Rejected {
    #[serde(rename = "_tag")]
    tag: &'static str,
}
impl Tagged for Rejected {
    fn tag(&self) -> &str {
        self.tag
    }
}
impl<'a> CommandSpec for BorrowedSpec<'a> {
    type Input = BorrowedInput<'a>;
    type RawOutput = &'a str;
    type Output = &'a str;
    type Error = Rejected;
    const NAME: &'static str = "borrowed";
    const ERROR_TAGS: &'static [&'static str] = &["rejected"];
    fn parse_input(_: Value) -> Result<Self::Input, SchemaError> {
        Err(SchemaError::Issues(vec![Issue::new(
            "",
            "borrowed input needs a caller-owned decoder",
        )]))
    }
    fn parse_output(value: Self::RawOutput) -> Result<Self::Output, SchemaError> {
        Ok(value)
    }
}
#[test]
fn typed_record_builds_and_settles_with_borrowed_nonserde_nonclone_input() {
    let label = String::from("borrowed model");
    let visits = Cell::new(0);
    let definition = CmdDef::<BorrowedSpec<'_>>::new();
    let command = definition.from_record(BorrowedInput {
        label: &label,
        visits: &visits,
    });
    visits.set(7);
    assert_eq!(command.input().visits.get(), 7);
    let replies = CommandFamily::settle(command, Some(Outcome::ok("answer")), 17.25).unwrap();
    assert_eq!(replies[0].tag(), "borrowed_ok");
    assert_eq!(replies[0].cmd().input().label, "borrowed model");
    assert_eq!(replies[0].at(), Some(17.25.into()));
    assert!(matches!(replies[0].outcome(), Settlement::Ok("answer")));
}

#[test]
fn owned_named_family_keeps_borrowed_nonserde_nonclone_input() {
    let label = String::from("borrowed named model");
    let visits = Cell::new(0);
    let command = {
        let definition = CmdDef::<BorrowedSpec<'_>>::named(format!("call-{}", 7));
        definition.from_record(BorrowedInput {
            label: &label,
            visits: &visits,
        })
    };
    visits.set(3);
    let replies = CommandFamily::settle(command, Some(Outcome::ok(label.as_str())), 17.25).unwrap();
    assert_eq!(replies[0].tag(), "call-7_ok");
    assert_eq!(replies[0].cmd().input().visits.get(), 3);
    assert!(matches!(replies[0].outcome(),Settlement::Ok(value) if *value==label));
}

#[derive(Serialize)]
struct NumberInput {
    value: f64,
}
struct NumberSpec;
impl CommandSpec for NumberSpec {
    type Input = NumberInput;
    type RawOutput = ();
    type Output = ();
    type Error = Rejected;
    const NAME: &'static str = "number";
    const ERROR_TAGS: &'static [&'static str] = &["rejected"];
    fn parse_input(value: Value) -> Result<Self::Input, SchemaError> {
        Ok(NumberInput {
            value: value["value"]
                .as_f64()
                .ok_or_else(|| SchemaError::Issues(vec![Issue::new("value", "expected number")]))?,
        })
    }
    fn parse_output(_: ()) -> Result<(), SchemaError> {
        Ok(())
    }
}
#[test]
fn command_serialization_keeps_nonfinite_numbers_for_dependency_hashing() {
    let definition = CmdDef::<NumberSpec>::new();
    let command = definition.build(NumberInput { value: f64::NAN }).unwrap();
    assert_eq!(
        demlik_tea::structural_hash(&plain_data(&command).unwrap()),
        r#"{"type":"number","value":NaN}"#
    );
    assert_eq!(
        serde_json::to_string(&command).unwrap(),
        r#"{"value":null,"type":"number"}"#
    );
}
