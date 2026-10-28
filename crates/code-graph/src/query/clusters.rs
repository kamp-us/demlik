use super::louvain::{Edge, louvain};
use crate::project::{Collation, CollationError, CollationInput};
use crate::schema::{
    ClusterAlgorithm, ClusterFileGroup, ClusterReport, DirectoryClusterGroup, FunctionNode,
    ModuleNode, ScatteredCluster, SplitDirectory,
};
use crate::smells::coupling::value_edges_of;
use indexmap::{IndexMap, IndexSet};

fn dirname(file: &str) -> String {
    let root = file.starts_with('/');
    let mut matched_slash = true;
    for (index, byte) in file.bytes().enumerate().skip(1).rev() {
        if byte == b'/' {
            if !matched_slash {
                return if root && index == 1 {
                    "//".into()
                } else {
                    file[..index].into()
                };
            }
        } else {
            matched_slash = false;
        }
    }
    if root { "/".into() } else { ".".into() }
}
fn group_by_dir(files: &[String]) -> IndexMap<String, Vec<String>> {
    let mut groups: IndexMap<String, Vec<String>> = IndexMap::new();
    for file in files {
        groups.entry(dirname(file)).or_default().push(file.clone());
    }
    groups
}
fn sorted_strings(
    values: Vec<String>,
    collation: &Collation,
) -> Result<Vec<String>, CollationError> {
    let mut values = values
        .into_iter()
        .map(|value| CollationInput::from_text(&value).map(|key| (value, key)))
        .collect::<Result<Vec<_>, _>>()?;
    values.sort_by(|a, b| collation.compare(&a.1, &b.1));
    Ok(values.into_iter().map(|(value, _)| value).collect())
}
fn bump(weights: &mut IndexMap<String, f64>, from: &str, to: &str) {
    if from == to {
        return;
    }
    let key = if from.encode_utf16().cmp(to.encode_utf16()).is_lt() {
        format!("{from}\t{to}")
    } else {
        format!("{to}\t{from}")
    };
    *weights.entry(key).or_default() += 1.0;
}
fn build_edges(
    functions: &[&FunctionNode],
    modules: &[&ModuleNode],
    nodes: &IndexSet<&str>,
    collation: &Collation,
) -> Result<Vec<Edge>, CollationError> {
    let mut weights = IndexMap::new();
    for edge in value_edges_of(modules.iter().copied()) {
        if nodes.contains(edge.from.as_str()) && nodes.contains(edge.to.as_str()) {
            bump(&mut weights, &edge.from, &edge.to);
        }
    }
    let file_of: IndexMap<_, _> = functions
        .iter()
        .filter(|node| nodes.contains(node.file.as_str()))
        .map(|node| (node.id.as_str(), node.file.as_str()))
        .collect();
    for node in functions {
        let Some(from) = file_of.get(node.id.as_str()) else {
            continue;
        };
        let mut seen = IndexSet::new();
        for call in node.edges.iter().flat_map(|edges| &edges.calls) {
            let Ok(id) = call.callee_id.to_utf8() else {
                continue;
            };
            let Some(to) = file_of.get(id.as_str()) else {
                continue;
            };
            if seen.insert(id) {
                bump(&mut weights, from, to);
            }
        }
    }
    let mut edges = Vec::new();
    for (key, weight) in weights {
        let mut parts = key.split('\t');
        if let (Some(a), Some(b)) = (parts.next(), parts.next()) {
            edges.push(Edge {
                a: a.into(),
                b: b.into(),
                weight,
            });
        }
    }
    let mut edges = edges
        .into_iter()
        .map(|edge| {
            let a = CollationInput::from_text(&edge.a)?;
            let b = CollationInput::from_text(&edge.b)?;
            Ok((edge, a, b))
        })
        .collect::<Result<Vec<_>, CollationError>>()?;
    edges.sort_by(|left, right| {
        collation
            .compare(&left.1, &right.1)
            .then_with(|| collation.compare(&left.2, &right.2))
    });
    Ok(edges.into_iter().map(|(edge, _, _)| edge).collect())
}
fn round_modularity(value: f64) -> f64 {
    ryu_js::Buffer::new()
        .format_to_fixed(value, 6)
        .parse()
        .expect("ECMAScript toFixed produces numeric text")
}

pub fn build_cluster_report(
    functions: &[FunctionNode],
    modules: &[ModuleNode],
    collation: &Collation,
) -> Result<ClusterReport, CollationError> {
    let production: Vec<_> = modules.iter().filter(|node| !node.is_test).collect();
    let node_set: IndexSet<_> = production.iter().map(|node| node.file.as_str()).collect();
    let functions: Vec<_> = functions.iter().filter(|node| !node.is_test).collect();
    let edges = build_edges(&functions, &production, &node_set, collation)?;
    let mut nodes = IndexSet::new();
    for edge in &edges {
        nodes.insert(edge.a.clone());
        nodes.insert(edge.b.clone());
    }
    let nodes = sorted_strings(nodes.into_iter().collect(), collation)?;
    let partition = louvain(&nodes, &edges, collation)?;
    let mut groups: IndexMap<String, Vec<String>> = IndexMap::new();
    for (file, community) in &partition.membership {
        groups
            .entry(community.clone())
            .or_default()
            .push(file.clone());
    }
    for files in groups.values_mut() {
        *files = sorted_strings(std::mem::take(files), collation)?;
    }
    let mut ordered = groups
        .iter()
        .map(|(community, files)| {
            CollationInput::from_text(files.first().map(String::as_str).unwrap_or(""))
                .map(|key| (community, files, key))
        })
        .collect::<Result<Vec<_>, _>>()?;
    ordered.sort_by(|left, right| {
        right
            .1
            .len()
            .cmp(&left.1.len())
            .then_with(|| collation.compare(&left.2, &right.2))
    });
    let width = ordered.len().to_string().len();
    let names: IndexMap<_, _> = ordered
        .into_iter()
        .enumerate()
        .map(|(index, (community, _, _))| (community.clone(), format!("c{:0width$}", index + 1)))
        .collect();
    let cluster_of: IndexMap<_, _> = partition
        .membership
        .iter()
        .map(|(file, community)| {
            (
                file.clone(),
                names.get(community).unwrap_or(community).clone(),
            )
        })
        .collect();
    let mut scattered_clusters = Vec::new();
    for (community, files) in &groups {
        let by_dir = group_by_dir(files);
        if by_dir.len() < 2 {
            continue;
        }
        let dirs: Vec<_> = by_dir
            .into_iter()
            .map(|(dir, files)| ClusterFileGroup { dir, files })
            .collect();
        let mut dirs = dirs
            .into_iter()
            .map(|row| CollationInput::from_text(&row.dir).map(|key| (row, key)))
            .collect::<Result<Vec<_>, _>>()?;
        dirs.sort_by(|left, right| {
            right
                .0
                .files
                .len()
                .cmp(&left.0.files.len())
                .then_with(|| collation.compare(&left.1, &right.1))
        });
        let dirs: Vec<_> = dirs.into_iter().map(|(row, _)| row).collect();
        scattered_clusters.push(ScatteredCluster {
            id: names.get(community).unwrap_or(community).clone(),
            size: files.len(),
            dir_count: dirs.len(),
            dirs,
        });
    }
    let mut scattered_clusters = scattered_clusters
        .into_iter()
        .map(|row| CollationInput::from_text(&row.id).map(|key| (row, key)))
        .collect::<Result<Vec<_>, _>>()?;
    scattered_clusters.sort_by(|left, right| {
        right
            .0
            .dir_count
            .cmp(&left.0.dir_count)
            .then_with(|| right.0.size.cmp(&left.0.size))
            .then_with(|| collation.compare(&left.1, &right.1))
    });
    let scattered_clusters: Vec<_> = scattered_clusters.into_iter().map(|(row, _)| row).collect();
    let all_files = sorted_strings(
        production.iter().map(|node| node.file.clone()).collect(),
        collation,
    )?;
    let mut split_directories = Vec::new();
    for (dir, files) in group_by_dir(&all_files) {
        let files = sorted_strings(files, collation)?;
        let mut grouped: IndexMap<String, Vec<String>> = IndexMap::new();
        let mut isolated_files = Vec::new();
        for file in &files {
            if let Some(id) = cluster_of.get(file) {
                grouped.entry(id.clone()).or_default().push(file.clone());
            } else {
                isolated_files.push(file.clone());
            }
        }
        if grouped.len() < 2 {
            continue;
        }
        let clusters: Vec<_> = grouped
            .into_iter()
            .map(|(cluster_id, files)| DirectoryClusterGroup { cluster_id, files })
            .collect();
        let mut clusters = clusters
            .into_iter()
            .map(|row| CollationInput::from_text(&row.cluster_id).map(|key| (row, key)))
            .collect::<Result<Vec<_>, _>>()?;
        clusters.sort_by(|left, right| {
            right
                .0
                .files
                .len()
                .cmp(&left.0.files.len())
                .then_with(|| collation.compare(&left.1, &right.1))
        });
        let clusters: Vec<_> = clusters.into_iter().map(|(row, _)| row).collect();
        split_directories.push(SplitDirectory {
            dir,
            file_count: files.len(),
            cluster_count: clusters.len(),
            clusters,
            isolated_files,
        });
    }
    let mut split_directories = split_directories
        .into_iter()
        .map(|row| CollationInput::from_text(&row.dir).map(|key| (row, key)))
        .collect::<Result<Vec<_>, _>>()?;
    split_directories.sort_by(|left, right| {
        right
            .0
            .cluster_count
            .cmp(&left.0.cluster_count)
            .then_with(|| right.0.file_count.cmp(&left.0.file_count))
            .then_with(|| collation.compare(&left.1, &right.1))
    });
    let split_directories: Vec<_> = split_directories.into_iter().map(|(row, _)| row).collect();
    Ok(ClusterReport {
        algorithm: ClusterAlgorithm::LouvainDeterministic,
        modularity: round_modularity(partition.modularity),
        cluster_count: groups.len(),
        clustered_file_count: nodes.len(),
        isolated_file_count: all_files.len() - nodes.len(),
        excluded_test_file_count: modules.len() - production.len(),
        scattered_clusters,
        split_directories,
    })
}
