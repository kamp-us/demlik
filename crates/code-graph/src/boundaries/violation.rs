//! Boundary verdicts preserve the fields owned by each rule.

use super::ledger::{BoundaryKind, BoundaryLedgerEntry};
use crate::text::JsString;
use serde::{Deserialize, Deserializer, Serialize, Serializer, de::Error};
use std::sync::Arc;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct False;
impl Serialize for False {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_bool(false)
    }
}
impl<'de> Deserialize<'de> for False {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        if bool::deserialize(deserializer)? {
            Err(D::Error::custom("expected false"))
        } else {
            Ok(Self)
        }
    }
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct WriteSite {
    pub file: JsString,
    pub line: f64,
    pub binding: JsString,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScopeBoundaryReport {
    pub scope: JsString,
    pub features: Vec<JsString>,
    pub files_scanned: f64,
    pub violations: Vec<BoundaryViolation>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workers: Option<Vec<JsString>>,
}

// Decode each tagged row directly from raw JSON. Serde's buffered internally
// tagged decoder cannot retain a lone UTF-16 unit before JsString sees it.
macro_rules! violations {
    ($($variant:ident => $tag:literal { $($(#[$attribute:meta])* $field:ident: $type:ty,)* })*) => {
        #[derive(Clone, Debug, PartialEq, Serialize)]
        #[serde(tag = "kind", rename_all_fields = "camelCase")]
        pub enum BoundaryViolation {
            $(#[serde(rename = $tag)] $variant { $($(#[$attribute])* $field: $type,)* },)*
        }
        impl<'de> Deserialize<'de> for BoundaryViolation {
            fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                let raw = Box::<serde_json::value::RawValue>::deserialize(deserializer)?;
                #[derive(Deserialize)] struct Tag { kind: String }
                let tag: Tag = serde_json::from_str(raw.get()).map_err(D::Error::custom)?;
                match tag.kind.as_str() {
                    $($tag => {
                        #[derive(Deserialize)] #[serde(rename_all = "camelCase")]
                        struct Fields { $($(#[$attribute])* $field: $type,)* }
                        let Fields { $($field,)* } = serde_json::from_str(raw.get()).map_err(D::Error::custom)?;
                        Ok(Self::$variant { $($field,)* })
                    },)*
                    _ => Err(D::Error::custom("unknown boundary violation kind")),
                }
            }
        }
    };
}
violations! {
CrossFeature => "cross-feature" {
        from: JsString,
        to: JsString,
        specifier: JsString,
        type_only: bool,
        from_feature: JsString,
        to_feature: JsString,
    }
Impure => "impure" {
        from: JsString,
        to: (),
        specifier: JsString,
        type_only: bool,
    }
LibImportsFeature => "lib-imports-feature" {
        from: JsString,
        to: JsString,
        specifier: JsString,
        type_only: bool,
        to_feature: JsString,
    }
OutsideImportsFeatureInternal => "outside-imports-feature-internal" {
        from: JsString,
        to: JsString,
        specifier: JsString,
        type_only: bool,
        to_feature: JsString,
    }
ApplicationImportsAdapter => "application-imports-adapter" {
        from: JsString,
        to: JsString,
        specifier: JsString,
        type_only: bool,
        feature: JsString,
    }
DrivingReachesDriven => "driving-reaches-driven" {
        from: JsString,
        to: JsString,
        specifier: JsString,
        type_only: bool,
        feature: JsString,
        #[serde(skip_serializing_if = "Option::is_none")]
        write: Option<Arc<WriteSite>>,
    }
IndexNotExportsOnly => "index-not-exports-only" {
        from: JsString,
        to: (),
        specifier: JsString,
        type_only: False,
    }
ApplicationImportOutsideAllowlist => "application-import-outside-allowlist" {
        from: JsString,
        to: Option<JsString>,
        specifier: JsString,
        type_only: bool,
    }
UnknownZone => "unknown-zone" {
        from: JsString,
        to: (),
        specifier: JsString,
        type_only: False,
        feature: JsString,
    }
LibraryUndeclared => "library-undeclared" {
        from: JsString,
        to: (),
        specifier: JsString,
        type_only: False,
    }
LibraryImportsUp => "library-imports-up" {
        from: JsString,
        to: JsString,
        specifier: JsString,
        type_only: bool,
    }
AdapterLibraryImportedOutsideDriven => "adapter-library-imported-outside-driven" {
        from: JsString,
        to: JsString,
        specifier: JsString,
        type_only: bool,
    }
BindingOutsideDrivenAdapter => "binding-outside-driven-adapter" {
        from: JsString,
        to: (),
        specifier: JsString,
        type_only: False,
    }
WorkerCallCycle => "worker-call-cycle" {
        from: JsString,
        to: (),
        specifier: JsString,
        type_only: False,
    }
RelativeImportCrossesWorkspace => "relative-import-crosses-workspace" {
        from: JsString,
        to: JsString,
        specifier: JsString,
        type_only: bool,
    }
TestReachesCompositionRoot => "test-reaches-composition-root" {
        from: JsString,
        to: JsString,
        specifier: JsString,
        type_only: False,
    }
}

impl BoundaryViolation {
    pub fn kind(&self) -> BoundaryKind {
        match self {
            Self::CrossFeature { .. } => BoundaryKind::CrossFeature,
            Self::Impure { .. } => BoundaryKind::Impure,
            Self::LibImportsFeature { .. } => BoundaryKind::LibImportsFeature,
            Self::OutsideImportsFeatureInternal { .. } => {
                BoundaryKind::OutsideImportsFeatureInternal
            }
            Self::ApplicationImportsAdapter { .. } => BoundaryKind::ApplicationImportsAdapter,
            Self::DrivingReachesDriven { .. } => BoundaryKind::DrivingReachesDriven,
            Self::IndexNotExportsOnly { .. } => BoundaryKind::IndexNotExportsOnly,
            Self::ApplicationImportOutsideAllowlist { .. } => {
                BoundaryKind::ApplicationImportOutsideAllowlist
            }
            Self::UnknownZone { .. } => BoundaryKind::UnknownZone,
            Self::LibraryUndeclared { .. } => BoundaryKind::LibraryUndeclared,
            Self::LibraryImportsUp { .. } => BoundaryKind::LibraryImportsUp,
            Self::AdapterLibraryImportedOutsideDriven { .. } => {
                BoundaryKind::AdapterLibraryImportedOutsideDriven
            }
            Self::BindingOutsideDrivenAdapter { .. } => BoundaryKind::BindingOutsideDrivenAdapter,
            Self::WorkerCallCycle { .. } => BoundaryKind::WorkerCallCycle,
            Self::RelativeImportCrossesWorkspace { .. } => {
                BoundaryKind::RelativeImportCrossesWorkspace
            }
            Self::TestReachesCompositionRoot { .. } => BoundaryKind::TestReachesCompositionRoot,
        }
    }
    pub fn ledger_entry(&self, scope: impl Into<JsString>) -> BoundaryLedgerEntry {
        let (from, to, specifier) = match self {
            Self::CrossFeature {
                from,
                to,
                specifier,
                ..
            } => (from, Some(to.clone()), specifier),
            Self::Impure {
                from, specifier, ..
            } => (from, None, specifier),
            Self::LibImportsFeature {
                from,
                to,
                specifier,
                ..
            } => (from, Some(to.clone()), specifier),
            Self::OutsideImportsFeatureInternal {
                from,
                to,
                specifier,
                ..
            } => (from, Some(to.clone()), specifier),
            Self::ApplicationImportsAdapter {
                from,
                to,
                specifier,
                ..
            } => (from, Some(to.clone()), specifier),
            Self::DrivingReachesDriven {
                from,
                to,
                specifier,
                ..
            } => (from, Some(to.clone()), specifier),
            Self::IndexNotExportsOnly {
                from, specifier, ..
            } => (from, None, specifier),
            Self::ApplicationImportOutsideAllowlist {
                from,
                to,
                specifier,
                ..
            } => (from, to.clone(), specifier),
            Self::UnknownZone {
                from, specifier, ..
            } => (from, None, specifier),
            Self::LibraryUndeclared {
                from, specifier, ..
            } => (from, None, specifier),
            Self::LibraryImportsUp {
                from,
                to,
                specifier,
                ..
            } => (from, Some(to.clone()), specifier),
            Self::AdapterLibraryImportedOutsideDriven {
                from,
                to,
                specifier,
                ..
            } => (from, Some(to.clone()), specifier),
            Self::BindingOutsideDrivenAdapter {
                from, specifier, ..
            } => (from, None, specifier),
            Self::WorkerCallCycle {
                from, specifier, ..
            } => (from, None, specifier),
            Self::RelativeImportCrossesWorkspace {
                from,
                to,
                specifier,
                ..
            } => (from, Some(to.clone()), specifier),
            Self::TestReachesCompositionRoot {
                from,
                to,
                specifier,
                ..
            } => (from, Some(to.clone()), specifier),
        };
        BoundaryLedgerEntry {
            scope: scope.into(),
            kind: self.kind(),
            from: from.clone(),
            to,
            specifier: specifier.clone(),
            reason: None,
        }
    }
    pub fn write(&self) -> Option<&Arc<WriteSite>> {
        match self {
            Self::DrivingReachesDriven { write, .. } => write.as_ref(),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Crossing {
    Import,
    Impure,
    Entry,
}
pub fn crossing_of(kind: BoundaryKind) -> Crossing {
    match kind {
        BoundaryKind::CrossFeature => Crossing::Import,
        BoundaryKind::Impure => Crossing::Impure,
        BoundaryKind::LibImportsFeature => Crossing::Import,
        BoundaryKind::OutsideImportsFeatureInternal => Crossing::Import,
        BoundaryKind::ApplicationImportsAdapter => Crossing::Import,
        BoundaryKind::DrivingReachesDriven => Crossing::Import,
        BoundaryKind::IndexNotExportsOnly => Crossing::Entry,
        BoundaryKind::ApplicationImportOutsideAllowlist => Crossing::Import,
        BoundaryKind::UnknownZone => Crossing::Entry,
        BoundaryKind::LibraryUndeclared => Crossing::Entry,
        BoundaryKind::LibraryImportsUp => Crossing::Import,
        BoundaryKind::AdapterLibraryImportedOutsideDriven => Crossing::Import,
        BoundaryKind::BindingOutsideDrivenAdapter => Crossing::Impure,
        BoundaryKind::WorkerCallCycle => Crossing::Entry,
        BoundaryKind::RelativeImportCrossesWorkspace => Crossing::Import,
        BoundaryKind::TestReachesCompositionRoot => Crossing::Import,
    }
}
