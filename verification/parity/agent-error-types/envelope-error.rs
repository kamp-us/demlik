use demlik_tea::agent::StructuredOutputError;
fn error<T: std::error::Error>() {}
fn main() { error::<StructuredOutputError>(); }
