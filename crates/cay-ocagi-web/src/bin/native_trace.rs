use std::io::{self, Read};
fn main() {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input).unwrap();
    let messages = serde_json::from_str(&input).unwrap();
    println!("{}", cay_ocagi_web::replay(messages));
}
