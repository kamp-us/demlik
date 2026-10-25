use super::OPTION_SPECS;
use crate::{project::locale_compare_units, text::JsString};

// Commander 11.1.0 lib/suggestSimilar.js, adapted only for this command's
// visible long options. Its optimal-string-alignment distance operates on
// JavaScript UTF-16 code units. See COMMANDER-LICENSE beside this module.
pub(super) fn similar(flag: &JsString) -> String {
    if !flag.starts_with("--") {
        return String::new();
    }
    let word = &flag.units()[2..];
    let mut similar = Vec::new();
    let mut best_distance = 3;
    for candidate in OPTION_SPECS
        .iter()
        .map(|spec| spec.long())
        .chain(["--help"])
    {
        let name = &candidate[2..];
        let units = name.encode_utf16().collect::<Vec<_>>();
        if units.len() <= 1 {
            continue;
        }
        let distance = edit_distance(word, &units);
        let length = word.len().max(units.len());
        let similarity = (length - distance) as f64 / length as f64;
        if similarity > 0.4 {
            if distance < best_distance {
                best_distance = distance;
                similar.clear();
                similar.push((candidate, units));
            } else if distance == best_distance {
                similar.push((candidate, units));
            }
        }
    }
    similar.sort_by(|left, right| locale_compare_units(&left.1, &right.1));
    let names = similar.iter().map(|(name, _)| *name).collect::<Vec<_>>();
    match names.as_slice() {
        [] => String::new(),
        [only] => format!("\n(Did you mean {only}?)"),
        _ => format!("\n(Did you mean one of {}?)", names.join(", ")),
    }
}

fn edit_distance(a: &[u16], b: &[u16]) -> usize {
    if a.len().abs_diff(b.len()) > 3 {
        return a.len().max(b.len());
    }
    let mut distance = vec![vec![0; b.len() + 1]; a.len() + 1];
    for (index, row) in distance.iter_mut().enumerate() {
        row[0] = index;
    }
    for (index, value) in distance[0].iter_mut().enumerate() {
        *value = index;
    }
    for j in 1..=b.len() {
        for i in 1..=a.len() {
            let cost = usize::from(a[i - 1] != b[j - 1]);
            distance[i][j] = (distance[i - 1][j] + 1)
                .min(distance[i][j - 1] + 1)
                .min(distance[i - 1][j - 1] + cost);
            if i > 1 && j > 1 && a[i - 1] == b[j - 2] && a[i - 2] == b[j - 1] {
                distance[i][j] = distance[i][j].min(distance[i - 2][j - 2] + 1);
            }
        }
    }
    distance[a.len()][b.len()]
}
