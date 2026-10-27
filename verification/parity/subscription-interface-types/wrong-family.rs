use demlik_tea::core::{Subscriptions, try_subscriptions};
fn main() {
    let _: Subscriptions<'_, (), (), u8> = try_subscriptions(|_: &()| Err("wrong family"));
}
