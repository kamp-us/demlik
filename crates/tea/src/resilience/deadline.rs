use serde::{Deserialize, Serialize};
use std::rc::Rc;

use crate::{
    Sub, Tagged,
    data::{DependencyError, JsText},
};

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
enum Kind {
    #[serde(rename = "deadline")]
    Deadline,
}

#[derive(Clone, Debug, Default)]
pub struct DeadlineOptions {
    pub name: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Deadline {
    pub id: JsText,
    #[serde(rename = "type")]
    kind: Kind,
    pub at_ms: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}
impl Deadline {
    pub fn named(mut self, name: impl Into<String>) -> Self {
        self.name = Some(name.into());
        self
    }
    pub fn with_options(mut self, options: DeadlineOptions) -> Self {
        self.name = options.name;
        self
    }
}
pub fn deadline_sub(id: impl Into<JsText>, at_ms: f64) -> Deadline {
    Deadline {
        id: id.into(),
        kind: Kind::Deadline,
        at_ms,
        name: None,
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeadlineExceeded {
    #[serde(rename = "type")]
    pub kind: String,
    pub id: JsText,
    pub at_ms: f64,
}
impl Tagged for DeadlineExceeded {
    fn tag(&self) -> &str {
        &self.kind
    }
}
pub fn deadline_msg_type(name: Option<&str>) -> String {
    name.map_or_else(
        || "deadline_exceeded".into(),
        |name| format!("{name}_deadline"),
    )
}
pub fn deadline_exceeded(
    id: impl Into<JsText>,
    at_ms: f64,
    name: Option<&str>,
) -> DeadlineExceeded {
    DeadlineExceeded {
        kind: deadline_msg_type(name),
        id: id.into(),
        at_ms,
    }
}
pub type DeadlinesSub = Sub<Vec<Deadline>>;

pub fn deadlines(list: &[Deadline]) -> Option<&[Deadline]> {
    (!list.is_empty()).then_some(list)
}

pub fn deadlines_sub<S>(
    select: impl Fn(&S) -> Vec<Deadline>,
) -> impl Fn(&S) -> Result<Option<DeadlinesSub>, DependencyError> {
    move |state| {
        let list = select(state);
        if list.is_empty() {
            Ok(None)
        } else {
            Sub::new("deadline", list).map(Some)
        }
    }
}

#[derive(Debug, Deserialize, Serialize)]
pub struct TimerDeps<M> {
    pub ms: f64,
    pub msg: M,
}
pub fn next_timer(list: &[Deadline], now_ms: f64) -> Option<TimerDeps<DeadlineExceeded>> {
    let mut soonest: Option<&Deadline> = None;
    for deadline in list {
        if soonest.is_none_or(|old| deadline.at_ms < old.at_ms) {
            soonest = Some(deadline);
        }
    }
    soonest.map(|deadline| TimerDeps {
        ms: crate::js_math::max(0.0, deadline.at_ms - now_ms),
        msg: deadline_exceeded(&deadline.id, deadline.at_ms, deadline.name.as_deref()),
    })
}

pub type Dispatch<M> = Rc<dyn Fn(M)>;
pub type ArmTimer<M, C, E> = dyn Fn(&JsText, f64, M, Dispatch<M>) -> Result<C, E>;
pub trait Cancel {
    type Error;
    fn cancel(&self) -> Result<(), Self::Error>;
}
impl<E, F: Fn() -> Result<(), E>> Cancel for F {
    type Error = E;
    fn cancel(&self) -> Result<(), E> {
        self()
    }
}
pub struct DeadlineSubscription<C> {
    cancels: Vec<C>,
}
impl<C: Cancel> DeadlineSubscription<C> {
    /// Calls host cleanups in list order, stopping at the first failure. Like
    /// the source runner, this does not implicitly await a host-owned task.
    pub fn cancel(&self) -> Result<(), C::Error> {
        for cancel in &self.cancels {
            cancel.cancel()?;
        }
        Ok(())
    }
}
pub fn subscribe_with<C: Cancel>(
    mut arm: impl FnMut(
        &JsText,
        f64,
        DeadlineExceeded,
        Dispatch<DeadlineExceeded>,
    ) -> Result<C, C::Error>,
    sub: &DeadlinesSub,
    dispatch: Dispatch<DeadlineExceeded>,
) -> Result<DeadlineSubscription<C>, C::Error> {
    let mut cancels = Vec::with_capacity(sub.deps().len());
    for deadline in sub.deps() {
        cancels.push(arm(
            &deadline.id,
            deadline.at_ms,
            deadline_exceeded(&deadline.id, deadline.at_ms, deadline.name.as_deref()),
            Rc::clone(&dispatch),
        )?);
    }
    Ok(DeadlineSubscription { cancels })
}
pub struct TimerCancellation<T: crate::timing::Timer> {
    timer: Rc<T>,
    handle: T::Handle,
}
impl<T: crate::timing::Timer> Cancel for TimerCancellation<T> {
    type Error = crate::timing::TimerError;
    fn cancel(&self) -> Result<(), Self::Error> {
        self.timer.clear_timeout(&self.handle);
        Ok(())
    }
}
pub fn set_timeout_arm_timer<T: crate::timing::Timer + 'static>(
    timer: Rc<T>,
) -> impl Fn(
    &JsText,
    f64,
    DeadlineExceeded,
    Dispatch<DeadlineExceeded>,
) -> Result<TimerCancellation<T>, crate::timing::TimerError> {
    move |_id, at_ms, msg, dispatch| {
        let handle = timer.set_timeout(
            crate::js_math::max(0.0, at_ms - timer.now_ms()),
            Box::new(move || {
                dispatch(msg);
                Ok(())
            }),
        )?;
        Ok(TimerCancellation {
            timer: Rc::clone(&timer),
            handle,
        })
    }
}
pub fn subscribe_deadline<T: crate::timing::Timer + 'static>(
    sub: &DeadlinesSub,
    timer: Rc<T>,
    dispatch: Dispatch<DeadlineExceeded>,
) -> Result<DeadlineSubscription<TimerCancellation<T>>, crate::timing::TimerError> {
    subscribe_with(set_timeout_arm_timer(timer), sub, dispatch)
}
