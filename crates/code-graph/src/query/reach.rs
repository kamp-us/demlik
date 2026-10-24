use crate::project::locale_compare;
use crate::schema::FunctionNode;
use indexmap::{IndexMap, IndexSet};

pub type Adjacency = IndexMap<String, Vec<String>>;

pub fn invoked_adjacency(functions: &[FunctionNode]) -> Adjacency {
    full_adjacency(functions, &IndexMap::new())
}

pub fn full_adjacency(
    functions: &[FunctionNode],
    references_by_id: &IndexMap<String, Vec<String>>,
) -> Adjacency {
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
            let mut targets: Vec<_> = targets.into_iter().collect();
            targets.sort_by(|left, right| locale_compare(left, right));
            (node.id.clone(), targets)
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
