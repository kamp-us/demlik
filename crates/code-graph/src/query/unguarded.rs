use super::reach::invoked_adjacency;
use crate::project::{Collation, CollationError, CollationInput};
use crate::schema::{EntryReach, FunctionNode, NodeKind, UnguardedEffect};
use indexmap::IndexMap;

fn is_guard(node: Option<&&FunctionNode>) -> bool {
    matches!(
        node.and_then(|node| node.node_kind.as_ref()),
        Some(NodeKind::Auth { .. })
    ) || matches!(node.and_then(|node| node.node_kind.as_ref()), Some(NodeKind::Entry { guards, .. }) if !guards.is_empty())
}

#[derive(Clone, PartialEq, Eq, Hash)]
struct State {
    id: String,
    guarded: bool,
}
struct Visit {
    parent: Option<State>,
    entry: String,
}

fn witness_path(visits: &IndexMap<State, Visit>, state: &State) -> Vec<String> {
    let mut path = Vec::new();
    let mut cursor = Some(state);
    while let Some(at) = cursor {
        path.push(at.id.clone());
        cursor = visits.get(at).and_then(|visit| visit.parent.as_ref());
    }
    path.reverse();
    path
}

pub fn find_unguarded(
    functions: &[FunctionNode],
    collation: &Collation,
) -> Result<Vec<UnguardedEffect>, CollationError> {
    let by_id: IndexMap<_, _> = functions
        .iter()
        .map(|node| (node.id.as_str(), node))
        .collect();
    let adjacency = invoked_adjacency(functions, collation)?;
    let mut found = IndexMap::new();
    for reach in EntryReach::ALL {
        let entries: Vec<_> = functions.iter().filter(|node| matches!(node.node_kind, Some(NodeKind::Entry { reach: own, .. }) if own == reach)).map(|node| node.id.clone()).collect();
        let mut entries = entries
            .into_iter()
            .map(|id| CollationInput::from_text(&id).map(|key| (id, key)))
            .collect::<Result<Vec<_>, _>>()?;
        entries.sort_by(|left, right| collation.compare(&left.1, &right.1));
        let mut visits: IndexMap<State, Visit> = IndexMap::new();
        let mut queue = Vec::new();
        for (id, _) in entries {
            let state = State {
                id: id.clone(),
                guarded: false,
            };
            if !visits.contains_key(&state) {
                visits.insert(
                    state.clone(),
                    Visit {
                        parent: None,
                        entry: id,
                    },
                );
                queue.push(state);
            }
        }
        let mut index = 0;
        while let Some(state) = queue.get(index).cloned() {
            let node = by_id.get(state.id.as_str());
            let guarded = state.guarded || is_guard(node);
            if !guarded
                && let Some(node) = node
                && matches!(node.node_kind, Some(NodeKind::Effect { .. }))
                && !found.contains_key(&node.id)
            {
                found.insert(
                    node.id.clone(),
                    UnguardedEffect {
                        effect_id: node.id.clone(),
                        file: node.file.clone(),
                        start_line: node.start_line,
                        entry_id: visits[&state].entry.clone(),
                        path: witness_path(&visits, &state),
                        reach,
                    },
                );
            }
            for next in adjacency.get(&state.id).into_iter().flatten() {
                let next_state = State {
                    id: next.clone(),
                    guarded,
                };
                if !visits.contains_key(&next_state) {
                    visits.insert(
                        next_state.clone(),
                        Visit {
                            parent: Some(state.clone()),
                            entry: visits[&state].entry.clone(),
                        },
                    );
                    queue.push(next_state);
                }
            }
            index += 1;
        }
    }
    let mut found = found
        .into_values()
        .map(|row| CollationInput::from_text(&row.effect_id).map(|key| (row, key)))
        .collect::<Result<Vec<_>, _>>()?;
    found.sort_by(|left, right| collation.compare(&left.1, &right.1));
    Ok(found.into_iter().map(|(row, _)| row).collect())
}
