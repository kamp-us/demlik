use demlik_tea::{
    PlainData, Tagged,
    command::Outcome,
    data::{decode_json, plain_data, stringify_json},
    jev::{
        JevRequest, JevText, Question, Questions,
        protocol::{self, Answer},
        reply::{self, HttpReply, JevAskErr, JevRejected},
    },
};
use std::{cell::Cell, rc::Rc};
struct Invoice<'a> {
    business: &'a Cell<usize>,
    request: JevRequest,
}
fn main() {
    let business = Cell::new(0);
    let questions: Questions = [(
        "urgent".into(),
        Question::Noul {
            instructions: JevText::Text("Urgent?".into()),
            criteria: None,
        },
    )]
    .into_iter()
    .collect();
    let original = Rc::new(questions);
    let invoice = Invoice {
        business: &business,
        request: JevRequest {
            state: Rc::new(JevText::Text("invoice".into())),
            model: "requested".into(),
            questions: Rc::clone(&original),
        },
    };
    let parsed = {
        let body=decode_json(r#"{"model":"actual","usage":{"input_tokens":-2.5,"output_tokens":0},"answers":{"urgent":{"type":"noul","noul":1.25},"unasked":{}}}"#).unwrap();
        match protocol::parse_answers(&invoice.request.questions, &body) {
            Ok(v) => v,
            Err(_) => panic!("valid recorded response"),
        }
    };
    assert!(Rc::ptr_eq(&original, &invoice.request.questions));
    assert_eq!(invoice.business.get(), 0);
    assert_eq!(parsed.answers.len(), 1);
    assert!(matches!(parsed.answers.values().next(),Some(Answer::Noul{noul})if *noul==1.25));
    let restored_body = plain_data(&parsed).unwrap();
    let wire = stringify_json(&restored_body).unwrap();
    let decoded = decode_json(wire.as_str()).unwrap();
    let reparsed = match protocol::parse_answers(&original, &decoded) {
        Ok(v) => v,
        Err(_) => panic!("response roundtrip"),
    };
    assert_eq!(stringify_json(&plain_data(&reparsed).unwrap()), Some(wire));
    let cause = Rc::new(JevAskErr::HttpRetry {
        status: 429.0.into(),
    });
    let rejected = JevRejected::new(Rc::clone(&cause));
    assert!(Rc::ptr_eq(rejected.jev(), &cause));
    assert_eq!(rejected.tag(), "port_rejected");
    let raw = plain_data(&rejected).unwrap();
    let wire = stringify_json(&raw).unwrap();
    assert_eq!(
        wire.as_str(),
        r#"{"_tag":"port_rejected","jev":{"_tag":"http_retry","status":429}}"#
    );
    let value = decode_json(wire.as_str()).unwrap();
    assert_eq!(stringify_json(&value), Some(wire));
    assert!(
        matches!(reply::decode_reply(&invoice.request,HttpReply{status:429.0,body:&PlainData::Null}),Outcome::Err{error}if reply::is_transient_ask_err(error.jev()))
    );
    println!(
        "borrowed opaque invoice; original question/error Rc; owned parsed lifetime; canonical response/error wire: passed"
    );
}
