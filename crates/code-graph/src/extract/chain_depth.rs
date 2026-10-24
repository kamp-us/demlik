use super::scc::{scc_members, strongly_connected_components};
use crate::schema::CallSite;
use indexmap::{IndexMap, IndexSet};
use std::collections::{HashMap, HashSet};

fn depth_of(
    component: usize,
    edges: &IndexMap<usize, IndexSet<usize>>,
    cyclic: &HashSet<usize>,
    depths: &mut HashMap<usize, usize>,
) -> usize {
    if let Some(depth) = depths.get(&component) {
        return *depth;
    }
    depths.insert(component, 0);
    let max_child = edges
        .get(&component)
        .into_iter()
        .flatten()
        .map(|child| depth_of(*child, edges, cyclic, depths))
        .max();
    let depth = max_child.map_or(0, |child| child + 1) + usize::from(cyclic.contains(&component));
    depths.insert(component, depth);
    depth
}
pub fn compute_chain_depths(
    ids: &[String],
    calls_by_id: &IndexMap<String, Vec<CallSite>>,
) -> IndexMap<String, usize> {
    let id_set: HashSet<_> = ids.iter().map(String::as_str).collect();
    let mut adjacency = IndexMap::new();
    let mut self_loops = HashSet::new();
    for id in ids {
        let mut targets = IndexSet::new();
        for call in calls_by_id.get(id).into_iter().flatten() {
            if call.callee_id.starts_with("external:") {
                continue;
            }
            let Ok(callee) = call.callee_id.to_utf8() else {
                continue;
            };
            if !id_set.contains(callee.as_str()) {
                continue;
            }
            if callee == *id {
                self_loops.insert(id.clone());
            } else {
                targets.insert(callee);
            }
        }
        adjacency.insert(id.clone(), targets.into_iter().collect());
    }
    let components = strongly_connected_components(ids, &adjacency);
    let members = scc_members(ids, &components);
    let mut edges: IndexMap<usize, IndexSet<usize>> = members
        .keys()
        .map(|component| (*component, IndexSet::new()))
        .collect();
    let cyclic: HashSet<_> = members
        .iter()
        .filter(|(_, members)| {
            members.len() > 1 || members.iter().any(|member| self_loops.contains(member))
        })
        .map(|(component, _)| *component)
        .collect();
    for id in ids {
        let Some(from) = components.get(id) else {
            continue;
        };
        for callee in adjacency.get(id).into_iter().flatten() {
            if let Some(to) = components.get(callee)
                && to != from
            {
                edges
                    .get_mut(from)
                    .expect("component initialized")
                    .insert(*to);
            }
        }
    }
    let mut depths = HashMap::new();
    ids.iter()
        .map(|id| {
            (
                id.clone(),
                components.get(id).map_or(0, |component| {
                    depth_of(*component, &edges, &cyclic, &mut depths)
                }),
            )
        })
        .collect()
}
