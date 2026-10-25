use crate::{
    api::model::{ApiEntryText, ApiRatchetMiss, ApiRatchetVerdict, Bump, BumpRule, VerdictContext},
    render::text::{join, number},
    text::JsString,
};
fn counted(count: f64) -> JsString {
    format!(
        "{} {}",
        number(count),
        if count == 1.0 { "change" } else { "changes" }
    )
    .into()
}
fn indented(text: &JsString) -> JsString {
    join(
        text.units()
            .split(|unit| *unit == b'\n' as u16)
            .map(|part| {
                let mut line = JsString::from("    ");
                line.extend(&JsString::from_units(part.to_vec()));
                line
            }),
        "\n",
    )
}
fn entry_lines(label: &str, entry: Option<&ApiEntryText>) -> Vec<JsString> {
    let Some(entry) = entry else {
        return Vec::new();
    };
    let mut lines = vec![format!("  {label}:").into(), indented(&entry.text)];
    let mut keys = entry.references.keys().collect::<Vec<_>>();
    keys.sort();
    for key in keys {
        let mut reference = key.clone();
        reference.push_str(": ");
        reference.extend(&entry.references[key]);
        lines.push(indented(&reference));
    }
    lines
}
fn need_text(needs: &BumpRule, callout: &JsString) -> JsString {
    let mut text = JsString::from(if needs.bump == Bump::None {
        "a changeset".into()
    } else {
        format!("a {} changeset", needs.bump.as_str())
    });
    if needs.callout {
        text.push_str(" with a ");
        text.push_str(&serde_json::to_string(callout).expect("JavaScript string is JSON data"));
        text.push_str(" callout");
    }
    text
}
fn found_text(verdict: &ApiRatchetVerdict, needs: &BumpRule) -> JsString {
    if verdict.highest_bump == Bump::None || !needs.callout {
        verdict.highest_bump.as_str().into()
    } else {
        format!(
            "{} with {} callout",
            verdict.highest_bump.as_str(),
            if verdict.callout_found { "the" } else { "no" }
        )
        .into()
    }
}
fn miss_lines(
    miss: &ApiRatchetMiss,
    verdict: &ApiRatchetVerdict,
    callout: &JsString,
) -> Vec<JsString> {
    let change = &miss.change;
    let mut head = JsString::from("API RATCHET: ");
    head.extend(&change.name);
    head.push_str(" in ");
    head.extend(&change.subpath);
    head.push_str(" (");
    head.extend(change.tier.as_ref().unwrap_or(&JsString::from("no tier")));
    head.push_str(") ");
    head.push_str(change.kind.as_str());
    head.push_str(" — needs ");
    head.extend(&need_text(&miss.needs, callout));
    head.push_str("; found ");
    head.extend(&found_text(verdict, &miss.needs));
    let mut lines = vec![head];
    lines.extend(entry_lines("before", change.before.as_deref()));
    lines.extend(entry_lines("after", change.after.as_deref()));
    lines
}
pub fn render_api_ratchet(verdict: &ApiRatchetVerdict, context: &VerdictContext) -> JsString {
    let base =
        JsString::from_units(verdict.base.units()[..verdict.base.units().len().min(7)].to_vec());
    let mut out = if verdict.passed {
        let mut text = JsString::from("API RATCHET: pass — ");
        text.extend(&counted(context.changes));
        text.push_str(" against ");
        text.extend(&base);
        text.push_str(", highest changeset bump ");
        text.push_str(verdict.highest_bump.as_str());
        text.push_str(if verdict.callout_found {
            ", callout found"
        } else {
            ", no callout"
        });
        text
    } else {
        let mut blocks = verdict
            .misses
            .iter()
            .flat_map(|miss| miss_lines(miss, verdict, &context.callout))
            .collect::<Vec<_>>();
        let mut summary = JsString::from(format!("API RATCHET: {} of ", verdict.misses.len()));
        summary.extend(&counted(context.changes));
        summary.push_str(if verdict.misses.len() == 1 {
            " misses its"
        } else {
            " miss their"
        });
        summary.push_str(" bump against ");
        summary.extend(&base);
        blocks.push(summary);
        join(blocks, "\n")
    };
    out.push_str("\n");
    out
}
