//! An application-owned cause family delegates to the actual builtin guard.
//! Neither original host failures nor schema failures require serialization.
use demlik_tea::{
    agent::model::{BrainPorts, Llm, MessageLoader, Messages, ModelFactory, brain_handler},
    data::JsText,
    llm_call::{Config, LlmCall, Request, Schema},
    resilience::resilient_call::CallValue,
};
use std::{cell::Cell, ops::AsyncFn, rc::Rc};
struct Opaque<'a>(&'a Cell<u8>);
struct Failure<'a>(&'a Cell<u8>);
use demlik_tea::{
    PlainData,
    agent::{GuardedSchema, StructuredOutputError},
    command::Outcome,
    data::decode_json,
    llm_call::CauseField,
};
use std::cell::RefCell;
enum FamilyCause<'a> {
    Schema(Rc<StructuredOutputError>),
    Model(Rc<Failure<'a>>),
}
struct FamilySchema<'a> {
    inner: &'a GuardedSchema,
    seen: &'a RefCell<Option<Rc<StructuredOutputError>>>,
}
impl<'a> Schema for FamilySchema<'a> {
    type Raw = Rc<PlainData>;
    type Output = Rc<PlainData>;
    type Error = FamilyCause<'a>;
    fn parse(&self, raw: Self::Raw) -> Result<Self::Output, CallValue<Self::Error>> {
        self.inner.parse(raw).map_err(|cause| match cause {
            CallValue::Shared(error) => {
                *self.seen.borrow_mut() = Some(Rc::clone(&error));
                CallValue::value(FamilyCause::Schema(error))
            }
            CallValue::Undefined => CallValue::Undefined,
            CallValue::Missing => CallValue::Missing,
        })
    }
}
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Stage {
    Factory,
    Loader,
    Bind,
    Invoke,
    Success,
    Malformed,
}
struct Host<'a, 'env> {
    client: Client<'a, 'env>,
}
struct Client<'a, 'env> {
    stage: Stage,
    cause: &'env Rc<FamilyCause<'a>>,
    raw: &'env Rc<PlainData>,
    original: &'a GuardedSchema,
    bound: &'env Cell<bool>,
}
impl<'ctx> Llm<(), FamilySchema<'ctx>> for Client<'ctx, '_> {
    fn with_structured_output<'a>(
        &'a self,
        schema: &'a FamilySchema<'ctx>,
    ) -> Result<
        impl for<'m> AsyncFn(Messages<'m, ()>) -> Result<Rc<PlainData>, CallValue<FamilyCause<'ctx>>>
        + 'a,
        CallValue<FamilyCause<'ctx>>,
    > {
        assert!(std::ptr::eq(schema.inner, self.original));
        self.bound.set(true);
        if self.stage == Stage::Bind {
            return Err(CallValue::shared(Rc::clone(self.cause)));
        }
        Ok(async move |messages: Messages<'_, ()>| {
            assert!(messages.as_ref().is_empty());
            std::future::ready(()).await;
            if self.stage == Stage::Invoke {
                Err(CallValue::shared(Rc::clone(self.cause)))
            } else {
                Ok(Rc::clone(self.raw))
            }
        })
    }
}
impl<'ctx> ModelFactory<(), FamilySchema<'ctx>> for Host<'ctx, '_> {
    fn model_of(
        &self,
        _: Option<&JsText>,
    ) -> Result<impl Llm<(), FamilySchema<'ctx>>, CallValue<FamilyCause<'ctx>>> {
        if self.client.stage == Stage::Factory {
            return Err(CallValue::shared(Rc::clone(self.client.cause)));
        }
        Ok(&self.client)
    }
}
struct HostLoader<'a, 'env> {
    stage: Stage,
    cause: &'env Rc<FamilyCause<'a>>,
}
impl<'ctx, P, I> MessageLoader<P, I, (), FamilyCause<'ctx>> for HostLoader<'ctx, '_> {
    async fn load<'a>(
        &'a self,
        _: &'a Rc<Request<P, I>>,
    ) -> Result<Messages<'a, ()>, CallValue<FamilyCause<'ctx>>>
    where
        (): 'a,
    {
        if self.stage == Stage::Loader {
            Err(CallValue::shared(Rc::clone(self.cause)))
        } else {
            Ok(Messages::Shared(Rc::new(Vec::new())))
        }
    }
}
pub fn prove() {
    let context = Cell::new(7);
    let original_failure = Rc::new(Failure(&context));
    let family = Rc::new(FamilyCause::Model(Rc::clone(&original_failure)));
    let builtin = demlik_tea::agent::types::AGENT_TURN_SCHEMA;
    let seen = RefCell::new(None);
    let original = Rc::new(FamilySchema {
        inner: &builtin,
        seen: &seen,
    });
    for stage in [
        Stage::Factory,
        Stage::Loader,
        Stage::Bind,
        Stage::Invoke,
        Stage::Success,
        Stage::Malformed,
    ] {
        let reads = Cell::new(0);
        let schema = Rc::clone(&original);
        let selected = &schema;
        let llm = LlmCall::new(
            Config::new(|_: &&str| {
                reads.set(reads.get() + 1);
                Rc::clone(selected)
            }),
            |_error: &FamilyCause<'_>| Ok("caller owns rendering".into()),
        );
        let raw = Rc::new(
            decode_json(if stage == Stage::Malformed {
                r#"{"content":"x","toolCalls":[],"usage":null}"#
            } else {
                r#"{"content":"x","toolCalls":[],"extra":{"kept":true}}"#
            })
            .unwrap(),
        );
        let bound = Cell::new(false);
        let host = Host {
            client: Client {
                stage,
                cause: &family,
                raw: &raw,
                original: &builtin,
                bound: &bound,
            },
        };
        let loader = HostLoader {
            stage,
            cause: &family,
        };
        let attempted = llm
            .attempt(
                &llm.init(),
                Rc::new(Request::new("turn", None, Opaque(&context))),
                0.0,
            )
            .unwrap();
        let CallValue::Shared(input) = &attempted.commands[0].input().input else {
            panic!("shared request")
        };
        assert!(std::ptr::eq(input.payload.0, &context));
        let out = futures::executor::block_on(
            brain_handler(&llm, BrainPorts::new(&host).with_loader(&loader))
                .handle(&attempted.commands[0]),
        )
        .unwrap();
        match out {
            Outcome::Err { error } => {
                let CauseField::Own(CallValue::Shared(cause)) = error.details.cause() else {
                    panic!("owned typed cause")
                };
                if stage == Stage::Malformed {
                    let FamilyCause::Schema(inner) = cause.as_ref() else {
                        panic!("schema cause")
                    };
                    assert!(Rc::ptr_eq(inner, seen.borrow().as_ref().unwrap()));
                    let StructuredOutputError::Live(rejection) = inner.as_ref() else {
                        panic!("fresh guard rejection must be live");
                    };
                    assert!(Rc::ptr_eq(rejection.value(), &raw));
                } else {
                    assert!(Rc::ptr_eq(cause, &family));
                    let FamilyCause::Model(inner) = cause.as_ref() else {
                        panic!("model cause")
                    };
                    assert!(Rc::ptr_eq(inner, &original_failure));
                    assert!(std::ptr::eq(inner.0, &context));
                }
            }
            Outcome::Ok {
                value: CallValue::Shared(value),
            } => {
                assert_eq!(stage, Stage::Success);
                assert!(Rc::ptr_eq(&value.output, &raw));
            }
            _ => panic!("typed output"),
        }
        assert_eq!(
            reads.get(),
            if matches!(stage, Stage::Factory | Stage::Loader) {
                0
            } else if matches!(stage, Stage::Bind | Stage::Invoke) {
                1
            } else {
                2
            }
        );
        println!(
            "{stage:?}: original opaque model failure or typed builtin schema cause retained; schema reads {}",
            reads.get()
        );
    }
    context.set(8);
    assert_eq!(original_failure.0.get(), 8);
}
