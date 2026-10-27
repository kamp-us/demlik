use demlik_code_graph::project::Collation;
fn needs_sync<T: Sync>(_: &T) {}
fn main() {
 let owner = Collation::try_node22_en_us().unwrap();
 needs_sync(&owner);
}
