//! Actual public generic Actor runtime consumer, compiled to Wasm for Node.
use demlik_tea::command::{CommandContractError, CommandFamily};
use demlik_tea::runtime::{
    NoInterpreter, NoSubscriptions, Options, Profile, RuntimeTimer, try_launch,
};
use demlik_tea::{Machine, Step, Sub, Tagged, Update, messages};
use std::{convert::Infallible, rc::Rc};
use wasm_bindgen::prelude::*;
mod fixture;
mod node_timer;
struct Model(u32);
impl Tagged for Model {
    fn tag(&self) -> &str {
        "state"
    }
}
messages! {enum Msg { Inc }}
enum Cmd {}
impl Tagged for Cmd {
    fn tag(&self) -> &str {
        match *self {}
    }
}
impl CommandFamily for Cmd {
    type Msg = Msg;
    type Completion = Vec<Msg>;
    fn settle(self, _: Vec<Msg>, _: f64) -> Result<Vec<Msg>, CommandContractError> {
        match self {}
    }
}
fn options() -> Options<Model, Msg, Infallible, Infallible> {
    let mut options = Options::new(Profile::Promise);
    options.timer = Some(RuntimeTimer::new(Rc::new(node_timer::NodeTimer::default())));
    options
}
#[wasm_bindgen]
pub fn default_clock_probe() -> f64 {
    (options().clock)()
}
#[wasm_bindgen]
pub async fn smoke() -> Result<String, JsValue> {
    let machine: Machine<'static, Model, Msg, Cmd, Sub, ()> = Machine {
        init: Box::new(|loaded, _: &()| Step::new(loaded.unwrap_or(Model(0)), vec![])),
        update: Update::reducer(|state: &Model, _: &Msg| Step::new(Model(state.0 + 1), vec![])),
        subscriptions: demlik_tea::core::subscriptions(|_| Vec::<Sub>::new()),
    };
    let mut config = options();
    config.clock = Rc::new(js_sys::Date::now);
    let runtime = try_launch(
        machine,
        (),
        NoInterpreter::new(),
        NoSubscriptions::new(),
        config,
    );
    runtime
        .ready()
        .await
        .map_err(|error| JsValue::from_str(error.name()))?;
    runtime
        .dispatch(Msg::Inc)
        .await
        .map_err(|error| JsValue::from_str(error.name()))?;
    let count = runtime.get_state().expect("ready actor has state").0;
    runtime.stop().await;
    Ok(format!("{{\"count\":{count}}}"))
}

#[wasm_bindgen]
pub async fn fixture() -> Result<String, JsValue> {
    Ok(fixture::run().await?.to_string())
}

#[wasm_bindgen]
pub async fn host_seams() -> Result<String, JsValue> {
    Ok(fixture::host_seams().await?.to_string())
}
