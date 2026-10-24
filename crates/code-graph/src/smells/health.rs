use crate::schema::Health;

pub struct HealthInput {
    pub smell_count: usize,
    pub high_severity_count: usize,
    pub file_count: usize,
}
pub fn health_band(input: HealthInput) -> Health {
    let density = input.smell_count as f64 / input.file_count.max(1) as f64;
    if input.high_severity_count > 5 || density >= 1.0 {
        Health::Rotten
    } else if input.high_severity_count == 0 && density < 0.3 {
        Health::Healthy
    } else {
        Health::Rough
    }
}
