use indexmap::IndexMap;
use std::collections::{HashMap, HashSet};

struct Frame {
    node: String,
    index: usize,
}
pub fn strongly_connected_components(
    nodes: &[String],
    adjacency: &IndexMap<String, Vec<String>>,
) -> IndexMap<String, usize> {
    let mut index = HashMap::new();
    let mut low = HashMap::new();
    let mut on_stack = HashSet::new();
    let mut stack = Vec::new();
    let mut components = IndexMap::new();
    let mut counter = 0usize;
    let mut component_count = 0usize;
    for start in nodes {
        if index.contains_key(start) {
            continue;
        }
        index.insert(start.clone(), counter);
        low.insert(start.clone(), counter);
        counter += 1;
        stack.push(start.clone());
        on_stack.insert(start.clone());
        let mut work = vec![Frame {
            node: start.clone(),
            index: 0,
        }];
        while let Some(frame) = work.last_mut() {
            let next = adjacency
                .get(&frame.node)
                .and_then(|neighbors| neighbors.get(frame.index))
                .cloned();
            if let Some(next) = next {
                frame.index += 1;
                if !index.contains_key(&next) {
                    index.insert(next.clone(), counter);
                    low.insert(next.clone(), counter);
                    counter += 1;
                    stack.push(next.clone());
                    on_stack.insert(next.clone());
                    work.push(Frame {
                        node: next,
                        index: 0,
                    });
                } else if on_stack.contains(&next) {
                    let minimum = low[&frame.node].min(index[&next]);
                    low.insert(frame.node.clone(), minimum);
                }
                continue;
            }
            let node = frame.node.clone();
            if low[&node] == index[&node] {
                while let Some(member) = stack.pop() {
                    on_stack.remove(&member);
                    let last = member == node;
                    components.insert(member, component_count);
                    if last {
                        break;
                    }
                }
                component_count += 1;
            }
            work.pop();
            if let Some(parent) = work.last() {
                let minimum = low[&parent.node].min(low[&node]);
                low.insert(parent.node.clone(), minimum);
            }
        }
    }
    components
}
pub fn scc_members(
    nodes: &[String],
    components: &IndexMap<String, usize>,
) -> IndexMap<usize, Vec<String>> {
    let mut members: IndexMap<usize, Vec<String>> = IndexMap::new();
    for node in nodes {
        if let Some(component) = components.get(node) {
            members.entry(*component).or_default().push(node.clone());
        }
    }
    members
}
