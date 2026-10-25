//! Published API facts shared by readers, diffs and the policy ratchet.
use crate::text::{JsString, object_keys};
use indexmap::IndexMap;
use serde::{Deserialize, Serialize, Serializer};
use serde_json::value::RawValue;
use std::sync::Arc;

// A JSON-key adapter at the serialization seam: ordinary serde map keys cannot
// encode lone UTF16 units. Values still use their canonical serde owners.
pub(crate) fn serialize_record<S: Serializer, T: Serialize>(
    record: &IndexMap<JsString, T>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    let mut json = String::from("{");
    for (index, key) in object_keys(record).into_iter().enumerate() {
        if index > 0 {
            json.push(',');
        }
        json.push_str(&serde_json::to_string(key).map_err(serde::ser::Error::custom)?);
        json.push(':');
        json.push_str(&serde_json::to_string(&record[key]).map_err(serde::ser::Error::custom)?);
    }
    json.push('}');
    RawValue::from_string(json)
        .map_err(serde::ser::Error::custom)?
        .serialize(serializer)
}
pub type ApiReferences = IndexMap<JsString, JsString>;
#[derive(Debug, Serialize)]
pub struct ApiEntryText {
    pub text: JsString,
    #[serde(serialize_with = "serialize_record")]
    pub references: Arc<ApiReferences>,
}
pub type SubpathNames = IndexMap<JsString, Arc<ApiEntryText>>;
#[derive(Debug, Serialize)]
pub struct AddedName {
    pub after: Arc<ApiEntryText>,
}
#[derive(Debug, Serialize)]
pub struct RemovedName {
    pub before: Arc<ApiEntryText>,
}
#[derive(Debug, Serialize)]
pub struct ChangedName {
    pub before: Arc<ApiEntryText>,
    pub after: Arc<ApiEntryText>,
}
#[derive(Debug, Serialize)]
pub struct SubpathDiff {
    pub tier: Option<JsString>,
    #[serde(serialize_with = "serialize_record")]
    pub added: IndexMap<JsString, AddedName>,
    #[serde(serialize_with = "serialize_record")]
    pub removed: IndexMap<JsString, RemovedName>,
    #[serde(serialize_with = "serialize_record")]
    pub changed: IndexMap<JsString, ChangedName>,
    #[serde(skip)]
    added_prototype: Option<AddedName>,
    #[serde(skip)]
    removed_prototype: Option<RemovedName>,
    #[serde(skip)]
    changed_prototype: Option<ChangedName>,
}
impl SubpathDiff {
    pub fn new(tier: Option<JsString>) -> Self {
        Self {
            tier,
            added: IndexMap::new(),
            removed: IndexMap::new(),
            changed: IndexMap::new(),
            added_prototype: None,
            removed_prototype: None,
            changed_prototype: None,
        }
    }
    pub fn added_prototype(&self) -> Option<&AddedName> {
        self.added_prototype.as_ref()
    }
    pub fn removed_prototype(&self) -> Option<&RemovedName> {
        self.removed_prototype.as_ref()
    }
    pub fn changed_prototype(&self) -> Option<&ChangedName> {
        self.changed_prototype.as_ref()
    }
    pub(crate) fn assign_added(&mut self, name: JsString, value: AddedName) {
        if name == "__proto__" {
            self.added_prototype = Some(value);
        } else {
            self.added.insert(name, value);
        }
    }
    pub(crate) fn assign_removed(&mut self, name: JsString, value: RemovedName) {
        if name == "__proto__" {
            self.removed_prototype = Some(value);
        } else {
            self.removed.insert(name, value);
        }
    }
    pub(crate) fn assign_changed(&mut self, name: JsString, value: ChangedName) {
        if name == "__proto__" {
            self.changed_prototype = Some(value);
        } else {
            self.changed.insert(name, value);
        }
    }
}
#[derive(Debug, Serialize)]
pub struct ApiDiff {
    pub root: JsString,
    pub base: JsString,
    pub compiler: JsString,
    #[serde(serialize_with = "serialize_record")]
    pub subpaths: IndexMap<JsString, SubpathDiff>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[repr(u8)]
#[serde(rename_all = "lowercase")]
pub enum Bump {
    None,
    Patch,
    Minor,
    Major,
}
pub const BUMPS: [Bump; 4] = [Bump::None, Bump::Patch, Bump::Minor, Bump::Major];
impl Bump {
    pub fn rank(self) -> usize {
        self as usize
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Patch => "patch",
            Self::Minor => "minor",
            Self::Major => "major",
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChangesetBump {
    Patch,
    Minor,
    Major,
}
impl From<ChangesetBump> for Bump {
    fn from(bump: ChangesetBump) -> Self {
        match bump {
            ChangesetBump::Patch => Self::Patch,
            ChangesetBump::Minor => Self::Minor,
            ChangesetBump::Major => Self::Major,
        }
    }
}
#[derive(Debug, Serialize)]
pub struct Changeset {
    pub file: JsString,
    pub bump: ChangesetBump,
    pub body: JsString,
}
#[derive(Debug, Serialize)]
pub struct ChangesetsSince {
    pub package: JsString,
    pub changesets: Vec<Changeset>,
}
#[derive(Debug, Serialize)]
pub struct BumpRule {
    pub bump: Bump,
    pub callout: bool,
}
#[derive(Debug, Serialize)]
pub struct TierRow {
    pub added: Arc<BumpRule>,
    pub changed: Arc<BumpRule>,
    pub removed: Arc<BumpRule>,
}
#[derive(Debug, Serialize)]
pub struct BumpPolicy {
    pub callout: JsString,
    #[serde(serialize_with = "serialize_record")]
    pub tiers: IndexMap<JsString, TierRow>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default: Option<TierRow>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChangeKind {
    Added,
    Changed,
    Removed,
}
impl ChangeKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Added => "added",
            Self::Changed => "changed",
            Self::Removed => "removed",
        }
    }
}
#[derive(Debug, Serialize)]
pub struct ApiChange {
    pub subpath: JsString,
    pub tier: Option<JsString>,
    pub name: JsString,
    pub kind: ChangeKind,
    pub before: Option<Arc<ApiEntryText>>,
    pub after: Option<Arc<ApiEntryText>>,
}
#[derive(Debug, Serialize)]
pub struct ApiRatchetMiss {
    #[serde(flatten)]
    pub change: ApiChange,
    pub needs: Arc<BumpRule>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiRatchetVerdict {
    pub passed: bool,
    pub base: JsString,
    pub package: JsString,
    pub changesets: Vec<JsString>,
    pub highest_bump: Bump,
    pub callout_found: bool,
    pub misses: Vec<ApiRatchetMiss>,
}
#[derive(Debug)]
pub struct VerdictContext {
    pub changes: f64,
    pub callout: JsString,
}
