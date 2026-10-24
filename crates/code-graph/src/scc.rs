use std::collections::{HashMap, HashSet};
use std::hash::Hash;

use indexmap::IndexMap;

pub fn strongly_connected_components(
    nodes: &[String],
    adjacency: &HashMap<String, Vec<String>>,
) -> IndexMap<String, usize> {
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

struct Frame {
    node: String,
    next: usize,
}

struct Tarjan<'a> {
    adjacency: &'a HashMap<String, Vec<String>>,
    index: HashMap<String, usize>,
    low: HashMap<String, usize>,
    active: Vec<String>,
    on_stack: HashSet<String>,
    components: IndexMap<String, usize>,
    next_index: usize,
    next_component: usize,
}

impl Tarjan<'_> {
    fn discover(&mut self, node: &str) {
        self.index.insert(node.to_owned(), self.next_index);
        self.low.insert(node.to_owned(), self.next_index);
        self.next_index += 1;
        self.active.push(node.to_owned());
        self.on_stack.insert(node.to_owned());
    }

    fn visit(&mut self, start: &str) {
        self.discover(start);
        let mut work = vec![Frame {
            node: start.to_owned(),
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

pub fn scc_members<K: Clone + Eq + Hash>(
    nodes: &[String],
    components: &IndexMap<String, K>,
) -> IndexMap<K, Vec<String>> {
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
