use std::collections::{HashMap, HashSet};
use std::hash::Hash;

use indexmap::IndexMap;

pub fn strongly_connected_components<N: Clone + Eq + Hash>(
    nodes: &[N],
    adjacency: &HashMap<N, Vec<N>>,
) -> IndexMap<N, usize> {
    let mut graph = Tarjan {
        adjacency,
        index: HashMap::new(),
        low: HashMap::new(),
        active: Vec::new(),
        on_stack: HashSet::new(),
        components: IndexMap::new(),
        next_index: 0,
        next_component: 0,
    };
    for node in nodes {
        if !graph.index.contains_key(node) {
            graph.visit(node);
        }
    }
    graph.components
}

struct Frame<N> {
    node: N,
    next: usize,
}

struct Tarjan<'a, N> {
    adjacency: &'a HashMap<N, Vec<N>>,
    index: HashMap<N, usize>,
    low: HashMap<N, usize>,
    active: Vec<N>,
    on_stack: HashSet<N>,
    components: IndexMap<N, usize>,
    next_index: usize,
    next_component: usize,
}

impl<N: Clone + Eq + Hash> Tarjan<'_, N> {
    fn discover(&mut self, node: &N) {
        self.index.insert(node.clone(), self.next_index);
        self.low.insert(node.clone(), self.next_index);
        self.next_index += 1;
        self.active.push(node.clone());
        self.on_stack.insert(node.clone());
    }

    fn visit(&mut self, start: &N) {
        self.discover(start);
        let mut work = vec![Frame {
            node: start.clone(),
            next: 0,
        }];
        while let Some(frame) = work.last_mut() {
            let node = frame.node.clone();
            if let Some(next) = self
                .adjacency
                .get(&node)
                .and_then(|edges| edges.get(frame.next))
                .cloned()
            {
                frame.next += 1;
                if !self.index.contains_key(&next) {
                    self.discover(&next);
                    work.push(Frame {
                        node: next,
                        next: 0,
                    });
                } else if self.on_stack.contains(&next) {
                    self.low
                        .insert(node.clone(), self.low[&node].min(self.index[&next]));
                }
                continue;
            }
            if self.low[&node] == self.index[&node] {
                while let Some(member) = self.active.pop() {
                    self.on_stack.remove(&member);
                    let is_root = member == node;
                    self.components.insert(member, self.next_component);
                    if is_root {
                        break;
                    }
                }
                self.next_component += 1;
            }
            work.pop();
            if let Some(parent) = work.last() {
                self.low.insert(
                    parent.node.clone(),
                    self.low[&parent.node].min(self.low[&node]),
                );
            }
        }
    }
}

pub fn scc_members<N: Clone + Eq + Hash, K: Clone + Eq + Hash>(
    nodes: &[N],
    components: &IndexMap<N, K>,
) -> IndexMap<K, Vec<N>> {
    let mut members = IndexMap::new();
    for node in nodes {
        if let Some(component) = components.get(node) {
            members
                .entry(component.clone())
                .or_insert_with(Vec::new)
                .push(node.clone());
        }
    }
    members
}
