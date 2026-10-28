use demlik_code_graph::project::{Collation, list_visible_files};
use std::path::Path;
fn main() {
    let borrowed;
    {
        let prepared = Collation::try_node22_en_us().unwrap();
        borrowed = &prepared;
    }
    let _ = list_visible_files(Path::new("."), |_| true, None, borrowed);
}
