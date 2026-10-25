use super::rules::Layer;
use crate::{
    project::locale_compare_units,
    text::{JsRegex, JsString},
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct LayerRank {
    pub name: JsString,
    pub rank: usize,
}
#[derive(Debug, PartialEq, Eq)]
struct Specificity {
    depth: usize,
    literal_segments: usize,
    literal_chars: usize,
}
pub struct Matcher {
    layer: LayerRank,
    pattern: JsString,
    regex: JsRegex,
    specificity: Specificity,
}
#[derive(Debug)]
pub struct LayerTieError {
    pub file: JsString,
    pub patterns: [JsString; 2],
}
impl LayerTieError {
    pub fn message(&self) -> JsString {
        let mut out = JsString::from("\"");
        out.extend(&self.file);
        out.push_str("\" is claimed equally by layer patterns \"");
        out.extend(&self.patterns[0]);
        out.push_str("\" and \"");
        out.extend(&self.patterns[1]);
        out.push_str("\"; make one of them more specific.");
        out
    }
}
impl std::fmt::Display for LayerTieError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message().to_lossy())
    }
}
impl std::error::Error for LayerTieError {}
fn segment_source(segment: &[u16]) -> JsString {
    if segment == [42] {
        return "[^/]+".into();
    }
    let mut out = JsString::default();
    for &unit in segment {
        if unit == 42 {
            out.push_str("[^/]*");
        } else {
            if ".+?^${}()|[]\\"
                .encode_utf16()
                .any(|special| special == unit)
            {
                out.push_str("\\");
            }
            out.extend(&JsString::from_units(vec![unit]));
        }
    }
    out
}
fn prefix_regex(segments: &[&[u16]]) -> Result<JsRegex, regress::Error> {
    let mut kept = segments;
    while kept.last().is_some_and(|segment| *segment == [42, 42]) {
        kept = &kept[..kept.len() - 1];
    }
    if kept.is_empty() {
        return JsRegex::new(&"^".into());
    }
    let mut source = JsString::from("^");
    for segment in kept {
        if *segment == [42, 42] {
            source.push_str("(?:[^/]+/)*");
        } else {
            source.extend(&segment_source(segment));
            source.push_str("/");
        }
    }
    let mut source = JsString::from_units(source.units()[..source.units().len() - 1].to_vec());
    source.push_str("(/|$)");
    JsRegex::new(&source)
}
fn compare_specificity(left: &Specificity, right: &Specificity) -> std::cmp::Ordering {
    right
        .depth
        .cmp(&left.depth)
        .then_with(|| right.literal_segments.cmp(&left.literal_segments))
        .then_with(|| right.literal_chars.cmp(&left.literal_chars))
}
pub fn compile_matchers(layers: &[Layer]) -> Result<Vec<Matcher>, regress::Error> {
    let mut out = Vec::new();
    for (rank, layer) in layers.iter().enumerate() {
        for pattern in &layer.paths {
            let segments: Vec<_> = pattern.units().split(|unit| *unit == 47).collect();
            let specificity = Specificity {
                depth: segments
                    .iter()
                    .filter(|segment| **segment != [42, 42])
                    .count(),
                literal_segments: segments
                    .iter()
                    .filter(|segment| !segment.contains(&42))
                    .count(),
                literal_chars: char::decode_utf16(pattern.units().iter().copied())
                    .filter(|character| !matches!(character, Ok('*' | '/')))
                    .count(),
            };
            out.push(Matcher {
                layer: LayerRank {
                    name: layer.name.clone(),
                    rank,
                },
                pattern: pattern.clone(),
                regex: prefix_regex(&segments)?,
                specificity,
            });
        }
    }
    out.sort_by(|left, right| {
        compare_specificity(&left.specificity, &right.specificity)
            .then_with(|| locale_compare_units(left.pattern.units(), right.pattern.units()))
    });
    Ok(out)
}
pub fn layer_of<'a>(
    file: &JsString,
    matchers: &'a [Matcher],
) -> Result<Option<&'a LayerRank>, LayerTieError> {
    let Some(at) = matchers.iter().position(|matcher| matcher.regex.test(file)) else {
        return Ok(None);
    };
    let winner = &matchers[at];
    for rival in &matchers[at + 1..] {
        if winner.specificity != rival.specificity {
            break;
        }
        if winner.layer.rank != rival.layer.rank && rival.regex.test(file) {
            return Err(LayerTieError {
                file: file.clone(),
                patterns: [winner.pattern.clone(), rival.pattern.clone()],
            });
        }
    }
    Ok(Some(&winner.layer))
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "direction", rename_all = "lowercase")]
pub enum EdgeDirection {
    Down,
    Sideways,
    Up,
    Unlayered,
}
pub fn direction_of(from: Option<&LayerRank>, to: Option<&LayerRank>) -> EdgeDirection {
    match (from, to) {
        (Some(from), Some(to)) => match from.rank.cmp(&to.rank) {
            std::cmp::Ordering::Less => EdgeDirection::Down,
            std::cmp::Ordering::Equal => EdgeDirection::Sideways,
            std::cmp::Ordering::Greater => EdgeDirection::Up,
        },
        _ => EdgeDirection::Unlayered,
    }
}
