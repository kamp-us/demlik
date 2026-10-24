use super::conventions::EntryExportConventions;
use crate::text::JsValue;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EntryExportPresetName {
    Nextjs,
}
impl EntryExportPresetName {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Nextjs => "nextjs",
        }
    }
}
pub fn entry_export_preset_names() -> Vec<EntryExportPresetName> {
    vec![EntryExportPresetName::Nextjs]
}
pub struct EntryExportPreset {
    pub dependency: String,
    pub conventions: EntryExportConventions,
}
pub fn entry_export_preset(name: EntryExportPresetName) -> EntryExportPreset {
    let data = JsValue::parse(include_str!("defaults.json"))
        .expect("primary-source preset data is valid JSON");
    let preset = data
        .get("presets")
        .and_then(|data| data.get(name.as_str()))
        .expect("preset enum covers the primary-source registry");
    EntryExportPreset {
        dependency: preset
            .get("dependency")
            .and_then(JsValue::as_string)
            .expect("preset dependency is a string")
            .to_utf8()
            .expect("built-in dependency is UTF-8"),
        conventions: super::rules::conventions(
            preset.get("conventions").expect("preset has conventions"),
            &[],
        )
        .expect("primary-source presets satisfy the convention contract"),
    }
}
