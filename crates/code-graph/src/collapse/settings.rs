use crate::{
    text::{JsObject, JsString, JsValue, object_keys},
    validation::{InputIssue, NumberCheck, PathSegment, checked_number},
};
use serde::{Serialize, Serializer};

macro_rules! settings {
    ($( $field:ident, $key:literal, $default:expr, $check:expr; )*) => {
        #[derive(Debug)]
        pub struct CollapseSettings {
            $(pub $field: f64,)*
        }
        impl Default for CollapseSettings {
            fn default() -> Self {
                Self { $($field: $default,)* }
            }
        }
        impl CollapseSettings {
            pub fn as_value(&self) -> JsValue {
                JsValue::Object(JsObject::from([$(($key.into(), JsValue::Number(self.$field)),)*]))
            }
            /// The Source config entrypoint observes the first schema issue.
            pub fn parse(value: &JsValue) -> Result<Self, InputIssue> {
                let object = value.as_object().ok_or_else(|| {
                    InputIssue::invalid_type(Vec::new(), "object", Some(value))
                })?;
                let defaults = Self::default();
                let result = Self {
                    $($field: match object.get(&JsString::from($key)) {
                        Some(value) => checked_number(
                            value,
                            vec![PathSegment::Field($key.into())],
                            $check,
                        )?,
                        None => defaults.$field,
                    },)*
                };
                let keys = object_keys(object)
                    .into_iter()
                    .filter(|key| ![$($key,)*].iter().any(|expected| **key == *expected))
                    .collect::<Vec<_>>();
                if !keys.is_empty() {
                    return Err(InputIssue::unrecognized_keys(Vec::new(), &keys));
                }
                Ok(result)
            }
        }
    };
}
settings! {
    min_signals, "minSignals", 2.0, NumberCheck::Integer { minimum: 2.0, maximum: Some(4.0) };
    min_loc, "minLoc", 5.0, NumberCheck::Integer { minimum: 0.0, maximum: None };
    min_complexity, "minComplexity", 2.0, NumberCheck::Integer { minimum: 0.0, maximum: None };
    shape_loc_slack, "shapeLocSlack", 3.0, NumberCheck::Integer { minimum: 0.0, maximum: None };
    shape_loc_ratio, "shapeLocRatio", 0.2, NumberCheck::Number { minimum: 0.0, maximum: None };
    shape_complexity_slack, "shapeComplexitySlack", 1.0, NumberCheck::Integer { minimum: 0.0, maximum: None };
    shape_nesting_slack, "shapeNestingSlack", 1.0, NumberCheck::Integer { minimum: 0.0, maximum: None };
    min_set_size, "minSetSize", 2.0, NumberCheck::Integer { minimum: 0.0, maximum: None };
    callee_jaccard, "calleeJaccard", 0.5, NumberCheck::Number { minimum: 0.0, maximum: Some(1.0) };
    caller_jaccard, "callerJaccard", 0.5, NumberCheck::Number { minimum: 0.0, maximum: Some(1.0) };
    name_overlap, "nameOverlap", 0.5, NumberCheck::Number { minimum: 0.0, maximum: Some(1.0) };
    name_min_token_length, "nameMinTokenLength", 4.0, NumberCheck::Integer { minimum: 0.0, maximum: None };
    cost_caller_weight, "costCallerWeight", 1.0, NumberCheck::Number { minimum: 0.0, maximum: None };
    cost_package_weight, "costPackageWeight", 1.0, NumberCheck::Number { minimum: 0.0, maximum: None };
    cost_cross_package_weight, "costCrossPackageWeight", 2.0, NumberCheck::Number { minimum: 0.0, maximum: None };
    cost_effect_weight, "costEffectWeight", 1.0, NumberCheck::Number { minimum: 0.0, maximum: None };
    max_block_size, "maxBlockSize", 120.0, NumberCheck::Integer { minimum: 0.0, maximum: None };
    partial_min_prefix, "partialMinPrefix", 3.0, NumberCheck::Integer { minimum: 2.0, maximum: None };
    partial_min_shared_constants, "partialMinSharedConstants", 1.0, NumberCheck::Integer { minimum: 1.0, maximum: None };
    partial_max_block_size, "partialMaxBlockSize", 40.0, NumberCheck::Integer { minimum: 0.0, maximum: None };
}
impl Serialize for CollapseSettings {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.as_value().serialize(serializer)
    }
}
