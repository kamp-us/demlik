use super::louvain::{Edge, louvain};
use crate::project::locale_compare;
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
) -> Vec<Edge> {
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
    edges.sort_by(|left, right| {
        locale_compare(&left.a, &right.a).then_with(|| locale_compare(&left.b, &right.b))
    });
    edges
}
fn round_modularity(value: f64) -> f64 {
    // JS toFixed rounds an exact binary value's decimal halfway case upward.
    if !value.is_finite() || value.abs() >= 1e21 {
        return value;
    }
    let bits = value.abs().to_bits();
    let exponent = ((bits >> 52) & 0x7ff) as i32;
    let mantissa = (bits & ((1 << 52) - 1)) | if exponent == 0 { 0 } else { 1 << 52 };
    let exponent = if exponent == 0 {
        -1074
    } else {
        exponent - 1075
    };
    let scaled = u128::from(mantissa) * 1_000_000;
    let rounded = if exponent >= 0 {
        scaled << exponent
    } else {
        let shift = exponent.unsigned_abs();
        if shift >= 128 {
            0
        } else {
            let whole = scaled >> shift;
            whole + u128::from(shift > 0 && scaled & ((1u128 << shift) - 1) >= 1u128 << (shift - 1))
        }
    };
    (rounded as f64 / 1_000_000.0).copysign(value)
}
pub fn build_cluster_report(functions: &[FunctionNode], modules: &[ModuleNode]) -> ClusterReport {
    let production: Vec<_> = modules.iter().filter(|node| !node.is_test).collect();
    let node_set: IndexSet<_> = production.iter().map(|node| node.file.as_str()).collect();
    let functions: Vec<_> = functions.iter().filter(|node| !node.is_test).collect();
    let edges = build_edges(&functions, &production, &node_set);
    let mut nodes = IndexSet::new();
    for edge in &edges {
        nodes.insert(edge.a.clone());
        nodes.insert(edge.b.clone());
    }
    let mut nodes: Vec<_> = nodes.into_iter().collect();
    nodes.sort_by(|left, right| locale_compare(left, right));
    let partition = louvain(&nodes, &edges);
    let mut groups: IndexMap<String, Vec<String>> = IndexMap::new();
    for (file, community) in &partition.membership {
        groups
            .entry(community.clone())
            .or_default()
            .push(file.clone());
    }
    for files in groups.values_mut() {
        files.sort_by(|left, right| locale_compare(left, right));
    }
    let mut ordered: Vec<_> = groups.iter().collect();
    ordered.sort_by(|left, right| {
        right.1.len().cmp(&left.1.len()).then_with(|| {
            locale_compare(
                left.1.first().map(String::as_str).unwrap_or(""),
                right.1.first().map(String::as_str).unwrap_or(""),
            )
        })
    });
    let width = ordered.len().to_string().len();
    let names: IndexMap<_, _> = ordered
        .into_iter()
        .enumerate()
        .map(|(index, (community, _))| (community.clone(), format!("c{:0width$}", index + 1)))
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
        let mut dirs: Vec<_> = by_dir
            .into_iter()
            .map(|(dir, files)| ClusterFileGroup { dir, files })
            .collect();
        dirs.sort_by(|left, right| {
            right
                .files
                .len()
                .cmp(&left.files.len())
                .then_with(|| locale_compare(&left.dir, &right.dir))
        });
        scattered_clusters.push(ScatteredCluster {
            id: names.get(community).unwrap_or(community).clone(),
            size: files.len(),
            dir_count: dirs.len(),
            dirs,
        });
    }
    scattered_clusters.sort_by(|left, right| {
        right
            .dir_count
            .cmp(&left.dir_count)
            .then_with(|| right.size.cmp(&left.size))
            .then_with(|| locale_compare(&left.id, &right.id))
    });
    let mut all_files: Vec<_> = production.iter().map(|node| node.file.clone()).collect();
    all_files.sort_by(|left, right| locale_compare(left, right));
    let mut split_directories = Vec::new();
    for (dir, mut files) in group_by_dir(&all_files) {
        files.sort_by(|left, right| locale_compare(left, right));
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
        let mut clusters: Vec<_> = grouped
            .into_iter()
            .map(|(cluster_id, files)| DirectoryClusterGroup { cluster_id, files })
            .collect();
        clusters.sort_by(|left, right| {
            right
                .files
                .len()
                .cmp(&left.files.len())
                .then_with(|| locale_compare(&left.cluster_id, &right.cluster_id))
        });
        split_directories.push(SplitDirectory {
            dir,
            file_count: files.len(),
            cluster_count: clusters.len(),
            clusters,
            isolated_files,
        });
    }
    split_directories.sort_by(|left, right| {
        right
            .cluster_count
            .cmp(&left.cluster_count)
            .then_with(|| right.file_count.cmp(&left.file_count))
            .then_with(|| locale_compare(&left.dir, &right.dir))
    });
    ClusterReport {
        algorithm: ClusterAlgorithm::LouvainDeterministic,
        modularity: round_modularity(partition.modularity),
        cluster_count: groups.len(),
        clustered_file_count: nodes.len(),
        isolated_file_count: all_files.len() - nodes.len(),
        excluded_test_file_count: modules.len() - production.len(),
        scattered_clusters,
        split_directories,
    }
}
