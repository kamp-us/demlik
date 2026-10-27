// Shared bounded Number operations used by reports and comment ceilings.
pub(crate) fn js_round(value: f64) -> f64 {
    if !value.is_finite() || value == 0.0 {
        return value;
    }
    let lower = value.floor();
    let rounded = if value - lower < 0.5 {
        lower
    } else {
        lower + 1.0
    };
    if rounded == 0.0 {
        0.0f64.copysign(value)
    } else {
        rounded
    }
}

#[cfg(test)]
mod tests {
    use super::js_round;
    #[test]
    fn ties_and_special_values_match_number_rounding() {
        for (input, expected) in [
            (-1.5, -1.0),
            (-0.5, -0.0),
            (-0.1, -0.0),
            (-0.0, -0.0),
            (0.0, 0.0),
            (0.5, 1.0),
            (1.5, 2.0),
            (f64::INFINITY, f64::INFINITY),
            (f64::NEG_INFINITY, f64::NEG_INFINITY),
            (4503599627370495.5, 4503599627370496.0),
        ] {
            assert_eq!(js_round(input).to_bits(), expected.to_bits());
        }
        assert!(js_round(f64::NAN).is_nan());
    }
}
