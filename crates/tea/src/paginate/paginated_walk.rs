//! Page sequencing belongs to the paginator; fetch admission belongs to
//! resilient-call. The caller owns commands, callbacks and the host machine.

use super::paginator::{self, PaginatorCursor, PaginatorPhase, PaginatorPolicy, PaginatorState};
use crate::{
    Step,
    command::CmdDef,
    data::JsText,
    resilience::{
        deadline::{Deadline, DeadlineExceeded},
        resilient_call::{
            self as call, CallFailure, CallNumber, CallPhase, CallValue, ResilientCall,
            ResilientError, RunCommand, RunSpec, SettleInput,
        },
    },
    retry_backoff::{CountBound, RetryPolicy},
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use std::rc::Rc;

pub const PAGE_KEY: &str = "page";
pub type NextCursor<'a, C, P, F> = Rc<dyn Fn(&CallValue<P>) -> Result<Option<Rc<C>>, F> + 'a>;
pub type OnPage<'a, P, O, F> = Rc<dyn Fn(&CallValue<P>) -> Result<Vec<O>, F> + 'a>;
pub type PageSize<'a, P, F> = Rc<dyn Fn(&CallValue<P>) -> Result<f64, F> + 'a>;

pub struct Config<'a, C, P, O, F> {
    pub first_page: CallValue<C>,
    pub next_cursor: NextCursor<'a, C, P, F>,
    pub on_page: OnPage<'a, P, O, F>,
    pub page_size: Option<PageSize<'a, P, F>>,
    pub high_water_mark: f64,
    pub retry: Option<RetryPolicy<CountBound>>,
    pub circuit: Option<call::CircuitConfig>,
    pub rate_limit: Option<call::RateLimitConfig>,
    pub deadline: Option<call::DeadlineConfig>,
}
impl<'a, C, P, O, F> Config<'a, C, P, O, F> {
    pub fn new(
        first_page: CallValue<C>,
        next_cursor: NextCursor<'a, C, P, F>,
        on_page: OnPage<'a, P, O, F>,
    ) -> Self {
        Self {
            first_page,
            next_cursor,
            on_page,
            page_size: None,
            high_water_mark: 0.0,
            retry: None,
            circuit: None,
            rate_limit: None,
            deadline: None,
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(bound(deserialize = "C:DeserializeOwned,P:DeserializeOwned,E:DeserializeOwned"))]
pub struct Snapshot<C, P, E> {
    pub walk: PaginatorState<CallValue<C>>,
    pub resilience: call::State<C, P, E>,
}
#[derive(Serialize, Deserialize)]
#[serde(
    transparent,
    bound(deserialize = "C:DeserializeOwned,P:DeserializeOwned,E:DeserializeOwned")
)]
pub struct State<C, P, E>(Rc<Snapshot<C, P, E>>);
impl<C, P, E> Clone for State<C, P, E> {
    fn clone(&self) -> Self {
        Self(Rc::clone(&self.0))
    }
}
impl<C, P, E> State<C, P, E> {
    pub fn from_parts(
        walk: PaginatorState<CallValue<C>>,
        resilience: call::State<C, P, E>,
    ) -> Self {
        Self(Rc::new(Snapshot { walk, resilience }))
    }
    pub fn snapshot(&self) -> &Snapshot<C, P, E> {
        &self.0
    }
    pub fn walk(&self) -> &PaginatorState<CallValue<C>> {
        &self.0.walk
    }
    pub fn resilience(&self) -> &call::State<C, P, E> {
        &self.0.resilience
    }
    pub fn ptr_eq(&self, other: &Self) -> bool {
        Rc::ptr_eq(&self.0, &other.0)
    }
}
pub struct PageOk<P> {
    pub key: JsText,
    pub value: CallValue<P>,
    pub at: CallNumber,
}
impl<P> PageOk<P> {
    pub fn new(key: impl Into<JsText>, value: CallValue<P>, at: impl Into<CallNumber>) -> Self {
        Self {
            key: key.into(),
            value,
            at: at.into(),
        }
    }
}
pub struct PageErr<E> {
    pub key: JsText,
    pub error: Rc<CallFailure<E>>,
    pub at: CallNumber,
}
impl<E> PageErr<E> {
    pub fn new(key: impl Into<JsText>, error: CallFailure<E>, at: impl Into<CallNumber>) -> Self {
        Self {
            key: key.into(),
            error: Rc::new(error),
            at: at.into(),
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CallbackPhase {
    PageSize,
    NextCursor,
    OnPage,
}
#[derive(Debug)]
pub enum WalkError<F> {
    Resilience(ResilientError),
    Callback { phase: CallbackPhase, cause: F },
}
impl<F> From<ResilientError> for WalkError<F> {
    fn from(error: ResilientError) -> Self {
        Self::Resilience(error)
    }
}
pub type WalkStep<C, P, E, O> = Step<State<C, P, E>, O>;
pub type WalkResult<C, P, E, O, F> = Result<WalkStep<C, P, E, O>, WalkError<F>>;

/// The caller maps its exhaustive command enum from the typed page fetch.
/// Page completions retain their declared result type.
///
/// ```compile_fail,E0308
/// use std::rc::Rc;
/// use demlik_tea::command::{CommandFamily, Outcome};
/// use demlik_tea::paginate::paginated_walk::{Config, PaginatedWalk};
/// use demlik_tea::resilience::resilient_call::{CallValue, RunCommand};
/// let config = Config::new(CallValue::value(3_u32), Rc::new(|_: &CallValue<String>| Ok(None)), Rc::new(|_| Ok(vec![])));
/// let walk: PaginatedWalk<'_, u32, String, (), (), RunCommand<u32, String, ()>> = PaginatedWalk::new(config);
/// let mut started = walk.start(&walk.init(), 0.0).unwrap();
/// let command = started.commands.pop().unwrap();
/// command.settle(Some(Outcome::ok(CallValue::value(42_u64))), 1.0);
/// ```
pub struct PaginatedWalk<'a, C, P, E, F, O> {
    rc: ResilientCall<'a, C, P, E>,
    policy: PaginatorPolicy<CallValue<C>>,
    next_cursor: NextCursor<'a, C, P, F>,
    on_page: OnPage<'a, P, O, F>,
    page_size: Option<PageSize<'a, P, F>>,
}

pub fn lift_walk<S, C, P, E, O>(
    state: S,
    result: WalkStep<C, P, E, O>,
    replace: impl FnOnce(S, State<C, P, E>) -> S,
) -> Step<S, O> {
    crate::compose::lift_slice(state, result, replace)
}
impl<'a, C, P, E, F, O: From<RunCommand<C, P, E>>> PaginatedWalk<'a, C, P, E, F, O> {
    pub fn new(config: Config<'a, C, P, O, F>) -> Self {
        Self {
            rc: ResilientCall::new(call::Config {
                retry: config.retry,
                circuit: config.circuit,
                rate_limit: config.rate_limit,
                deadline: config.deadline,
                ..call::Config::default()
            }),
            policy: PaginatorPolicy::new(config.first_page, config.high_water_mark),
            next_cursor: config.next_cursor,
            on_page: config.on_page,
            page_size: config.page_size,
        }
    }
    pub fn with_rng(mut self, rng: impl Fn() -> f64 + 'a) -> Self {
        self.rc = self.rc.with_rng(rng);
        self
    }
    pub fn fetch(&self) -> &CmdDef<RunSpec<C, P, E>> {
        &self.rc.run
    }
    pub fn init(&self) -> State<C, P, E> {
        State::from_parts(paginator::init_paginator(), self.rc.init())
    }
    fn with_slice(
        &self,
        state: &State<C, P, E>,
        resilience: call::State<C, P, E>,
    ) -> State<C, P, E> {
        State::from_parts(state.walk().clone(), resilience)
    }
    fn cursor_of(walk: &PaginatorState<CallValue<C>>) -> CallValue<C> {
        match &walk.snapshot().phase {
            PaginatorPhase::Fetching {
                cursor: PaginatorCursor::Shared(value),
            }
            | PaginatorPhase::Paused {
                cursor: PaginatorCursor::Shared(value),
            } => value.as_ref().clone(),
            _ => CallValue::Undefined,
        }
    }
    fn attempt_cursor(
        &self,
        state: &State<C, P, E>,
        cursor: CallValue<C>,
        at: CallNumber,
    ) -> WalkResult<C, P, E, O, F> {
        let attempted = self.rc.attempt(state.resilience(), PAGE_KEY, cursor, at)?;
        Ok(Step::new(
            self.with_slice(state, attempted.state),
            attempted.commands.into_iter().map(O::from).collect(),
        ))
    }
    fn arm_and_fetch(
        &self,
        state: &State<C, P, E>,
        walk: PaginatorState<CallValue<C>>,
        at: CallNumber,
    ) -> WalkResult<C, P, E, O, F> {
        if walk.ptr_eq(state.walk())
            || !matches!(walk.snapshot().phase, PaginatorPhase::Fetching { .. })
        {
            return Ok(Step::new(state.clone(), vec![]));
        }
        let cursor = Self::cursor_of(&walk);
        self.attempt_cursor(
            &State::from_parts(walk, state.resilience().clone()),
            cursor,
            at,
        )
    }
    pub fn start(
        &self,
        state: &State<C, P, E>,
        at: impl Into<CallNumber>,
    ) -> WalkResult<C, P, E, O, F> {
        self.arm_and_fetch(
            state,
            paginator::start(state.walk(), &self.policy),
            at.into(),
        )
    }
    fn after_ok(
        &self,
        state: &State<C, P, E>,
        resilience: call::State<C, P, E>,
        page: CallValue<P>,
        at: CallNumber,
    ) -> WalkResult<C, P, E, O, F> {
        let count = self
            .page_size
            .as_ref()
            .map_or(Ok(1.0), |size| size(&page))
            .map_err(|cause| WalkError::Callback {
                phase: CallbackPhase::PageSize,
                cause,
            })?;
        let next = (self.next_cursor)(&page).map_err(|cause| WalkError::Callback {
            phase: CallbackPhase::NextCursor,
            cause,
        })?;
        let walk = paginator::record_page(
            state.walk(),
            count,
            next.map(|cursor| Rc::new(CallValue::shared(cursor))),
            &self.policy,
        );
        let advanced = State::from_parts(walk, resilience);
        let mut page_commands = (self.on_page)(&page).map_err(|cause| WalkError::Callback {
            phase: CallbackPhase::OnPage,
            cause,
        })?;
        if matches!(
            advanced.walk().snapshot().phase,
            PaginatorPhase::Fetching { .. }
        ) {
            let fetched = self.attempt_cursor(&advanced, Self::cursor_of(advanced.walk()), at)?;
            page_commands.extend(fetched.commands);
            return Ok(Step::new(fetched.state, page_commands));
        }
        Ok(Step::new(advanced, page_commands))
    }
    pub fn page_ok(&self, state: &State<C, P, E>, msg: PageOk<P>) -> WalkResult<C, P, E, O, F> {
        let settled = self.rc.settle(
            state.resilience(),
            SettleInput::Ok {
                key: msg.key,
                value: msg.value.clone(),
                at: msg.at,
            },
        )?;
        self.after_ok(state, settled.call, msg.value, msg.at)
    }
    pub fn page_err(&self, state: &State<C, P, E>, msg: PageErr<E>) -> WalkResult<C, P, E, O, F> {
        if !matches!(
            state.walk().snapshot().phase,
            PaginatorPhase::Fetching { .. }
        ) {
            return Ok(Step::new(state.clone(), vec![]));
        }
        let settled = self.rc.settle(
            state.resilience(),
            SettleInput::Err {
                key: msg.key,
                error: msg.error,
                at: msg.at,
            },
        )?;
        Ok(Step::new(
            self.with_slice(state, settled.call),
            settled.commands.into_iter().map(O::from).collect(),
        ))
    }
    pub fn on_timer(
        &self,
        state: &State<C, P, E>,
        msg: &DeadlineExceeded,
    ) -> WalkResult<C, P, E, O, F> {
        if !matches!(
            state.walk().snapshot().phase,
            PaginatorPhase::Fetching { .. }
        ) {
            return Ok(Step::new(state.clone(), vec![]));
        }
        let timed = self.rc.on_timer(state.resilience(), msg)?;
        Ok(Step::new(
            self.with_slice(state, timed.state),
            timed.commands.into_iter().map(O::from).collect(),
        ))
    }
    pub fn drain(&self, state: &State<C, P, E>, count: f64) -> WalkStep<C, P, E, O> {
        let walk = paginator::drain(state.walk(), count);
        Step::new(
            if walk.ptr_eq(state.walk()) {
                state.clone()
            } else {
                State::from_parts(walk, state.resilience().clone())
            },
            vec![],
        )
    }
    pub fn resume(
        &self,
        state: &State<C, P, E>,
        at: impl Into<CallNumber>,
    ) -> WalkResult<C, P, E, O, F> {
        self.arm_and_fetch(
            state,
            paginator::resume(state.walk(), &self.policy),
            at.into(),
        )
    }
    pub fn is_complete(&self, state: &State<C, P, E>) -> bool {
        paginator::is_done(state.walk())
    }
    pub fn failure<'s>(&self, state: &'s State<C, P, E>) -> Option<&'s Rc<CallFailure<E>>> {
        match state.resilience().call(PAGE_KEY) {
            Some(CallPhase::Failed { error }) => Some(error),
            _ => None,
        }
    }
    pub fn is_stuck(&self, state: &State<C, P, E>) -> bool {
        matches!(
            state.resilience().call(PAGE_KEY),
            Some(CallPhase::Failed { .. })
        ) && !self.is_complete(state)
    }
    pub fn deadlines(&self, state: &State<C, P, E>) -> Vec<Deadline> {
        self.rc.deadlines(state.resilience())
    }
    pub fn timer(&self, state: &State<C, P, E>) -> Option<crate::TimerDeps<DeadlineExceeded>> {
        self.rc.timer(state.resilience())
    }
}
