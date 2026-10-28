use super::settings::CollapseSettings;
use crate::schema::{FunctionKind, FunctionNode};

pub fn is_candidate_function(function: &FunctionNode, settings: &CollapseSettings) -> bool {
    if function.is_test || function.edges.is_none() {
        return false;
    }
    if matches!(
        function.kind,
        FunctionKind::Constructor | FunctionKind::Getter | FunctionKind::Setter
    ) {
        return false;
    }
    function.loc as f64 >= settings.min_loc && function.complexity as f64 >= settings.min_complexity
}

pub use super::{
    cost::CostInputs,
    signals::{Signal, SignalName},
};
use super::{
    cost::{CostContext, collapse_cost},
    partial::{PartialTwin, find_partial_twins},
    signals::{Twin, fired_signals, round4},
};
use crate::{
    project::{Collation, CollationError, CollationInput},
    text::JsString,
};
use indexmap::{IndexMap, IndexSet};
use serde::{Serialize, Serializer, ser::SerializeStruct};
use std::{cmp::Ordering, sync::Arc};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum BlockKind {
    Callee,
    Caller,
    NameToken,
}
impl BlockKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Callee => "callee",
            Self::Caller => "caller",
            Self::NameToken => "name-token",
        }
    }
}
#[derive(Debug, Serialize)]
pub struct SkippedBlock {
    pub kind: BlockKind,
    pub key: JsString,
    pub size: usize,
}
#[derive(Debug)]
pub struct CollapseCandidate<'g> {
    pub a: &'g FunctionNode,
    pub b: &'g FunctionNode,
    pub signals: Vec<Signal>,
    pub confidence: f64,
    pub cost: f64,
    pub cost_inputs: CostInputs,
    pub rank: f64,
}
impl Serialize for CollapseCandidate<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut row = serializer.serialize_struct("CollapseCandidate", 13)?;
        row.serialize_field("aId", &self.a.id)?;
        row.serialize_field("aFile", &self.a.file)?;
        row.serialize_field("aStartLine", &self.a.start_line)?;
        row.serialize_field("aEndLine", &self.a.end_line)?;
        row.serialize_field("bId", &self.b.id)?;
        row.serialize_field("bFile", &self.b.file)?;
        row.serialize_field("bStartLine", &self.b.start_line)?;
        row.serialize_field("bEndLine", &self.b.end_line)?;
        row.serialize_field("signals", &self.signals)?;
        row.serialize_field("confidence", &crate::text::JsValue::Number(self.confidence))?;
        row.serialize_field("cost", &crate::text::JsValue::Number(self.cost))?;
        row.serialize_field("costInputs", &self.cost_inputs)?;
        row.serialize_field("rank", &crate::text::JsValue::Number(self.rank))?;
        row.end()
    }
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollapseCluster<'g> {
    pub representative: Arc<CollapseCandidate<'g>>,
    pub members: Vec<&'g str>,
    pub pair_count: usize,
    #[serde(serialize_with = "crate::text::serialize_number")]
    pub rank: f64,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollapseReport<'g, 's> {
    pub settings: &'s CollapseSettings,
    pub considered_functions: usize,
    pub pairs_scored: usize,
    pub skipped_blocks: Vec<SkippedBlock>,
    pub candidates: Vec<Arc<CollapseCandidate<'g>>>,
    pub clusters: Vec<CollapseCluster<'g>>,
    pub partial_twins: Vec<PartialTwin<'g>>,
}

type Index = IndexMap<JsString, Vec<usize>>;
fn add_to(index: &mut Index, key: JsString, position: usize) {
    index.entry(key).or_default().push(position)
}
fn build_indexes(twins: &[Twin<'_>]) -> [Index; 3] {
    let (mut callees, mut callers, mut tokens) = (Index::new(), Index::new(), Index::new());
    for (position, twin) in twins.iter().enumerate() {
        for key in &twin.callees {
            add_to(&mut callees, (*key).clone(), position)
        }
        for key in &twin.callers {
            add_to(&mut callers, (*key).into(), position)
        }
        for key in &twin.tokens {
            add_to(&mut tokens, key.as_str().into(), position)
        }
    }
    [callees, callers, tokens]
}
fn propose_pairs(
    twins: &[Twin<'_>],
    settings: &CollapseSettings,
    collation: &Collation,
) -> Result<(IndexSet<u64>, Vec<SkippedBlock>), CollationError> {
    let mut pairs = IndexSet::new();
    let mut skipped = Vec::new();
    let stride = twins.len() as f64;
    for (kind, index) in [BlockKind::Callee, BlockKind::Caller, BlockKind::NameToken]
        .into_iter()
        .zip(build_indexes(twins))
    {
        for (key, members) in index {
            if members.len() < 2 {
                continue;
            }
            if members.len() as f64 > settings.max_block_size {
                skipped.push(SkippedBlock {
                    kind,
                    key,
                    size: members.len(),
                });
                continue;
            }
            for i in 0..members.len() {
                for j in i + 1..members.len() {
                    let encoded = members[i] as f64 * stride + members[j] as f64;
                    pairs.insert(encoded.to_bits());
                }
            }
        }
    }
    let mut skipped = skipped
        .into_iter()
        .map(|block| {
            let kind = CollationInput::from_text(block.kind.as_str())?;
            let key = CollationInput::from_utf16(block.key.units())?;
            Ok((block, kind, key))
        })
        .collect::<Result<Vec<_>, CollationError>>()?;
    skipped.sort_by(|(x, xk, xv), (y, yk, yv)| {
        y.size
            .cmp(&x.size)
            .then_with(|| collation.compare(xk, yk))
            .then_with(|| collation.compare(xv, yv))
    });
    Ok((
        pairs,
        skipped.into_iter().map(|(block, _, _)| block).collect(),
    ))
}
fn score_pair<'g>(
    a: &Twin<'g>,
    b: &Twin<'g>,
    settings: &CollapseSettings,
    context: &CostContext<'g, '_>,
    collation: &Collation,
) -> Result<Option<Arc<CollapseCandidate<'g>>>, CollationError> {
    let signals = fired_signals(a, b, settings, collation)?;
    if (signals.len() as f64) < settings.min_signals {
        return Ok(None);
    }
    let confidence = round4(
        signals
            .iter()
            .fold(0.0, |sum, signal| sum + signal.strength)
            / 4.0,
    );
    let inputs = context.inputs(a, b);
    let cost = collapse_cost(inputs, settings);
    Ok(Some(Arc::new(CollapseCandidate {
        a: a.function,
        b: b.function,
        signals,
        confidence,
        cost,
        cost_inputs: inputs,
        rank: round4(confidence / cost),
    })))
}
fn pair_key(a: &str, b: &str) -> String {
    if a.encode_utf16().cmp(b.encode_utf16()).is_lt() {
        format!("{a}\0{b}")
    } else {
        format!("{b}\0{a}")
    }
}
fn joinable(cluster: &CollapseCluster<'_>, id: &str, pairs: &IndexSet<String>) -> bool {
    cluster
        .members
        .iter()
        .all(|member| *member == id || pairs.contains(&pair_key(member, id)))
}
fn place<'g>(
    candidate: &Arc<CollapseCandidate<'g>>,
    clusters: &mut Vec<CollapseCluster<'g>>,
    membership: &mut IndexMap<&'g str, Vec<usize>>,
    pairs: &IndexSet<String>,
) {
    let a: &'g str = &candidate.a.id;
    let b: &'g str = &candidate.b.id;
    let seen: IndexSet<usize> = membership
        .get(a)
        .into_iter()
        .flatten()
        .chain(membership.get(b).into_iter().flatten())
        .copied()
        .collect();
    for index in seen {
        let Some(cluster) = clusters.get_mut(index) else {
            continue;
        };
        let has_a = cluster.members.contains(&a);
        let has_b = cluster.members.contains(&b);
        if has_a && has_b {
            cluster.pair_count += 1;
            return;
        }
        let joiner = if has_a { b } else { a };
        if !joinable(cluster, joiner, pairs) {
            continue;
        }
        cluster.members.push(joiner);
        cluster.pair_count += 1;
        membership.entry(joiner).or_default().push(index);
        return;
    }
    let index = clusters.len();
    clusters.push(CollapseCluster {
        representative: Arc::clone(candidate),
        members: vec![a, b],
        pair_count: 1,
        rank: candidate.rank,
    });
    membership.entry(a).or_default().push(index);
    membership.entry(b).or_default().push(index);
}
fn descending(a: f64, b: f64) -> Ordering {
    b.partial_cmp(&a).unwrap_or(Ordering::Equal)
}
fn cluster_candidates<'g>(
    candidates: &[Arc<CollapseCandidate<'g>>],
    collation: &Collation,
) -> Result<Vec<CollapseCluster<'g>>, CollationError> {
    let pairs = candidates
        .iter()
        .map(|c| pair_key(&c.a.id, &c.b.id))
        .collect();
    let mut clusters = Vec::new();
    let mut membership = IndexMap::new();
    for candidate in candidates {
        place(candidate, &mut clusters, &mut membership, &pairs)
    }
    for cluster in &mut clusters {
        cluster.members = cluster
            .members
            .iter()
            .copied()
            .collect::<IndexSet<_>>()
            .into_iter()
            .collect();
        let mut members = cluster
            .members
            .iter()
            .copied()
            .map(|member| Ok((member, CollationInput::from_text(member)?)))
            .collect::<Result<Vec<_>, CollationError>>()?;
        members.sort_by(|(_, a), (_, b)| collation.compare(a, b));
        cluster.members = members.into_iter().map(|(member, _)| member).collect();
    }
    let mut clusters = clusters
        .into_iter()
        .map(|cluster| {
            let key = CollationInput::from_text(&cluster.representative.a.id)?;
            Ok((cluster, key))
        })
        .collect::<Result<Vec<_>, CollationError>>()?;
    clusters.sort_by(|(a, ak), (b, bk)| {
        descending(a.rank, b.rank).then_with(|| collation.compare(ak, bk))
    });
    Ok(clusters.into_iter().map(|(cluster, _)| cluster).collect())
}

/// Compare canonical graph facts without IO. Returned rows borrow the original functions/settings;
/// a candidate and its cluster representative share one retained pair instance.
pub fn find_collapse_candidates<'g, 's>(
    functions: &'g [FunctionNode],
    package_roots: &[String],
    settings: &'s CollapseSettings,
    collation: &Collation,
) -> Result<CollapseReport<'g, 's>, CollationError> {
    let considered: Vec<_> = functions
        .iter()
        .filter(|node| is_candidate_function(node, settings))
        .collect();
    let mut keyed = considered
        .into_iter()
        .map(|node| Ok((node, CollationInput::from_text(&node.id)?)))
        .collect::<Result<Vec<_>, CollationError>>()?;
    keyed.sort_by(|(_, a), (_, b)| collation.compare(a, b));
    let considered: Vec<_> = keyed.into_iter().map(|(node, _)| node).collect();
    let twins = considered
        .iter()
        .map(|f| Twin::new(f, collation))
        .collect::<Result<Vec<_>, _>>()?;
    let (pairs, skipped) = propose_pairs(&twins, settings, collation)?;
    let context = CostContext::new(functions, package_roots, collation)?;
    let stride = twins.len() as f64;
    let mut candidates = Vec::new();
    for encoded in &pairs {
        let encoded = f64::from_bits(*encoded);
        let (a, b) = (
            (encoded / stride).floor() as usize,
            (encoded % stride) as usize,
        );
        let (Some(a), Some(b)) = (twins.get(a), twins.get(b)) else {
            continue;
        };
        if let Some(scored) = score_pair(a, b, settings, &context, collation)? {
            candidates.push(scored)
        }
    }
    let mut candidates = candidates
        .into_iter()
        .map(|candidate| {
            let a = CollationInput::from_text(&candidate.a.id)?;
            let b = CollationInput::from_text(&candidate.b.id)?;
            Ok((candidate, a, b))
        })
        .collect::<Result<Vec<_>, CollationError>>()?;
    candidates.sort_by(|(a, aa, ab), (b, ba, bb)| {
        descending(a.rank, b.rank)
            .then_with(|| collation.compare(aa, ba))
            .then_with(|| collation.compare(ab, bb))
    });
    let candidates: Vec<_> = candidates
        .into_iter()
        .map(|(candidate, _, _)| candidate)
        .collect();
    let clusters = cluster_candidates(&candidates, collation)?;
    Ok(CollapseReport {
        settings,
        considered_functions: twins.len(),
        pairs_scored: pairs.len(),
        skipped_blocks: skipped,
        candidates,
        clusters,
        partial_twins: find_partial_twins(&considered, settings, collation)?,
    })
}
