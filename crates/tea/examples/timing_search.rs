use demlik_tea::{
    Sub, Tagged,
    command::{CmdDef, CommandSpec, SchemaError},
    resilience::deadline::{DeadlineExceeded, subscribe_deadline},
    timing::{
        TokioTimer,
        throttled_input::{ThrottledInputConfig, create_throttled_input},
    },
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    rc::Rc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

#[derive(Serialize, Deserialize)]
struct SearchInput {
    query: String,
}
enum SearchError {}
impl Tagged for SearchError {
    fn tag(&self) -> &str {
        match *self {}
    }
}
struct Search;
impl CommandSpec for Search {
    type Input = SearchInput;
    type RawOutput = Value;
    type Output = Value;
    type Error = SearchError;
    const NAME: &'static str = "search";
    const ERROR_TAGS: &'static [&'static str] = &[];
    fn parse_input(value: Value) -> Result<SearchInput, SchemaError> {
        serde_json::from_value(value).map_err(Into::into)
    }
    fn parse_output(value: Value) -> Result<Value, SchemaError> {
        Ok(value)
    }
}
#[tokio::main(flavor = "current_thread")]
async fn main() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let search = create_throttled_input(
                ThrottledInputConfig::new(|query: &String| {
                    CmdDef::<Search>::new()
                        .build(SearchInput {
                            query: query.clone(),
                        })
                        .unwrap()
                })
                .debounce(5.0)
                .with_cache(1000.0, |query: &String| query.clone()),
            );
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_millis() as f64;
            let first = search.input(&search.init(), "fir".into(), now).unwrap();
            let last = search
                .input(&first.state, "final query".into(), now + 1.0)
                .unwrap();
            let sub = Sub::new(
                "deadline",
                search.subs(&last.state, Some("search:settle".into())),
            )
            .unwrap();
            let (send, mut receive) = tokio::sync::mpsc::unbounded_channel();
            let timer = Rc::new(TokioTimer::new(|error| eprintln!("timer failed: {error}")));
            let cleanup = subscribe_deadline(
                &sub,
                timer,
                Rc::new(move |msg: DeadlineExceeded| send.send(msg).unwrap()),
            )
            .unwrap();
            let settled = tokio::time::timeout(Duration::from_secs(1), receive.recv())
                .await
                .unwrap()
                .unwrap();
            cleanup.cancel().unwrap();
            let emitted = search.on_flush(&last.state, settled.at_ms).unwrap();
            println!("{}", serde_json::to_string(&emitted.commands).unwrap());
        })
        .await;
}
