use super::settings::CollapseSettings;
use crate::{
    project::{Collation, CollationError, CollationInput},
    schema::{CallSite, FunctionNode},
    text::JsString,
};
use indexmap::{IndexMap, IndexSet};
use serde::{
    Serialize, Serializer,
    ser::{SerializeSeq, SerializeStruct},
};

/// The reported block and outcomes borrow the graph's original facts.
#[derive(Debug)]
pub struct PartialTwin<'a> {
    pub a: &'a FunctionNode,
    pub b: &'a FunctionNode,
    pub shared_block: &'a [CallSite],
    pub a_diverges: &'a CallSite,
    pub b_diverges: &'a CallSite,
    pub shared_constants: Vec<&'a str>,
    b_start: usize,
}

impl PartialTwin<'_> {
    pub fn b_block_line(&self) -> usize {
        calls(self.b)[self.b_start].line
    }
}

struct Callees<'a>(&'a [CallSite]);
impl Serialize for Callees<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut sequence = serializer.serialize_seq(Some(self.0.len()))?;
        for call in self.0 {
            sequence.serialize_element(&call.callee_id)?;
        }
        sequence.end()
    }
}
impl Serialize for PartialTwin<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut row = serializer.serialize_struct("PartialTwin", 14)?;
        row.serialize_field("aId", &self.a.id)?;
        row.serialize_field("aFile", &self.a.file)?;
        row.serialize_field("aStartLine", &self.a.start_line)?;
        row.serialize_field("aBlockLine", &self.shared_block[0].line)?;
        row.serialize_field("aDiverges", &self.a_diverges.callee_id)?;
        row.serialize_field("aDivergesLine", &self.a_diverges.line)?;
        row.serialize_field("bId", &self.b.id)?;
        row.serialize_field("bFile", &self.b.file)?;
        row.serialize_field("bStartLine", &self.b.start_line)?;
        row.serialize_field("bBlockLine", &self.b_block_line())?;
        row.serialize_field("bDiverges", &self.b_diverges.callee_id)?;
        row.serialize_field("bDivergesLine", &self.b_diverges.line)?;
        row.serialize_field("sharedBlock", &Callees(self.shared_block))?;
        row.serialize_field("sharedConstants", &self.shared_constants)?;
        row.end()
    }
}

fn calls(function: &FunctionNode) -> &[CallSite] {
    function
        .edges
        .as_ref()
        .map_or(&[], |edges| edges.calls.as_slice())
}

struct Run {
    a_start: usize,
    b_start: usize,
    length: usize,
}
fn extend_run(a: &[CallSite], b: &[CallSite], a_at: usize, b_at: usize, width: usize) -> Run {
    let (mut a_start, mut b_start) = (a_at, b_at);
    while a_start > 0 && b_start > 0 && a[a_start - 1].callee_id == b[b_start - 1].callee_id {
        a_start -= 1;
        b_start -= 1;
    }
    let (mut a_end, mut b_end) = (a_at + width, b_at + width);
    while a_end < a.len() && b_end < b.len() && a[a_end].callee_id == b[b_end].callee_id {
        a_end += 1;
        b_end += 1;
    }
    Run {
        a_start,
        b_start,
        length: a_end - a_start,
    }
}
fn shared_constants<'a>(
    a: &'a [CallSite],
    b: &[CallSite],
    collation: &Collation,
) -> Result<Vec<&'a str>, CollationError> {
    let mut shared = IndexSet::new();
    for (mine, theirs) in a.iter().zip(b) {
        for name in &mine.const_args {
            if theirs.const_args.contains(name) {
                shared.insert(name.as_str());
            }
        }
    }
    let mut shared = shared
        .into_iter()
        .map(|value| Ok((value, CollationInput::from_text(value)?)))
        .collect::<Result<Vec<_>, CollationError>>()?;
    shared.sort_by(|(_, a), (_, b)| collation.compare(a, b));
    Ok(shared.into_iter().map(|(value, _)| value).collect())
}
fn to_twin<'a>(
    a: &'a FunctionNode,
    b: &'a FunctionNode,
    run: Run,
    settings: &CollapseSettings,
    collation: &Collation,
) -> Result<Option<PartialTwin<'a>>, CollationError> {
    let (a_calls, b_calls) = (calls(a), calls(b));
    let a_next = run.a_start + run.length;
    let b_next = run.b_start + run.length;
    let Some(a_diverges) = a_calls.get(a_next) else {
        return Ok(None);
    };
    let Some(b_diverges) = b_calls.get(b_next) else {
        return Ok(None);
    };
    let a_block = &a_calls[run.a_start..a_next];
    let constants = shared_constants(a_block, &b_calls[run.b_start..b_next], collation)?;
    if (constants.len() as f64) < settings.partial_min_shared_constants {
        return Ok(None);
    }
    Ok(Some(PartialTwin {
        a,
        b,
        shared_block: a_block,
        a_diverges,
        b_diverges,
        shared_constants: constants,
        b_start: run.b_start,
    }))
}

#[derive(Clone, Copy)]
struct Occurrence {
    index: usize,
    at: usize,
}
fn shingle(candidates: &[&FunctionNode], width: usize) -> IndexMap<JsString, Vec<Occurrence>> {
    let mut windows: IndexMap<JsString, Vec<Occurrence>> = IndexMap::new();
    for (index, function) in candidates.iter().enumerate() {
        let calls = calls(function);
        if width > calls.len() {
            continue;
        }
        for at in 0..=calls.len() - width {
            // Source deliberately uses a literal space key, including its collisions.
            let mut key = JsString::default();
            for (position, call) in calls[at..at + width].iter().enumerate() {
                if position > 0 {
                    key.push_str(" ");
                }
                key.extend(&call.callee_id);
            }
            windows
                .entry(key)
                .or_default()
                .push(Occurrence { index, at });
        }
    }
    windows
}
fn better(candidate: &PartialTwin<'_>, held: &PartialTwin<'_>) -> bool {
    if candidate.shared_block.len() != held.shared_block.len() {
        return candidate.shared_block.len() > held.shared_block.len();
    }
    candidate.shared_constants.len() > held.shared_constants.len()
}
fn keep<'a>(best: &mut IndexMap<String, PartialTwin<'a>>, twin: PartialTwin<'a>) {
    let key = format!("{}\0{}", twin.a.id, twin.b.id);
    if best.get(&key).is_none_or(|held| better(&twin, held)) {
        best.insert(key, twin);
    }
}

/// Settings come from `CollapseSettings::parse` or its defaults. Input order defines pair sides.
pub fn find_partial_twins<'a>(
    candidates: &[&'a FunctionNode],
    settings: &CollapseSettings,
    collation: &Collation,
) -> Result<Vec<PartialTwin<'a>>, CollationError> {
    let width = settings.partial_min_prefix as usize;
    let mut best = IndexMap::new();
    for bucket in shingle(candidates, width).values() {
        if bucket.len() < 2 || bucket.len() as f64 > settings.partial_max_block_size {
            continue;
        }
        for i in 0..bucket.len() {
            for j in i + 1..bucket.len() {
                let (left, right) = (bucket[i], bucket[j]);
                if left.index == right.index {
                    continue;
                }
                let (a, b) = (candidates[left.index], candidates[right.index]);
                let run = extend_run(calls(a), calls(b), left.at, right.at, width);
                if let Some(twin) = to_twin(a, b, run, settings, collation)? {
                    keep(&mut best, twin);
                }
            }
        }
    }
    let mut twins = best
        .into_values()
        .map(|twin| {
            let a = CollationInput::from_text(&twin.a.id)?;
            let b = CollationInput::from_text(&twin.b.id)?;
            Ok((twin, a, b))
        })
        .collect::<Result<Vec<_>, CollationError>>()?;
    twins.sort_by(|(x, xa, xb), (y, ya, yb)| {
        y.shared_block
            .len()
            .cmp(&x.shared_block.len())
            .then_with(|| y.shared_constants.len().cmp(&x.shared_constants.len()))
            .then_with(|| collation.compare(xa, ya))
            .then_with(|| collation.compare(xb, yb))
    });
    Ok(twins.into_iter().map(|(twin, _, _)| twin).collect())
}
