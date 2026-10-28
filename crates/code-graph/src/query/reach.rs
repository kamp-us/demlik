use crate::project::{Collation, CollationError, CollationInput};
use crate::schema::FunctionNode;
use indexmap::{IndexMap, IndexSet};

pub type Adjacency = IndexMap<String, Vec<String>>;

pub fn invoked_adjacency(
    functions: &[FunctionNode],
    collation: &Collation,
) -> Result<Adjacency, CollationError> {
    full_adjacency(functions, &IndexMap::new(), collation)
}

pub fn full_adjacency(
    functions: &[FunctionNode],
    references_by_id: &IndexMap<String, Vec<String>>,
    collation: &Collation,
) -> Result<Adjacency, CollationError> {
    let ids: IndexSet<_> = functions.iter().map(|node| node.id.as_str()).collect();
    functions
        .iter()
        .map(|node| {
            let mut targets = IndexSet::new();
            for call in node.edges.iter().flat_map(|edges| &edges.calls) {
                if let Ok(id) = call.callee_id.to_utf8()
                    && ids.contains(id.as_str())
                {
                    targets.insert(id);
                }
            }
            for id in references_by_id.get(&node.id).into_iter().flatten() {
                if ids.contains(id.as_str()) {
                    targets.insert(id.clone());
                }
            }
            let mut targets = targets
                .into_iter()
                .map(|value| CollationInput::from_text(&value).map(|key| (value, key)))
                .collect::<Result<Vec<_>, _>>()?;
            targets.sort_by(|left, right| collation.compare(&left.1, &right.1));
            Ok((
                node.id.clone(),
                targets.into_iter().map(|(value, _)| value).collect(),
            ))
        })
        .collect()
}

pub fn reachable_from(adjacency: &Adjacency, roots: &[String]) -> IndexSet<String> {
    let mut seen: IndexSet<_> = roots.iter().cloned().collect();
    let mut queue = roots.to_vec();
    let mut index = 0;
    while let Some(id) = queue.get(index) {
        for next in adjacency.get(id).into_iter().flatten() {
            if seen.insert(next.clone()) {
                queue.push(next.clone());
            }
        }
        index += 1;
    }
    seen
}
