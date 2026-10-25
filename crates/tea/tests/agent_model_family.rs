#[path = "../examples/agent_model/family.rs"]
mod family;
#[test]
fn builtin_schema_and_distinct_borrowed_host_failures_keep_typed_original_causes_at_every_port() {
    family::prove();
}
