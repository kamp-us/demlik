//! Scan through paginated-walk, plan through caller callbacks, and remember
//! acknowledged changes in the existing TTL cache.

mod wire;

use crate::{
    Step,
    command::CmdDef,
    data::{DependencyError, JsText, plain_data, stringify_json},
    js_record::{JsAccessError, JsRead},
    paginate::paginated_walk::{self as walk, PageErr, PageOk, PaginatedWalk, WalkError},
    resilience::{
        cache::{self, TtlCache},
        deadline::{Deadline, DeadlineExceeded},
        resilient_call::{self as call, CallNumber, CallPhase, CallValue, RunCommand, RunSpec},
    },
    retry_backoff::{CountBound, RetryPolicy},
};
use serde::Serialize;
use std::rc::Rc;

pub use crate::work_queue::QueueTime as AppliedCursor;
const APPLIED_TTL_MS: f64 = 9_007_199_254_740_991.0;
pub type Actuals<A> = Rc<Vec<Rc<A>>>;
pub type Plan<C> = Rc<Vec<CallValue<C>>>;
pub type ItemsOf<'a, A, P, F> = Rc<dyn Fn(&CallValue<P>) -> Result<Vec<Rc<A>>, F> + 'a>;
pub type Diff<'a, A, D, C, F> = Rc<dyn Fn(&D, &Actuals<A>) -> Result<Plan<C>, F> + 'a>;
pub type Apply<'a, C, O, F> = Rc<dyn Fn(&Rc<C>) -> Result<O, F> + 'a>;
pub type IdOf<'a, C, F> = Rc<dyn Fn(&CallValue<C>) -> Result<JsText, F> + 'a>;
pub type LedgerProjection<'a, C> =
    Rc<dyn Fn(&CallValue<C>) -> Result<crate::PlainData, JsAccessError> + 'a>;
type Encode<C> = fn(&CallValue<C>) -> Result<crate::PlainData, DependencyError>;
enum Identity<'a, C, F> {
    Custom(IdOf<'a, C, F>),
    Json(Encode<C>),
}

pub struct Config<'a, A, D, P, C, K, F, O> {
    pub desired: Rc<D>,
    pub first_page: CallValue<K>,
    pub next_cursor: walk::NextCursor<'a, K, P, F>,
    pub items_of: ItemsOf<'a, A, P, F>,
    pub diff: Diff<'a, A, D, C, F>,
    pub apply: Apply<'a, C, O, F>,
    identity: Identity<'a, C, F>,
    pub retry: Option<RetryPolicy<CountBound>>,
    pub circuit: Option<call::CircuitConfig>,
    pub rate_limit: Option<call::RateLimitConfig>,
    pub deadline: Option<call::DeadlineConfig>,
}
impl<'a, A, D, P, C, K, F, O> Config<'a, A, D, P, C, K, F, O> {
    pub fn with_id(
        desired: Rc<D>,
        first_page: CallValue<K>,
        next_cursor: walk::NextCursor<'a, K, P, F>,
        items_of: ItemsOf<'a, A, P, F>,
        diff: Diff<'a, A, D, C, F>,
        apply: Apply<'a, C, O, F>,
        id_of: IdOf<'a, C, F>,
    ) -> Self {
        Self::configured(
            desired,
            first_page,
            next_cursor,
            items_of,
            diff,
            apply,
            Identity::Custom(id_of),
        )
    }
    fn configured(
        desired: Rc<D>,
        first_page: CallValue<K>,
        next_cursor: walk::NextCursor<'a, K, P, F>,
        items_of: ItemsOf<'a, A, P, F>,
        diff: Diff<'a, A, D, C, F>,
        apply: Apply<'a, C, O, F>,
        identity: Identity<'a, C, F>,
    ) -> Self {
        Self {
            desired,
            first_page,
            next_cursor,
            items_of,
            diff,
            apply,
            identity,
            retry: None,
            circuit: None,
            rate_limit: None,
            deadline: None,
        }
    }
}
impl<'a, A, D, P, C: Serialize, K, F, O> Config<'a, A, D, P, C, K, F, O> {
    pub fn new(
        desired: Rc<D>,
        first_page: CallValue<K>,
        next_cursor: walk::NextCursor<'a, K, P, F>,
        items_of: ItemsOf<'a, A, P, F>,
        diff: Diff<'a, A, D, C, F>,
        apply: Apply<'a, C, O, F>,
    ) -> Self {
        Self::configured(
            desired,
            first_page,
            next_cursor,
            items_of,
            diff,
            apply,
            Identity::Json(plain_data::<CallValue<C>>),
        )
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Idle,
    Scanning,
    Applying,
    Done,
    Failed,
}
pub struct Snapshot<A, C, P, K, E> {
    pub phase: Phase,
    pub walk: walk::State<K, P, E>,
    pub actual: Actuals<A>,
    pub plan: Plan<C>,
    pub applied_cursor: AppliedCursor,
    pub applied: Rc<TtlCache<CallValue<C>>>,
}
impl<A, C, P, K, E> Clone for Snapshot<A, C, P, K, E> {
    fn clone(&self) -> Self {
        Self {
            phase: self.phase,
            walk: self.walk.clone(),
            actual: self.actual.clone(),
            plan: self.plan.clone(),
            applied_cursor: self.applied_cursor,
            applied: self.applied.clone(),
        }
    }
}
pub struct State<A, C, P, K, E>(Rc<Snapshot<A, C, P, K, E>>);
impl<A, C, P, K, E> Clone for State<A, C, P, K, E> {
    fn clone(&self) -> Self {
        Self(self.0.clone())
    }
}
impl<A, C, P, K, E> State<A, C, P, K, E> {
    pub fn from_snapshot(snapshot: Snapshot<A, C, P, K, E>) -> Self {
        Self(Rc::new(snapshot))
    }
    pub fn snapshot(&self) -> &Snapshot<A, C, P, K, E> {
        &self.0
    }
    pub fn phase(&self) -> Phase {
        self.0.phase
    }
    pub fn walk(&self) -> &walk::State<K, P, E> {
        &self.0.walk
    }
    pub fn actual(&self) -> &Actuals<A> {
        &self.0.actual
    }
    pub fn plan(&self) -> &Plan<C> {
        &self.0.plan
    }
    pub fn applied_cursor(&self) -> AppliedCursor {
        self.0.applied_cursor
    }
    pub fn applied(&self) -> &TtlCache<CallValue<C>> {
        &self.0.applied
    }
    pub fn ptr_eq(&self, other: &Self) -> bool {
        Rc::ptr_eq(&self.0, &other.0)
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CallbackPhase {
    ItemsOf,
    Diff,
    Apply,
    Identity,
}
#[derive(Debug)]
pub enum ReconcileError<F> {
    Walk(WalkError<F>),
    Callback { phase: CallbackPhase, cause: F },
    Cache(JsAccessError),
    Identity(DependencyError),
}
impl<F> From<WalkError<F>> for ReconcileError<F> {
    fn from(error: WalkError<F>) -> Self {
        Self::Walk(error)
    }
}
pub type ReconcileStep<A, C, P, K, E, O> = Step<State<A, C, P, K, E>, O>;
pub type ReconcileResult<A, C, P, K, E, O, F> =
    Result<ReconcileStep<A, C, P, K, E, O>, ReconcileError<F>>;
type Scan<'a, K, P, E, F> = PaginatedWalk<'a, K, P, E, F, RunCommand<K, P, E>>;
/// The explicit identity path keeps opaque values unbounded. Choosing default
/// JSON identity requires Serialize only on Change at that constructor.
///
/// ```compile_fail,E0308
/// use std::rc::Rc;
/// use demlik_tea::flow::reconciler::{Config, Reconciler};
/// use demlik_tea::resilience::resilient_call::{CallValue, RunCommand};
/// let config = Config::new(Rc::new(()), CallValue::value(0_u32),
///     Rc::new(|_| Ok::<_, ()>(None)), Rc::new(|_| Ok(Vec::<Rc<()>>::new())),
///     Rc::new(|_, _| Ok(Rc::new(Vec::<CallValue<String>>::new()))),
///     Rc::new(|_| panic!("not invoked")));
/// let sync: Reconciler<'_, (), (), u32, String, u32, (), (), RunCommand<u32,u32,()>> = Reconciler::new(config);
/// sync.applied(&sync.init(), CallValue::value(42_u64), 0.0);
/// ```
pub struct Reconciler<'a, A, D, P, C, K, E, F, O> {
    walk: Scan<'a, K, P, E, F>,
    desired: Rc<D>,
    items_of: ItemsOf<'a, A, P, F>,
    diff: Diff<'a, A, D, C, F>,
    apply: Apply<'a, C, O, F>,
    identity: Identity<'a, C, F>,
    projection: Option<LedgerProjection<'a, C>>,
}
impl<'a, A, D, P, C, K, E, F, O: From<RunCommand<K, P, E>>> Reconciler<'a, A, D, P, C, K, E, F, O> {
    pub fn new(config: Config<'a, A, D, P, C, K, F, O>) -> Self {
        let mut scan = walk::Config::new(
            config.first_page,
            config.next_cursor,
            Rc::new(|_| Ok(vec![])),
        );
        scan.retry = config.retry;
        scan.circuit = config.circuit;
        scan.rate_limit = config.rate_limit;
        scan.deadline = config.deadline;
        Self {
            walk: PaginatedWalk::new(scan),
            desired: config.desired,
            items_of: config.items_of,
            diff: config.diff,
            apply: config.apply,
            identity: config.identity,
            projection: None,
        }
    }
    fn change_id(&self, change: &CallValue<C>) -> Result<Option<JsText>, ReconcileError<F>> {
        match &self.identity {
            Identity::Custom(id_of) => {
                id_of(change)
                    .map(Some)
                    .map_err(|cause| ReconcileError::Callback {
                        phase: CallbackPhase::Identity,
                        cause,
                    })
            }
            Identity::Json(encode) => encode(change)
                .map_err(ReconcileError::Identity)
                .map(|value| stringify_json(&value).map(JsText::from)),
        }
    }
    fn project_change(&self, change: &CallValue<C>) -> Result<crate::PlainData, JsAccessError> {
        if let Some(project) = &self.projection {
            return project(change);
        }
        match &self.identity {
            Identity::Json(encode) => encode(change).map_err(|cause| JsAccessError {
                name: "TypeError",
                message: cause.to_string(),
            }),
            Identity::Custom(_) => Err(JsAccessError {
                name: "ProjectionRefused",
                message: "record value needs an explicit projection codec".into(),
            }),
        }
    }
    pub fn with_ledger_projection(mut self, project: LedgerProjection<'a, C>) -> Self {
        self.projection = Some(project);
        self
    }
    pub fn with_rng(mut self, rng: impl Fn() -> f64 + 'a) -> Self {
        self.walk = self.walk.with_rng(rng);
        self
    }
    pub fn scan_page(&self) -> &CmdDef<RunSpec<K, P, E>> {
        self.walk.fetch()
    }
    pub fn init(&self) -> State<A, C, P, K, E> {
        State::from_snapshot(Snapshot {
            phase: Phase::Idle,
            walk: self.walk.init(),
            actual: Rc::new(vec![]),
            plan: Rc::new(vec![]),
            applied_cursor: 0.0.into(),
            applied: Rc::new(cache::init_cache()),
        })
    }
    fn with_walk(
        &self,
        state: &State<A, C, P, K, E>,
        walk: walk::State<K, P, E>,
    ) -> State<A, C, P, K, E> {
        State::from_snapshot(Snapshot {
            walk,
            ..state.snapshot().clone()
        })
    }
    fn scan_commands(commands: Vec<RunCommand<K, P, E>>) -> Vec<O> {
        commands.into_iter().map(O::from).collect()
    }
    pub fn scan(
        &self,
        state: &State<A, C, P, K, E>,
        at: impl Into<CallNumber>,
    ) -> ReconcileResult<A, C, P, K, E, O, F> {
        if state.phase() != Phase::Idle {
            return Ok(Step::new(state.clone(), vec![]));
        }
        let started = self.walk.start(state.walk(), at)?;
        let next = State::from_snapshot(Snapshot {
            phase: Phase::Scanning,
            walk: started.state,
            ..state.snapshot().clone()
        });
        Ok(Step::new(next, Self::scan_commands(started.commands)))
    }
    pub fn page_ok(
        &self,
        state: &State<A, C, P, K, E>,
        msg: PageOk<P>,
    ) -> ReconcileResult<A, C, P, K, E, O, F> {
        let page = msg.value.clone();
        let at = msg.at;
        let walked = self.walk.page_ok(state.walk(), msg)?;
        if state.phase() != Phase::Scanning {
            return Ok(Step::new(self.with_walk(state, walked.state), vec![]));
        }
        let items = (self.items_of)(&page).map_err(|cause| ReconcileError::Callback {
            phase: CallbackPhase::ItemsOf,
            cause,
        })?;
        let mut actual = state.actual().as_ref().clone();
        actual.extend(items);
        let scanned = State::from_snapshot(Snapshot {
            walk: walked.state,
            actual: Rc::new(actual),
            ..state.snapshot().clone()
        });
        let mut commands = Self::scan_commands(walked.commands);
        if self.walk.is_complete(scanned.walk()) {
            let planned = self.planned(&scanned, at, None)?;
            commands.extend(planned.commands);
            Ok(Step::new(planned.state, commands))
        } else {
            Ok(Step::new(scanned, commands))
        }
    }
    pub fn planned(
        &self,
        state: &State<A, C, P, K, E>,
        at: impl Into<CallNumber>,
        changes: Option<Plan<C>>,
    ) -> ReconcileResult<A, C, P, K, E, O, F> {
        let plan = match changes {
            Some(plan) => plan,
            None => (self.diff)(&self.desired, state.actual()).map_err(|cause| {
                ReconcileError::Callback {
                    phase: CallbackPhase::Diff,
                    cause,
                }
            })?,
        };
        let planning = State::from_snapshot(Snapshot {
            phase: Phase::Applying,
            plan,
            applied_cursor: 0.0.into(),
            ..state.snapshot().clone()
        });
        self.apply_next(&planning, at)
    }
    pub fn apply_next(
        &self,
        state: &State<A, C, P, K, E>,
        at: impl Into<CallNumber>,
    ) -> ReconcileResult<A, C, P, K, E, O, F> {
        if state.phase() != Phase::Applying {
            return Ok(Step::new(state.clone(), vec![]));
        }
        let at = at.into();
        let mut cursor = state.applied_cursor();
        while cursor.number_or_zero() < state.plan().len() as f64 {
            let change = cursor
                .number()
                .filter(|index| index.is_finite() && *index >= 0.0 && index.fract() == 0.0)
                .and_then(|index| state.plan().get(index as usize));
            let Some(CallValue::Shared(change)) = change else {
                cursor = (cursor.number_or_zero() + 1.0).into();
                continue;
            };
            let id = self.change_id(&CallValue::shared(change.clone()))?;
            let seen = match cache::get_with_projection(state.applied(), id, at, |value| {
                self.project_change(value)
            })
            .map_err(ReconcileError::Cache)?
            {
                None => false,
                Some(JsRead::Stored(value)) => !value.is_undefined(),
                Some(JsRead::Projected(value)) => !matches!(value, crate::PlainData::Undefined),
            };
            if !seen {
                let next = State::from_snapshot(Snapshot {
                    applied_cursor: cursor,
                    ..state.snapshot().clone()
                });
                let command = (self.apply)(change).map_err(|cause| ReconcileError::Callback {
                    phase: CallbackPhase::Apply,
                    cause,
                })?;
                return Ok(Step::new(next, vec![command]));
            }
            cursor = (cursor.number_or_zero() + 1.0).into();
        }
        Ok(Step::new(
            State::from_snapshot(Snapshot {
                phase: Phase::Done,
                applied_cursor: cursor,
                ..state.snapshot().clone()
            }),
            vec![],
        ))
    }
    pub fn applied(
        &self,
        state: &State<A, C, P, K, E>,
        change: CallValue<C>,
        at: impl Into<CallNumber>,
    ) -> ReconcileResult<A, C, P, K, E, O, F> {
        if state.phase() != Phase::Applying {
            return Ok(Step::new(state.clone(), vec![]));
        }
        let at = at.into();
        let id = self.change_id(&change)?;
        let ledger = cache::set(state.applied(), id, change, at, APPLIED_TTL_MS);
        let advanced = State::from_snapshot(Snapshot {
            applied: Rc::new(ledger),
            applied_cursor: (state.applied_cursor().number_or_zero() + 1.0).into(),
            ..state.snapshot().clone()
        });
        self.apply_next(&advanced, at)
    }
    fn with_scan_result(
        &self,
        state: &State<A, C, P, K, E>,
        walk: walk::State<K, P, E>,
    ) -> State<A, C, P, K, E> {
        let phase = if state.phase() == Phase::Scanning
            && matches!(
                walk.resilience().call(walk::PAGE_KEY),
                Some(CallPhase::Failed { .. })
            ) {
            Phase::Failed
        } else {
            state.phase()
        };
        State::from_snapshot(Snapshot {
            phase,
            walk,
            ..state.snapshot().clone()
        })
    }
    pub fn page_err(
        &self,
        state: &State<A, C, P, K, E>,
        msg: PageErr<E>,
    ) -> ReconcileResult<A, C, P, K, E, O, F> {
        let failed = self.walk.page_err(state.walk(), msg)?;
        Ok(Step::new(
            self.with_scan_result(state, failed.state),
            Self::scan_commands(failed.commands),
        ))
    }
    pub fn on_timer(
        &self,
        state: &State<A, C, P, K, E>,
        msg: &DeadlineExceeded,
    ) -> ReconcileResult<A, C, P, K, E, O, F> {
        let timed = self.walk.on_timer(state.walk(), msg)?;
        if timed.state.ptr_eq(state.walk()) {
            return Ok(Step::new(state.clone(), vec![]));
        }
        Ok(Step::new(
            self.with_scan_result(state, timed.state),
            Self::scan_commands(timed.commands),
        ))
    }
    pub fn deadlines(&self, state: &State<A, C, P, K, E>) -> Vec<Deadline> {
        self.walk.deadlines(state.walk())
    }
    pub fn timer(
        &self,
        state: &State<A, C, P, K, E>,
    ) -> Option<crate::TimerDeps<DeadlineExceeded>> {
        self.walk.timer(state.walk())
    }
    pub fn is_complete(&self, state: &State<A, C, P, K, E>) -> bool {
        state.phase() == Phase::Done
    }
}

pub fn lift_reconciler<S, A, C, P, K, E, O>(
    state: S,
    result: ReconcileStep<A, C, P, K, E, O>,
    replace: impl FnOnce(S, State<A, C, P, K, E>) -> S,
) -> Step<S, O> {
    crate::compose::lift_slice(state, result, replace)
}
