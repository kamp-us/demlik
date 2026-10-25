use super::{Actuals, AppliedCursor, Phase, Plan, Snapshot, State};
use crate::{
    data::{JsonData, plain_data},
    paginate::paginated_walk,
    resilience::{cache::TtlCache, resilient_call::CallValue},
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use std::rc::Rc;

impl<A: Serialize, C: Serialize, P: Serialize, K: Serialize, E: Serialize> Serialize
    for Snapshot<A, C, P, K, E>
{
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Fields<'a, A, C, P, K, E> {
            phase: Phase,
            walk: &'a paginated_walk::State<K, P, E>,
            actual: &'a Actuals<A>,
            plan: &'a Plan<C>,
            applied_cursor: AppliedCursor,
            applied: &'a TtlCache<CallValue<C>>,
        }
        let fields = Fields {
            phase: self.phase,
            walk: &self.walk,
            actual: &self.actual,
            plan: &self.plan,
            applied_cursor: self.applied_cursor,
            applied: &self.applied,
        };
        JsonData(&plain_data(&fields).map_err(serde::ser::Error::custom)?).serialize(serializer)
    }
}
impl<
    'de,
    A: DeserializeOwned,
    C: DeserializeOwned,
    P: DeserializeOwned,
    K: DeserializeOwned,
    E: DeserializeOwned,
> Deserialize<'de> for Snapshot<A, C, P, K, E>
{
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(
            rename_all = "camelCase",
            bound(
                deserialize = "A:DeserializeOwned,C:DeserializeOwned,P:DeserializeOwned,K:DeserializeOwned,E:DeserializeOwned"
            )
        )]
        struct Fields<A, C, P, K, E> {
            phase: Phase,
            walk: paginated_walk::State<K, P, E>,
            actual: Actuals<A>,
            plan: Plan<C>,
            applied_cursor: AppliedCursor,
            applied: Rc<TtlCache<CallValue<C>>>,
        }
        let fields = Fields::<A, C, P, K, E>::deserialize(deserializer)?;
        Ok(Self {
            phase: fields.phase,
            walk: fields.walk,
            actual: fields.actual,
            plan: fields.plan,
            applied_cursor: fields.applied_cursor,
            applied: fields.applied,
        })
    }
}
impl<A: Serialize, C: Serialize, P: Serialize, K: Serialize, E: Serialize> Serialize
    for State<A, C, P, K, E>
{
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.snapshot().serialize(serializer)
    }
}
impl<
    'de,
    A: DeserializeOwned,
    C: DeserializeOwned,
    P: DeserializeOwned,
    K: DeserializeOwned,
    E: DeserializeOwned,
> Deserialize<'de> for State<A, C, P, K, E>
{
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Snapshot::deserialize(deserializer).map(Self::from_snapshot)
    }
}
