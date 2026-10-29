use demlik_tea::{Machine, Step, Sub, Tagged, Update};
use serde_json::{Value, json};
use std::rc::Rc;

#[derive(Clone)]
pub struct Model<'a> {
    pub pending: Vec<f64>,
    pub done: Vec<f64>,
    pub owner: &'a Rc<()>,
}
pub fn view(m: &Model<'_>) -> Value {
    json!({"pending":m.pending,"done":m.done})
}
pub struct Fire;
impl Tagged for Fire {
    fn tag(&self) -> &str {
        "fire"
    }
}
impl demlik_tea::core::Message for Fire {
    const TYPES: &'static [&'static str] = &["fire"];
}
pub fn machine<'a>() -> Machine<'a, Model<'a>, Fire, (), Sub> {
    Machine {
        init: Box::new(|loaded, _| Step::new(loaded.unwrap(), vec![])),
        update: Update::reducer(|s: &Model<'a>, _: &Fire| {
            let mut done = s.done.clone();
            if let Some(at) = s.pending.first() {
                done.push(*at)
            }
            Step::new(
                Model {
                    pending: s.pending.iter().skip(1).copied().collect(),
                    done,
                    owner: s.owner,
                },
                vec![],
            )
        }),
        subscriptions: demlik_tea::core::subscriptions(|_| vec![]),
    }
}
