use crate::{
    extract::{cross_runtime::owner_of_text, wrangler_config::BindingCatalog},
    project::dirname_path_text,
    text::JsString,
};
pub(super) enum ReadSiteOwner<'a> {
    Worker { service: &'a JsString },
    UnparsedConfig,
    None,
}
pub(super) fn read_site_owner<'a>(
    catalog: &'a BindingCatalog,
    file: &JsString,
) -> ReadSiteOwner<'a> {
    let worker = owner_of_text(&catalog.manifests, file);
    let mut best: Option<JsString> = None;
    for config in &catalog.unparsed_configs {
        let mut dir = dirname_path_text(&config.as_str().into());
        if dir == "." {
            dir = JsString::default();
        }
        if !dir.is_empty() {
            let mut prefix = dir.clone();
            prefix.push_str("/");
            if !file.units().starts_with(prefix.units()) {
                continue;
            }
        }
        if best
            .as_ref()
            .is_none_or(|best| dir.units().len() > best.units().len())
        {
            best = Some(dir);
        }
    }
    if best
        .as_ref()
        .is_some_and(|dir| worker.is_none_or(|w| dir.units().len() > w.dir.encode_utf16().count()))
    {
        return ReadSiteOwner::UnparsedConfig;
    }
    worker.map_or(ReadSiteOwner::None, |w| ReadSiteOwner::Worker {
        service: &w.service,
    })
}
