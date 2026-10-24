use crate::project::locale_compare_units;
use crate::text::JsString;
use indexmap::IndexMap;

/// An unflagged ECMAScript pattern, matching JavaScript's UTF-16 code units.
#[derive(Debug)]
pub struct JsRegex(regress::Regex);
impl JsRegex {
    pub fn new(source: &JsString) -> Result<Self, regress::Error> {
        regress::Regex::from_unicode(
            source.units().iter().copied().map(u32::from),
            regress::Flags::default(),
        )
        .map(Self)
    }
    pub fn test(&self, value: &JsString) -> bool {
        self.0.find_from_ucs2(value.units(), 0).next().is_some()
    }
    pub fn test_str(&self, value: &str) -> bool {
        self.test(&value.into())
    }
}
pub type PatternGroup = IndexMap<JsString, Vec<JsString>>;
#[derive(Debug)]
pub struct CompiledRule {
    pub key: JsString,
    pub patterns: Vec<JsRegex>,
}
pub fn compile_group(group: &PatternGroup) -> Result<Vec<CompiledRule>, regress::Error> {
    let mut keys: Vec<_> = group.keys().collect();
    keys.sort_by(|left, right| locale_compare_units(left.units(), right.units()));
    keys.into_iter()
        .map(|key| {
            Ok(CompiledRule {
                key: key.clone(),
                patterns: group[key]
                    .iter()
                    .map(JsRegex::new)
                    .collect::<Result<_, _>>()?,
            })
        })
        .collect()
}
pub fn matching_rules(rules: &[CompiledRule], value: &JsString) -> Vec<JsString> {
    rules
        .iter()
        .filter(|rule| rule.patterns.iter().any(|pattern| pattern.test(value)))
        .map(|rule| rule.key.clone())
        .collect()
}
