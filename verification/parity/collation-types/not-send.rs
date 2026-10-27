use demlik_code_graph::project::Collation;
fn main() {
 let owner = Collation::try_node22_en_us().unwrap();
 std::thread::spawn(move || drop(owner));
}
