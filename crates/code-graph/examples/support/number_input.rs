use serde::Deserialize;

#[derive(Deserialize)]
#[serde(untagged)]
pub enum JsNumberInput {
    Finite(f64),
    Special(SpecialNumber),
}
#[derive(Deserialize)]
pub enum SpecialNumber {
    #[serde(rename = "NaN")]
    Nan,
    #[serde(rename = "Infinity")]
    Infinity,
    #[serde(rename = "-Infinity")]
    NegativeInfinity,
    #[serde(rename = "-0")]
    NegativeZero,
}
impl JsNumberInput {
    pub fn value(self) -> f64 {
        match self {
            Self::Finite(value) => value,
            Self::Special(SpecialNumber::Nan) => f64::NAN,
            Self::Special(SpecialNumber::Infinity) => f64::INFINITY,
            Self::Special(SpecialNumber::NegativeInfinity) => f64::NEG_INFINITY,
            Self::Special(SpecialNumber::NegativeZero) => -0.0,
        }
    }
}
