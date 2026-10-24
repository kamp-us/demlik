use std::any::Any;
use std::fmt;
use std::panic::AssertUnwindSafe;

use serde::Serialize;

use crate::data::{DependencyError, Sub};

pub enum ProjectionError {
    Dependency(DependencyError),
    Panic(Box<dyn Any + Send>),
}
impl fmt::Debug for ProjectionError {
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
        }
    }
}
#[derive(Debug)]
pub struct ProjectionFailure {
    pub kind: Option<String>,
    pub cause: ProjectionError,
}
pub struct SubEvaluation<U> {
    pub desired: Vec<U>,
    pub failures: Vec<ProjectionFailure>,
}

/// Pure declarations retain each dependency projection's owner through a failure.
pub trait SubscriptionProjection<S, U> {
    fn desired(&self, state: &S) -> Vec<U>;
    fn evaluate(&self, state: &S) -> SubEvaluation<U> {
        match std::panic::catch_unwind(AssertUnwindSafe(|| self.desired(state))) {
            Ok(desired) => SubEvaluation {
                desired,
                failures: vec![],
            },
            Err(payload) => SubEvaluation {
                desired: vec![],
                failures: vec![ProjectionFailure {
                    kind: None,
                    cause: ProjectionError::Panic(payload),
                }],
            },
        }
    }
}
impl<S, U, F: Fn(&S) -> Vec<U>> SubscriptionProjection<S, U> for F {
    fn desired(&self, state: &S) -> Vec<U> {
        self(state)
    }
}
pub type Subscriptions<'a, S, U> = Box<dyn SubscriptionProjection<S, U> + 'a>;

/// The whole-state projection form, with closure argument inference preserved.
pub fn subscriptions<'a, S, U>(project: impl Fn(&S) -> Vec<U> + 'a) -> Subscriptions<'a, S, U> {
    Box::new(project)
}

type Dependencies<'a, S, D> = Box<dyn Fn(&S) -> Option<D> + 'a>;
pub struct SubEntry<'a, S, D> {
    kind: String,
    deps: Dependencies<'a, S, D>,
}
impl<'a, S, D> SubEntry<'a, S, D> {
    pub fn new(kind: impl Into<String>, deps: impl Fn(&S) -> Option<D> + 'a) -> Self {
        Self {
            kind: kind.into(),
            deps: Box::new(deps),
        }
    }
}
impl<S, D: Serialize> SubEntry<'_, S, D> {
    fn project(&self, state: &S) -> Result<Option<Sub<D>>, DependencyError> {
        (self.deps)(state)
            .map(|deps| Sub::new(self.kind.clone(), deps))
            .transpose()
    }
}
pub struct SubscriptionEntries<'a, S, D> {
    entries: Vec<SubEntry<'a, S, D>>,
}
impl<'a, S, D> SubscriptionEntries<'a, S, D> {
    pub fn new(entries: Vec<SubEntry<'a, S, D>>) -> Self {
        Self { entries }
    }
}
impl<S, D: Serialize> SubscriptionProjection<S, Sub<D>> for SubscriptionEntries<'_, S, D> {
    fn desired(&self, state: &S) -> Vec<Sub<D>> {
        self.entries
            .iter()
            .filter_map(|entry| match entry.project(state) {
                Ok(sub) => sub,
                Err(error) => std::panic::panic_any(error),
            })
            .collect()
    }
    fn evaluate(&self, state: &S) -> SubEvaluation<Sub<D>> {
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
                Ok(Err(error)) => ProjectionError::Dependency(error),
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
