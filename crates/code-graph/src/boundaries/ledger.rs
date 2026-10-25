//! A crossing keeps one identity across specifier rewrites and file moves.

use std::{
    collections::{HashMap, HashSet},
    fs, io,
    path::Path,
    sync::Arc,
};

use indexmap::IndexMap;
use serde::{Deserialize, Serialize, de::DeserializeOwned, ser::SerializeStruct};
use serde_json::value::RawValue;

use crate::{
    project::{locale_compare, locale_compare_units},
    text::JsString,
};

pub const LEDGER_FILENAME: &str = "boundary-ledger.json";

macro_rules! kinds {
    ($($variant:ident => ($name:literal, $nullable:literal)),* $(,)?) => {
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
        pub enum BoundaryKind { $(#[serde(rename = $name)] $variant),* }
        pub const BOUNDARY_KINDS: &[BoundaryKind] = &[$(BoundaryKind::$variant),*];
        impl BoundaryKind {
            pub const fn as_str(self) -> &'static str { match self { $(Self::$variant => $name),* } }
            pub const fn may_have_no_file(self) -> bool { match self { $(Self::$variant => $nullable),* } }
        }
    };
}
kinds! {
    AdapterLibraryImportedOutsideDriven => ("adapter-library-imported-outside-driven", false),
    ApplicationImportOutsideAllowlist => ("application-import-outside-allowlist", true),
    ApplicationImportsAdapter => ("application-imports-adapter", false),
    BindingOutsideDrivenAdapter => ("binding-outside-driven-adapter", true),
    CrossFeature => ("cross-feature", false),
    DrivingReachesDriven => ("driving-reaches-driven", false),
    Impure => ("impure", true),
    IndexNotExportsOnly => ("index-not-exports-only", true),
    LibImportsFeature => ("lib-imports-feature", false),
    LibraryImportsUp => ("library-imports-up", false),
    LibraryUndeclared => ("library-undeclared", true),
    OutsideImportsFeatureInternal => ("outside-imports-feature-internal", false),
    RelativeImportCrossesWorkspace => ("relative-import-crosses-workspace", false),
    TestReachesCompositionRoot => ("test-reaches-composition-root", false),
    UnknownZone => ("unknown-zone", true),
    WorkerCallCycle => ("worker-call-cycle", true),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BoundaryLedgerEntry {
    pub scope: JsString,
    pub kind: BoundaryKind,
    pub from: JsString,
    pub to: Option<JsString>,
    pub specifier: JsString,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<JsString>,
}
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct BoundaryLedger {
    pub entries: Vec<Arc<BoundaryLedgerEntry>>,
}
impl Serialize for BoundaryLedger {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut object = serializer.serialize_struct("BoundaryLedger", 1)?;
        object.serialize_field(
            "entries",
            &self.entries.iter().map(Arc::as_ref).collect::<Vec<_>>(),
        )?;
        object.end()
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileMove {
    pub from: JsString,
    pub to: JsString,
}
#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum LedgerRead {
    Absent,
    Read { ledger: BoundaryLedger },
    Invalid { message: JsString },
}
#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum LedgerFileRekey {
    Absent,
    Rekeyed { entries: usize },
    Invalid { message: JsString },
}

pub fn ledger_target_of(entry: &BoundaryLedgerEntry) -> &JsString {
    entry.to.as_ref().unwrap_or(&entry.specifier)
}
pub fn ledger_key(entry: &BoundaryLedgerEntry) -> String {
    serde_json::to_string(&(
        &entry.scope,
        entry.kind,
        &entry.from,
        ledger_target_of(entry),
    ))
    .expect("ledger identity consists of encodable strings")
}
pub fn boundary_ledger_of(entries: &[Arc<BoundaryLedgerEntry>]) -> BoundaryLedger {
    let mut by_key: IndexMap<String, Arc<BoundaryLedgerEntry>> = IndexMap::new();
    for entry in entries {
        let key = ledger_key(entry);
        if by_key
            .get(&key)
            .is_none_or(|held| held.reason.is_none() && entry.reason.is_some())
        {
            by_key.insert(key, Arc::clone(entry));
        }
    }
    let mut entries = by_key.into_values().collect::<Vec<_>>();
    entries.sort_by(|a, b| {
        locale_compare_units(a.scope.units(), b.scope.units())
            .then_with(|| locale_compare(a.kind.as_str(), b.kind.as_str()))
            .then_with(|| locale_compare_units(a.from.units(), b.from.units()))
            .then_with(|| {
                locale_compare_units(ledger_target_of(a).units(), ledger_target_of(b).units())
            })
            .then_with(|| locale_compare_units(a.specifier.units(), b.specifier.units()))
    });
    BoundaryLedger { entries }
}
pub fn rekey_boundary_ledger(ledger: &BoundaryLedger, moves: &[FileMove]) -> BoundaryLedger {
    let moved = moves
        .iter()
        .map(|item| (&item.from, &item.to))
        .collect::<HashMap<_, _>>();
    boundary_ledger_of(
        &ledger
            .entries
            .iter()
            .map(|entry| {
                Arc::new(BoundaryLedgerEntry {
                    from: moved
                        .get(&entry.from)
                        .map_or_else(|| entry.from.clone(), |value| (*value).clone()),
                    to: entry.to.as_ref().map(|target| {
                        moved
                            .get(target)
                            .map_or_else(|| target.clone(), |value| (*value).clone())
                    }),
                    ..(**entry).clone()
                })
            })
            .collect::<Vec<_>>(),
    )
}

type Fields = IndexMap<JsString, Box<RawValue>>;
fn decode<T: DeserializeOwned>(text: &str) -> Result<T, serde_json::Error> {
    let mut deserializer = serde_json::Deserializer::from_str(text);
    deserializer.disable_recursion_limit();
    let value = T::deserialize(&mut deserializer)?;
    deserializer.end()?;
    Ok(value)
}
fn received(raw: Option<&RawValue>) -> &'static str {
    match raw.map(|value| value.get().trim_start().as_bytes()[0]) {
        None => "undefined",
        Some(b'n') => "null",
        Some(b'[') => "array",
        Some(b'{') => "object",
        Some(b'"') => "string",
        Some(b't' | b'f') => "boolean",
        Some(_) => "number",
    }
}
fn issue(path: &str, detail: impl Into<JsString>) -> JsString {
    let mut units = format!("{}: ", if path.is_empty() { "(root)" } else { path })
        .encode_utf16()
        .collect::<Vec<_>>();
    units.extend_from_slice(detail.into().units());
    JsString::from_units(units)
}
fn invalid_type(path: &str, expected: &str, raw: Option<&RawValue>) -> JsString {
    issue(
        path,
        format!(
            "Invalid input: expected {expected}, received {}",
            received(raw)
        ),
    )
}
fn field<'a>(fields: &'a Fields, name: &str) -> Option<&'a RawValue> {
    fields
        .iter()
        .find(|(key, _)| *key == name)
        .map(|(_, raw)| &**raw)
}
fn text(raw: Option<&RawValue>, path: &str) -> Result<JsString, JsString> {
    if received(raw) != "string" {
        return Err(invalid_type(path, "string", raw));
    }
    let value: JsString =
        decode(raw.expect("checked present string").get()).expect("raw JSON string is validated");
    if value.is_empty() {
        return Err(issue(
            path,
            "Too small: expected string to have >=1 characters",
        ));
    }
    Ok(value)
}
fn object(raw: &RawValue, path: &str) -> Result<Fields, JsString> {
    if received(Some(raw)) != "object" {
        return Err(invalid_type(path, "object", Some(raw)));
    }
    decode(raw.get()).map_err(|_| issue(path, "not valid JSON"))
}
fn unknown_keys(fields: &Fields, names: &[&str], path: &str) -> Result<(), JsString> {
    let keys = crate::text::object_keys(fields)
        .into_iter()
        .filter(|key| !names.iter().any(|name| *key == *name))
        .collect::<Vec<_>>();
    if keys.is_empty() {
        return Ok(());
    }
    let mut detail = if keys.len() == 1 {
        "Unrecognized key: ".encode_utf16().collect::<Vec<_>>()
    } else {
        "Unrecognized keys: ".encode_utf16().collect::<Vec<_>>()
    };
    for (index, key) in keys.iter().enumerate() {
        if index > 0 {
            detail.extend(", ".encode_utf16());
        }
        detail.push(34);
        detail.extend_from_slice(key.units());
        detail.push(34);
    }
    Err(issue(path, JsString::from_units(detail)))
}
fn entry(raw: &RawValue, index: usize) -> Result<Arc<BoundaryLedgerEntry>, JsString> {
    let path = format!("entries.{index}");
    let fields = object(raw, &path)?;
    let scope = text(field(&fields, "scope"), &format!("{path}.scope"))?;
    let kind_raw = field(&fields, "kind");
    let name = kind_raw.and_then(|value| decode::<JsString>(value.get()).ok());
    let kind = BOUNDARY_KINDS
        .iter()
        .find(|kind| name.as_ref().is_some_and(|name| name == kind.as_str()))
        .copied()
        .ok_or_else(|| {
            issue(
                &format!("{path}.kind"),
                format!(
                    "Invalid option: expected one of {}",
                    BOUNDARY_KINDS
                        .iter()
                        .map(|kind| format!("\"{}\"", kind.as_str()))
                        .collect::<Vec<_>>()
                        .join("|")
                ),
            )
        })?;
    let from = text(field(&fields, "from"), &format!("{path}.from"))?;
    let to_raw = field(&fields, "to");
    let to = if received(to_raw) == "null" {
        None
    } else {
        Some(text(to_raw, &format!("{path}.to"))?)
    };
    let specifier = text(field(&fields, "specifier"), &format!("{path}.specifier"))?;
    let reason = field(&fields, "reason")
        .map(|value| text(Some(value), &format!("{path}.reason")))
        .transpose()?;
    unknown_keys(
        &fields,
        &["scope", "kind", "from", "to", "specifier", "reason"],
        &path,
    )?;
    if to.is_none() && !kind.may_have_no_file() {
        let allowed = BOUNDARY_KINDS
            .iter()
            .filter(|kind| kind.may_have_no_file())
            .map(|kind| kind.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        return Err(issue(
            &format!("{path}.to"),
            format!(
                "only a bare-specifier import, an impure use or a feature's entry may have a null `to` (kinds {allowed})"
            ),
        ));
    }
    Ok(Arc::new(BoundaryLedgerEntry {
        scope,
        kind,
        from,
        to,
        specifier,
        reason,
    }))
}
fn parse(text: &str) -> Result<BoundaryLedger, JsString> {
    let raw: Box<RawValue> = decode(text).map_err(|_| JsString::from("not valid JSON"))?;
    let fields = object(&raw, "")?;
    let entries = match field(&fields, "entries") {
        None => vec![],
        Some(raw) => {
            if received(Some(raw)) != "array" {
                return Err(invalid_type("entries", "array", Some(raw)));
            }
            let entries: Vec<Box<RawValue>> = decode(raw.get()).expect("validated JSON array");
            entries
                .iter()
                .enumerate()
                .map(|(index, raw)| entry(raw, index))
                .collect::<Result<Vec<_>, _>>()?
        }
    };
    unknown_keys(&fields, &["entries"], "")?;
    let mut seen = HashSet::new();
    for (index, entry) in entries.iter().enumerate() {
        let key = ledger_key(entry);
        if !seen.insert(key.clone()) {
            return Err(issue(
                &format!("entries.{index}"),
                format!("duplicate entry {key}"),
            ));
        }
    }
    Ok(boundary_ledger_of(&entries))
}
pub fn parse_boundary_ledger(text: &str) -> LedgerRead {
    match parse(text) {
        Ok(ledger) => LedgerRead::Read { ledger },
        Err(message) => LedgerRead::Invalid { message },
    }
}
pub fn read_boundary_ledger(file: &Path) -> io::Result<LedgerRead> {
    if !file.exists() {
        return Ok(LedgerRead::Absent);
    }
    let bytes = fs::read(file)?;
    Ok(parse_boundary_ledger(&String::from_utf8_lossy(&bytes)))
}
pub fn serialize_boundary_ledger(ledger: &BoundaryLedger) -> String {
    #[derive(Serialize)]
    struct SortedEntry<'a> {
        from: &'a JsString,
        kind: BoundaryKind,
        #[serde(skip_serializing_if = "Option::is_none")]
        reason: Option<&'a JsString>,
        scope: &'a JsString,
        specifier: &'a JsString,
        to: &'a Option<JsString>,
    }
    #[derive(Serialize)]
    struct SortedLedger<'a> {
        entries: Vec<SortedEntry<'a>>,
    }
    let ledger = boundary_ledger_of(&ledger.entries);
    let entries = ledger
        .entries
        .iter()
        .map(|entry| SortedEntry {
            from: &entry.from,
            kind: entry.kind,
            reason: entry.reason.as_ref(),
            scope: &entry.scope,
            specifier: &entry.specifier,
            to: &entry.to,
        })
        .collect();
    format!(
        "{}\n",
        serde_json::to_string_pretty(&SortedLedger { entries })
            .expect("typed ledger fields are JSON data")
    )
}
pub fn write_boundary_ledger(file: &Path, ledger: &BoundaryLedger) -> io::Result<()> {
    fs::write(file, serialize_boundary_ledger(ledger))
}
pub fn rekey_boundary_ledger_file(file: &Path, moves: &[FileMove]) -> io::Result<LedgerFileRekey> {
    let ledger = match read_boundary_ledger(file)? {
        LedgerRead::Absent => return Ok(LedgerFileRekey::Absent),
        LedgerRead::Invalid { message } => return Ok(LedgerFileRekey::Invalid { message }),
        LedgerRead::Read { ledger } => ledger,
    };
    let before = ledger
        .entries
        .iter()
        .map(|entry| ledger_key(entry))
        .collect::<HashSet<_>>();
    let rekeyed = rekey_boundary_ledger(&ledger, moves);
    let entries = rekeyed
        .entries
        .iter()
        .filter(|entry| !before.contains(&ledger_key(entry)))
        .count();
    write_boundary_ledger(file, &rekeyed)?;
    Ok(LedgerFileRekey::Rekeyed { entries })
}
