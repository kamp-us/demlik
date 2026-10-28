use std::any::Any;
use std::convert::Infallible;
use std::fmt;
use std::panic::AssertUnwindSafe;

use serde::Serialize;

use crate::data::{DependencyError, Sub};

pub enum ProjectionError<E = Infallible> {
    Dependency(DependencyError),
    Panic(Box<dyn Any + Send>),
    Declared(E),
}
impl<E> fmt::Debug for ProjectionError<E> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Dependency(error) => f.debug_tuple("Dependency").field(error).finish(),
            Self::Panic(payload) => f
                .debug_tuple("Panic")
                .field(
                    &payload
                        .downcast_ref::<String>()
                        .map(String::as_str)
                        .or_else(|| payload.downcast_ref::<&str>().copied())
                        .unwrap_or("non-string panic"),
                )
                .finish(),
            Self::Declared(_) => f.write_str("Declared(..)"),
        }
    }
}
#[derive(Debug)]
pub struct ProjectionFailure<E = Infallible> {
    pub kind: Option<String>,
    pub cause: ProjectionError<E>,
}
pub struct SubEvaluation<U, E = Infallible> {
    pub desired: Vec<U>,
    pub failures: Vec<ProjectionFailure<E>>,
}

/// Pure declarations retain each dependency projection's owner through a failure.
pub trait SubscriptionProjection<S, U, E = Infallible> {
    /// A declaration table can prove absence without executing any dependencies.
    fn is_declared_empty(&self) -> bool {
        false
    }
    fn desired(&self, state: &S) -> Result<Vec<U>, ProjectionError<E>>;
    fn evaluate(&self, state: &S) -> SubEvaluation<U, E> {
        let cause = match std::panic::catch_unwind(AssertUnwindSafe(|| self.desired(state))) {
            Ok(Ok(desired)) => {
                return SubEvaluation {
                    desired,
                    failures: vec![],
                };
            }
            Ok(Err(cause)) => cause,
            Err(payload) => ProjectionError::Panic(payload),
        };
        SubEvaluation {
            desired: vec![],
            failures: vec![ProjectionFailure { kind: None, cause }],
        }
    }
}
impl<S, U, F: Fn(&S) -> Vec<U>> SubscriptionProjection<S, U> for F {
    fn desired(&self, state: &S) -> Result<Vec<U>, ProjectionError> {
        Ok(self(state))
    }
}
pub type Subscriptions<'a, S, U, E = Infallible> = Box<dyn SubscriptionProjection<S, U, E> + 'a>;

/// The infallible projection keeps closure inference independent of an error type.
pub fn subscriptions<'a, S, U>(project: impl Fn(&S) -> Vec<U> + 'a) -> Subscriptions<'a, S, U> {
    Box::new(project)
}
struct FallibleProjection<F>(F);
impl<S, U, E, F: Fn(&S) -> Result<Vec<U>, E>> SubscriptionProjection<S, U, E>
    for FallibleProjection<F>
{
    fn desired(&self, state: &S) -> Result<Vec<U>, ProjectionError<E>> {
        (self.0)(state).map_err(ProjectionError::Declared)
    }
}
/// A whole-state typed refusal has no known unread kind. Use fallible entries
/// when sibling subscription types must reconcile independently.
pub fn try_subscriptions<'a, S, U, E>(
    project: impl Fn(&S) -> Result<Vec<U>, E> + 'a,
) -> Subscriptions<'a, S, U, E> {
    Box::new(FallibleProjection(project))
}

type Dependencies<'a, S, D, E> = Box<dyn Fn(&S) -> Result<Option<D>, E> + 'a>;
pub struct SubEntry<'a, S, D, E = Infallible> {
    kind: String,
    deps: Dependencies<'a, S, D, E>,
}
impl<'a, S, D> SubEntry<'a, S, D> {
    pub fn new(kind: impl Into<String>, deps: impl Fn(&S) -> Option<D> + 'a) -> Self {
        Self::try_new(kind, move |state| Ok(deps(state)))
    }
}
impl<'a, S, D, E> SubEntry<'a, S, D, E> {
    pub fn try_new(
        kind: impl Into<String>,
        deps: impl Fn(&S) -> Result<Option<D>, E> + 'a,
    ) -> Self {
        Self {
            kind: kind.into(),
            deps: Box::new(deps),
        }
    }
}
impl<S, D: Serialize, E> SubEntry<'_, S, D, E> {
    fn project(&self, state: &S) -> Result<Option<Sub<D>>, ProjectionError<E>> {
        (self.deps)(state)
            .map_err(ProjectionError::Declared)?
            .map(|deps| Sub::new(self.kind.clone(), deps))
            .transpose()
            .map_err(ProjectionError::Dependency)
    }
}
pub struct SubscriptionEntries<'a, S, D, E = Infallible> {
    entries: Vec<SubEntry<'a, S, D, E>>,
}
impl<'a, S, D, E> SubscriptionEntries<'a, S, D, E> {
    pub fn new(entries: Vec<SubEntry<'a, S, D, E>>) -> Self {
        Self { entries }
    }
}
impl<S, D: Serialize, E> SubscriptionProjection<S, Sub<D>, E> for SubscriptionEntries<'_, S, D, E> {
    fn is_declared_empty(&self) -> bool {
        self.entries.is_empty()
    }
    fn desired(&self, state: &S) -> Result<Vec<Sub<D>>, ProjectionError<E>> {
        let mut desired = Vec::new();
        for entry in &self.entries {
            if let Some(sub) = entry.project(state)? {
                desired.push(sub);
            }
        }
        Ok(desired)
    }
    fn evaluate(&self, state: &S) -> SubEvaluation<Sub<D>, E> {
        let mut evaluation = SubEvaluation {
            desired: vec![],
            failures: vec![],
        };
        for entry in &self.entries {
            let cause = match std::panic::catch_unwind(AssertUnwindSafe(|| entry.project(state))) {
                Ok(Ok(Some(sub))) => {
                    evaluation.desired.push(sub);
                    continue;
                }
                Ok(Ok(None)) => continue,
                Ok(Err(cause)) => cause,
                Err(payload) => ProjectionError::Panic(payload),
            };
            evaluation.failures.push(ProjectionFailure {
                kind: Some(entry.kind.clone()),
                cause,
            });
        }
        evaluation
    }
}
