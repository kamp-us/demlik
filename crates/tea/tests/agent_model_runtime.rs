#[path = "../examples/agent_model/runtime.rs"]
mod model_runtime;
#[path = "../examples/agent_model/scenario.rs"]
// The standalone scenario and runtime share these opaque fixture definitions.
#[allow(dead_code)]
mod scenario;
use demlik_tea::{PlainData, runtime::Profile};
use std::{cell::RefCell, rc::Rc};
fn field<'a>(value: &'a PlainData, key: &str) -> &'a PlainData {
    let PlainData::Object(fields) = value else {
        panic!("record")
    };
    fields.get(key).unwrap()
}
#[tokio::test(flavor = "current_thread")]
async fn model_outcomes_reach_the_actual_engine_and_settle_both_profiles_without_opaque_serialization()
 {
    tokio::task::LocalSet::new().run_until(async{
  for profile in [Profile::Promise,Profile::Effect]{for style in ["plain","wrapped","factory"]{for failure in [false,true]{
   let text=format!(r#"{{"style":"{style}","transform":true{}}}"#,if failure{",\"failure\":\"invoke\""}else{""});
   let script=serde_json::from_str(&text).unwrap();let calls=Rc::new(RefCell::new(vec![]));let out=model_runtime::run(script,profile,&calls).await;
   assert!(matches!(field(&out,"done"),PlainData::Bool(true)));assert!(matches!(field(&out,"contextSame"),PlainData::Bool(true)));assert!(matches!(field(&out,"errors"),PlainData::Array(errors) if errors.is_empty()));
   let settled=field(&out,"settled");assert!(matches!(field(settled,"at"),PlainData::Number(value) if *value==100.25));
   if failure {assert!(matches!(field(settled,"sameCause"),PlainData::Bool(true)));}else{assert!(matches!(field(field(settled,"output"),"value"),PlainData::Number(value) if *value==if style=="factory"{1.0}else{2.0}));}
   assert!(calls.borrow().contains(&"demlik_tea::agent::model::BrainHandler::handle"));
  }}}
 }).await;
}
