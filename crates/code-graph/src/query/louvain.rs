use crate::project::locale_compare;
use indexmap::IndexMap;
use serde::Serialize;

#[derive(Debug)]
pub struct Edge {
    pub a: String,
    pub b: String,
    pub weight: f64,
}
type Weights = IndexMap<String, f64>;
struct Level {
    order: Vec<String>,
    adjacency: IndexMap<String, Weights>,
    own: Weights,
    strength: Weights,
    m2: f64,
}
fn add_weight(adjacency: &mut IndexMap<String, Weights>, from: &str, to: &str, weight: f64) {
    *adjacency
        .entry(from.into())
        .or_default()
        .entry(to.into())
        .or_default() += weight;
}
fn make_level(adjacency: IndexMap<String, Weights>, own: Weights) -> Level {
    let mut strength = Weights::new();
    let mut m2 = 0.0;
    for (node, bucket) in &adjacency {
        let mut value = 2.0 * own.get(node).copied().unwrap_or(0.0);
        for weight in bucket.values() {
            value += weight;
        }
        strength.insert(node.clone(), value);
        m2 += value;
    }
    let mut order: Vec<_> = adjacency.keys().cloned().collect();
    order.sort_by(|left, right| {
        strength[right]
            .partial_cmp(&strength[left])
            .filter(|order| !order.is_eq())
            .unwrap_or_else(|| locale_compare(left, right))
    });
    Level {
        order,
        adjacency,
        own,
        strength,
        m2,
    }
}
fn initial_level(nodes: &[String], edges: &[Edge]) -> Level {
    let mut adjacency: IndexMap<_, _> = nodes
        .iter()
        .map(|node| (node.clone(), Weights::new()))
        .collect();
    for edge in edges {
        if edge.a == edge.b || !adjacency.contains_key(&edge.a) || !adjacency.contains_key(&edge.b)
        {
            continue;
        }
        add_weight(&mut adjacency, &edge.a, &edge.b, edge.weight);
        add_weight(&mut adjacency, &edge.b, &edge.a, edge.weight);
    }
    make_level(adjacency, Weights::new())
}
fn community_links(level: &Level, node: &str, communities: &IndexMap<String, String>) -> Weights {
    let mut links = Weights::new();
    for (neighbor, weight) in level.adjacency.get(node).into_iter().flatten() {
        if let Some(community) = communities.get(neighbor) {
            *links.entry(community.clone()).or_default() += weight;
        }
    }
    links
}
fn best_community(
    links: &Weights,
    total: &Weights,
    strength: f64,
    m2: f64,
    current: &str,
) -> String {
    let score = |community: &str| {
        links.get(community).copied().unwrap_or(0.0)
            - total.get(community).copied().unwrap_or(0.0) * strength / m2
    };
    let mut best = current;
    let mut best_score = score(current);
    let mut candidates: Vec<_> = links.keys().map(String::as_str).collect();
    candidates.sort_by(|left, right| locale_compare(left, right));
    for community in candidates {
        let candidate_score = score(community);
        if candidate_score > best_score + 1e-12 {
            best = community;
            best_score = candidate_score;
        }
    }
    best.into()
}
fn optimize_level(level: &Level) -> Option<IndexMap<String, String>> {
    if level.m2 == 0.0 {
        return None;
    }
    let mut communities: IndexMap<_, _> = level
        .order
        .iter()
        .map(|node| (node.clone(), node.clone()))
        .collect();
    let mut total: Weights = level
        .order
        .iter()
        .map(|node| (node.clone(), level.strength[node]))
        .collect();
    let mut moved = false;
    for _ in 0..20 {
        let mut changed = false;
        for node in &level.order {
            let current = communities[node].clone();
            let strength = level.strength[node];
            *total.entry(current.clone()).or_default() -= strength;
            let best = best_community(
                &community_links(level, node, &communities),
                &total,
                strength,
                level.m2,
                &current,
            );
            *total.entry(best.clone()).or_default() += strength;
            if best != current {
                communities.insert(node.clone(), best);
                changed = true;
            }
        }
        if !changed {
            break;
        }
        moved = true;
    }
    moved.then_some(communities)
}
fn aggregate(level: &Level, communities: &IndexMap<String, String>) -> Level {
    let mut adjacency = IndexMap::new();
    let mut own = Weights::new();
    for node in &level.order {
        let community = communities.get(node).unwrap_or(node);
        adjacency
            .entry(community.clone())
            .or_insert_with(Weights::new);
        *own.entry(community.clone()).or_default() += level.own.get(node).copied().unwrap_or(0.0);
    }
    for node in &level.order {
        for (neighbor, weight) in level.adjacency.get(node).into_iter().flatten() {
            if node.encode_utf16().cmp(neighbor.encode_utf16()).is_ge() {
                continue;
            }
            let left = communities.get(node).unwrap_or(node);
            let right = communities.get(neighbor).unwrap_or(neighbor);
            if left == right {
                *own.entry(left.clone()).or_default() += weight;
            } else {
                add_weight(&mut adjacency, left, right, *weight);
                add_weight(&mut adjacency, right, left, *weight);
            }
        }
    }
    make_level(adjacency, own)
}
fn modularity_of(level: &Level, membership: &IndexMap<String, String>) -> f64 {
    if level.m2 == 0.0 {
        return 0.0;
    }
    let mut inside = Weights::new();
    let mut total = Weights::new();
    for node in &level.order {
        let community = membership.get(node).unwrap_or(node);
        *total.entry(community.clone()).or_default() += level.strength[node];
        let mut internal = 2.0 * level.own.get(node).copied().unwrap_or(0.0);
        for (neighbor, weight) in level.adjacency.get(node).into_iter().flatten() {
            if membership.get(neighbor).unwrap_or(neighbor) == community {
                internal += weight;
            }
        }
        *inside.entry(community.clone()).or_default() += internal;
    }
    let mut keys: Vec<_> = total.keys().collect();
    keys.sort_by(|left, right| locale_compare(left, right));
    let mut result = 0.0;
    for community in keys {
        result += inside.get(community).copied().unwrap_or(0.0) / level.m2
            - (total[community] / level.m2).powi(2);
    }
    result
}
#[derive(Debug, Serialize)]
pub struct Partition {
    pub membership: IndexMap<String, String>,
    pub modularity: f64,
}
pub fn louvain(nodes: &[String], edges: &[Edge]) -> Partition {
    let base = initial_level(nodes, edges);
    let mut membership: IndexMap<_, _> = nodes
        .iter()
        .map(|node| (node.clone(), node.clone()))
        .collect();
    let mut level = None;
    for _ in 0..10 {
        let current = level.as_ref().unwrap_or(&base);
        let Some(communities) = optimize_level(current) else {
            break;
        };
        for community in membership.values_mut() {
            if let Some(next) = communities.get(community) {
                *community = next.clone();
            }
        }
        level = Some(aggregate(current, &communities));
    }
    Partition {
        modularity: modularity_of(&base, &membership),
        membership,
    }
}
