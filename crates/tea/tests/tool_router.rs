use demlik_tea::{
    PlainData, Tagged,
    agent::{
        tool::{self, ErrorFamily, ToolSpec},
        types::ToolCall,
    },
    command::{CommandContractError, CommandEdge, CommandFamily, Outcome, SchemaError},
    llm_call::Schema,
    resilience::resilient_call::CallValue,
};
use std::{cell::Cell, rc::Rc};
struct In;
impl Schema for In {
    type Raw = Rc<()>;
    type Output = Rc<()>;
    type Error = SchemaError;
    fn parse(&self, raw: Rc<()>) -> Result<Rc<()>, CallValue<SchemaError>> {
        Ok(raw)
    }
}
struct Out(bool);
impl Schema for Out {
    type Raw = Rc<()>;
    type Output = Rc<()>;
    type Error = SchemaError;
    fn parse(&self, _: Rc<()>) -> Result<Rc<()>, CallValue<SchemaError>> {
        Err(if self.0 {
            CallValue::Undefined
        } else {
            CallValue::Missing
        })
    }
}
struct Never;
impl Tagged for Never {
    fn tag(&self) -> &str {
        "never"
    }
}
#[test]
fn unsupported_absent_schema_carriers_refuse_without_malformed_settlement() {
    for undefined in [false, true] {
        let calls = Rc::new(Cell::new(0));
        let parser_calls = Rc::clone(&calls);
        let def = tool::tool(
            "absent",
            ToolSpec::new(
                Rc::new(In),
                Rc::new(Out(undefined)),
                ErrorFamily::new(["never"], |_: &Never| Ok(PlainData::Null)),
            ),
            move |_: &Rc<()>, _: tool::ToolContext<'_, ()>| {
                parser_calls.set(parser_calls.get() + 1);
                Box::pin(async { Ok(Outcome::ok(Rc::new(()))) })
            },
        )
        .unwrap();
        let command = tool::ToolDefinition::command(
            &def,
            &ToolCall {
                call_id: "c".into(),
                name: "absent".into(),
                args: Rc::new(()),
            },
        )
        .unwrap();
        assert_eq!(calls.get(), 0);
        let error =
            match command.settle_in(Some(Outcome::ok(Rc::new(()))), &CommandEdge::new(|| 1.0)) {
                Err(e) => e,
                Ok(_) => panic!("missing carrier accepted"),
            };
        let CommandContractError::Outcome { detail, .. } = error else {
            panic!("refusal reclassified")
        };
        assert!(detail.contains(if undefined { "undefined" } else { "missing" }));
    }
}
