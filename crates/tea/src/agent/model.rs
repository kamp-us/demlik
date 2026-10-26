//! Typed model ports and the brain call handler. Ports return native futures
//! and explicit Result failures. Calling a handler creates a lazy future;
//! polling it performs factory, loader, binding, invocation, then decoding.
//!
//! Native callers select plain_model or model_factory explicitly. JavaScript
//! function tags, arity, thenables, prototypes and thrown getters are not
//! reflected here. A Rust panic remains an unwind, rather than a port failure.

use crate::{
    data::JsText,
    llm_call::{LlmCall, LlmCallError, LlmOutcome, Purpose, Request, RunCmd, Schema},
    resilience::resilient_call::CallValue,
    retry_backoff::{Budget, CountBound},
};
use std::{marker::PhantomData, ops::AsyncFn, rc::Rc};

/// Borrow a host's messages or retain their original shared collection.
/// Shared empty collections are fresh for each default invocation too.
pub enum Messages<'a, M> {
    Borrowed(&'a [M]),
    Shared(Rc<Vec<M>>),
}
impl<M> AsRef<[M]> for Messages<'_, M> {
    fn as_ref(&self) -> &[M] {
        match self {
            Self::Borrowed(messages) => messages,
            Self::Shared(messages) => messages,
        }
    }
}
impl<M> From<Vec<M>> for Messages<'_, M> {
    fn from(messages: Vec<M>) -> Self {
        Self::Shared(Rc::new(messages))
    }
}
impl<M> From<Rc<Vec<M>>> for Messages<'_, M> {
    fn from(messages: Rc<Vec<M>>) -> Self {
        Self::Shared(messages)
    }
}

/// Binding may borrow both the model and the actual configured schema. The
/// runnable returns a raw answer for the existing LlmCall decoder to validate.
pub trait Llm<M, S: Schema + ?Sized> {
    #[expect(
        clippy::type_complexity,
        reason = "The borrowed, higher-ranked async runnable is this port's contract."
    )]
    fn with_structured_output<'a>(
        &'a self,
        schema: &'a S,
    ) -> Result<
        impl for<'m> AsyncFn(Messages<'m, M>) -> Result<S::Raw, CallValue<S::Error>> + 'a,
        CallValue<S::Error>,
    >;
}
impl<M, S: Schema + ?Sized, L: Llm<M, S> + ?Sized> Llm<M, S> for &L {
    fn with_structured_output<'a>(
        &'a self,
        schema: &'a S,
    ) -> Result<
        impl for<'m> AsyncFn(Messages<'m, M>) -> Result<S::Raw, CallValue<S::Error>> + 'a,
        CallValue<S::Error>,
    > {
        L::with_structured_output(*self, schema)
    }
}
impl<M, S: Schema + ?Sized, L: Llm<M, S> + ?Sized> Llm<M, S> for Rc<L> {
    fn with_structured_output<'a>(
        &'a self,
        schema: &'a S,
    ) -> Result<
        impl for<'m> AsyncFn(Messages<'m, M>) -> Result<S::Raw, CallValue<S::Error>> + 'a,
        CallValue<S::Error>,
    > {
        L::with_structured_output(self.as_ref(), schema)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ModelKind {
    Plain,
    Factory,
}
/// Errors share the configured schema's caller-owned cause family. If host and
/// parser causes differ, a caller-owned delegating Schema can keep both typed
/// variants and their original Rc handles; it need not serialize either cause.
pub trait ModelFactory<M, S: Schema + ?Sized> {
    fn model_of(&self, model_id: Option<&JsText>) -> Result<impl Llm<M, S>, CallValue<S::Error>>;
    fn kind(&self) -> ModelKind {
        ModelKind::Factory
    }
}
pub struct Factory<F>(F);
pub fn model_factory<F>(factory: F) -> Factory<F> {
    Factory(factory)
}
impl<M, S, F, L> ModelFactory<M, S> for Factory<F>
where
    S: Schema + ?Sized,
    F: Fn(Option<&JsText>) -> Result<L, CallValue<S::Error>>,
    L: Llm<M, S>,
{
    fn model_of(&self, model_id: Option<&JsText>) -> Result<impl Llm<M, S>, CallValue<S::Error>> {
        (self.0)(model_id)
    }
}

pub struct PlainModel<F>(F);
pub fn plain_model<F>(model: F) -> PlainModel<F> {
    PlainModel(model)
}
struct PlainLlm<'a, F>(&'a F);
impl<M, S, F> Llm<M, S> for PlainLlm<'_, F>
where
    S: Schema + ?Sized,
    S::Output: Into<S::Raw>,
    F: for<'m> AsyncFn(Messages<'m, M>) -> Result<S::Raw, CallValue<S::Error>>,
{
    fn with_structured_output<'a>(
        &'a self,
        schema: &'a S,
    ) -> Result<
        impl for<'m> AsyncFn(Messages<'m, M>) -> Result<S::Raw, CallValue<S::Error>> + 'a,
        CallValue<S::Error>,
    > {
        Ok(async move |messages: Messages<'_, M>| {
            schema.parse((self.0)(messages).await?).map(Into::into)
        })
    }
}
impl<M, S, F> ModelFactory<M, S> for PlainModel<F>
where
    S: Schema + ?Sized,
    S::Output: Into<S::Raw>,
    F: for<'m> AsyncFn(Messages<'m, M>) -> Result<S::Raw, CallValue<S::Error>>,
{
    fn model_of(&self, _: Option<&JsText>) -> Result<impl Llm<M, S>, CallValue<S::Error>> {
        Ok(PlainLlm(&self.0))
    }
    fn kind(&self) -> ModelKind {
        ModelKind::Plain
    }
}

/// The original Rc request owner is passed through so a loader can retain the
/// full call without copying its opaque payload.
/// Futures deliberately remain local: messages, schemas and host context may
/// borrow non-Send data. No Send promise is imposed on every loader.
#[allow(async_fn_in_trait)]
pub trait MessageLoader<P, I, M, E> {
    async fn load<'a>(
        &'a self,
        call: &'a Rc<Request<P, I>>,
    ) -> Result<Messages<'a, M>, CallValue<E>>
    where
        M: 'a;
}
pub struct NoMessages;
static NO_MESSAGES: NoMessages = NoMessages;
impl<P, I, M, E> MessageLoader<P, I, M, E> for NoMessages {
    async fn load<'a>(&'a self, _: &'a Rc<Request<P, I>>) -> Result<Messages<'a, M>, CallValue<E>>
    where
        M: 'a,
    {
        Ok(Messages::Shared(Rc::new(Vec::new())))
    }
}

pub struct BrainPorts<'a, F, L = NoMessages> {
    model: &'a F,
    load_messages: &'a L,
}
impl<'a, F> BrainPorts<'a, F> {
    pub fn new(model: &'a F) -> Self {
        Self {
            model,
            load_messages: &NO_MESSAGES,
        }
    }
}
impl<'a, F, L> BrainPorts<'a, F, L> {
    pub fn with_loader<G>(self, loader: &'a G) -> BrainPorts<'a, F, G> {
        BrainPorts {
            model: self.model,
            load_messages: loader,
        }
    }
}
pub struct BrainHandler<'a, 'config, P, I, M, S: Schema, F, L, B = CountBound> {
    llm: &'a LlmCall<'config, P, I, S, B>,
    ports: BrainPorts<'a, F, L>,
    messages: PhantomData<fn() -> M>,
}
pub fn brain_handler<'a, 'config, P, I, M, S, F, L, B>(
    llm: &'a LlmCall<'config, P, I, S, B>,
    ports: BrainPorts<'a, F, L>,
) -> BrainHandler<'a, 'config, P, I, M, S, F, L, B>
where
    P: Purpose,
    S: Schema,
    B: Budget,
    F: ModelFactory<M, S>,
    L: MessageLoader<P, I, M, S::Error>,
{
    BrainHandler {
        llm,
        ports,
        messages: PhantomData,
    }
}
impl<'a, P, I, M: 'a, S, F, L, B> BrainHandler<'a, '_, P, I, M, S, F, L, B>
where
    P: Purpose,
    S: Schema,
    B: Budget,
    F: ModelFactory<M, S>,
    L: MessageLoader<P, I, M, S::Error>,
{
    pub fn model_kind(&self) -> ModelKind {
        self.ports.model.kind()
    }
    /// Missing/Undefined inputs settle with their property-access error before
    /// model work. Declared port and schema failures retain their own causes.
    pub async fn handle(
        &self,
        cmd: &RunCmd<P, I, S::Output, S::Error>,
    ) -> Result<LlmOutcome<P, S::Output, S::Error>, LlmCallError> {
        let CallValue::Shared(input) = &cmd.input().input else {
            let cause = crate::js_record::property(&crate::PlainData::Undefined, "model")
                .expect_err("reading model from undefined is a property error");
            return Ok(self.llm.rejected_access_error(cause));
        };
        let answer = async {
            let model = self.ports.model.model_of(input.model.as_ref())?;
            let messages = self.ports.load_messages.load(input).await?;
            let schema = self.llm.schema_of(&input.purpose);
            let bound = model.with_structured_output(&schema)?;
            bound(messages).await
        }
        .await;
        match answer {
            Ok(raw) => self.llm.decode(cmd, raw),
            Err(cause) => Ok(self.llm.rejected(cause)),
        }
    }
}

/// Source vocabulary only. Native factories return an Llm by type; JavaScript
/// thenable/function-object misroutes are not detected or simulated here.
pub const PLAIN_MODEL_MISROUTE_REASON: &str = "model: a sync function returned a Promise where an Llm was expected — a promise-returning model that is not declared `async` must be wrapped in plainModel(fn) (see the agent's model ports)";
