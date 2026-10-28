use demlik_tea::{
    PlainData,
    data::{JsText, decode_json, plain_data, stringify_json},
    jev::{
        JevRequest, JevText, Question, Questions, ScoreCriteria,
        protocol::{self, JevErr, ParsedAnswers},
        reply::{self, HttpReply, JevAskErr},
    },
};
use indexmap::IndexMap;
use serde::Serialize;
use std::{
    io::{self, BufRead},
    rc::Rc,
};

fn object(fields: impl IntoIterator<Item = (&'static str, PlainData)>) -> PlainData {
    PlainData::Object(fields.into_iter().map(|(k, v)| (k.into(), v)).collect())
}
fn field<'a>(v: &'a PlainData, k: &str) -> &'a PlainData {
    if let PlainData::Object(m) = v {
        m.get(&JsText::from(k)).unwrap_or(&PlainData::Undefined)
    } else {
        &PlainData::Undefined
    }
}
fn array(v: &PlainData) -> &[PlainData] {
    if let PlainData::Array(a) = v {
        a
    } else {
        panic!("array fixture")
    }
}
fn map(v: &PlainData) -> &IndexMap<JsText, PlainData> {
    if let PlainData::Object(a) = v {
        a
    } else {
        panic!("object fixture")
    }
}
fn text(v: &PlainData) -> JsText {
    if let PlainData::String(s) = v {
        s.clone()
    } else {
        panic!("text fixture")
    }
}
fn number(v: &PlainData) -> f64 {
    if let PlainData::Number(n) = v {
        *n
    } else {
        panic!("number fixture")
    }
}
fn js(v: &impl Serialize) -> PlainData {
    plain_data(v).unwrap()
}
fn wire(v: &PlainData) -> String {
    stringify_json(v).unwrap()
}
fn lift(v: PlainData) -> PlainData {
    match v {
        PlainData::Object(mut m)
            if m.len() == 1 && m.contains_key(&JsText::from("$fixtureNumber")) =>
        {
            let n = match text(&m.swap_remove(&JsText::from("$fixtureNumber")).unwrap())
                .as_utf8()
                .unwrap()
            {
                "-0" => -0.0,
                "NaN" => f64::NAN,
                "Infinity" => f64::INFINITY,
                "-Infinity" => f64::NEG_INFINITY,
                _ => panic!("number fixture code"),
            };
            PlainData::Number(n)
        }
        PlainData::Object(m)
            if m.len() == 1 && m.contains_key(&JsText::from("$fixtureUndefined")) =>
        {
            PlainData::Undefined
        }
        PlainData::Object(m) => {
            PlainData::Object(m.into_iter().map(|(k, v)| (k, lift(v))).collect())
        }
        PlainData::Array(a) => PlainData::Array(a.into_iter().map(lift).collect()),
        v => v,
    }
}
fn jev_text(v: &PlainData) -> JevText {
    match v {
        PlainData::String(s) => JevText::Text(s.clone()),
        PlainData::Array(a) => JevText::Array(a.clone()),
        PlainData::Object(m) => JevText::Object(m.clone()),
        _ => panic!("JevText fixture"),
    }
}
fn questions(v: &PlainData) -> Questions {
    map(v)
        .iter()
        .map(|(id, q)| {
            let instructions = jev_text(field(q, "instructions"));
            let kind = text(field(q, "type"));
            let q = match kind.as_utf8().unwrap() {
                "choice" => Question::Choice {
                    instructions,
                    criteria: map(field(q, "criteria"))
                        .iter()
                        .map(|(k, v)| {
                            (
                                k.clone(),
                                if matches!(v, PlainData::Null) {
                                    None
                                } else {
                                    Some(jev_text(v))
                                },
                            )
                        })
                        .collect(),
                },
                "score" => {
                    let a = array(field(q, "criteria"));
                    Question::Score {
                        instructions,
                        criteria: ScoreCriteria::new(
                            jev_text(&a[0]),
                            jev_text(&a[1]),
                            a[2..].iter().map(jev_text).collect(),
                        ),
                    }
                }
                "noul" => Question::Noul {
                    instructions,
                    criteria: None,
                },
                _ => panic!("question fixture"),
            };
            (id.clone(), q)
        })
        .collect()
}
fn parsed_view(v: &Result<ParsedAnswers, JevErr>) -> PlainData {
    match v {
        Ok(p) => object([
            ("ok", PlainData::Bool(true)),
            ("answers", js(&p.answers)),
            ("model", js(&p.model)),
            ("usage", js(&p.usage)),
        ]),
        Err(e) => object([("ok", PlainData::Bool(false)), ("error", js(&e))]),
    }
}
fn special(v: &PlainData, path: &JsText, out: &mut Vec<PlainData>) {
    match v {
        PlainData::Number(n) if !n.is_finite() || (*n == 0.0 && n.is_sign_negative()) => {
            let kind = if n.is_nan() {
                "NaN"
            } else if *n == f64::INFINITY {
                "Infinity"
            } else if *n == f64::NEG_INFINITY {
                "-Infinity"
            } else {
                "-0"
            };
            out.push(PlainData::Array(vec![
                js(path),
                PlainData::String(kind.into()),
            ]));
        }
        PlainData::Array(a) => {
            for (i, v) in a.iter().enumerate() {
                let mut units = path.as_units().to_vec();
                units.extend(format!("/{i}").encode_utf16());
                special(v, &JsText::from_units(units), out);
            }
        }
        PlainData::Object(m) => {
            for (k, v) in m {
                let mut units = path.as_units().to_vec();
                units.push(47);
                units.extend_from_slice(k.as_units());
                special(v, &JsText::from_units(units), out);
            }
        }
        _ => (),
    }
}
fn reply_view(
    request: &JevRequest,
    status: f64,
    body: &PlainData,
    calls: &mut Vec<&'static str>,
) -> PlainData {
    calls.push("demlik_tea::jev::protocol::parse_answers");
    let parsed = parsed_view(&protocol::parse_answers(&request.questions, body));
    calls.push("demlik_tea::jev::reply::decode_reply");
    let outcome = js(&reply::decode_reply(request, HttpReply { status, body }));
    let mut numeric = vec![];
    special(
        &object([("parsed", parsed.clone()), ("outcome", outcome.clone())]),
        &"".into(),
        &mut numeric,
    );
    object([
        ("parsed", parsed),
        ("wire", js(&wire(&outcome))),
        ("outcome", outcome),
        ("numeric", PlainData::Array(numeric)),
    ])
}
fn view(input: &PlainData, calls: &mut Vec<&'static str>) -> PlainData {
    let request = JevRequest {
        state: Rc::new(JevText::Text("invoice-17".into())),
        model: "requested-model".into(),
        questions: Rc::new(questions(field(input, "questions"))),
    };
    let status = number(field(input, "status"));
    let body = field(input, "body");
    let op = text(field(input, "op"));
    match op.as_utf8().unwrap() {
        "statuses" => object([(
            "entries",
            PlainData::Array(
                array(field(input, "statuses"))
                    .iter()
                    .map(|s| {
                        let status = number(s);
                        calls.push("demlik_tea::jev::protocol::classify_status");
                        let kind = js(&protocol::classify_status(status));
                        let PlainData::Object(m) = reply_view(&request, status, body, calls) else {
                            unreachable!()
                        };
                        let mut entries = IndexMap::from([("kind".into(), kind)]);
                        entries.extend(m);
                        PlainData::Object(entries)
                    })
                    .collect(),
            ),
        )]),
        "bodies" => object([(
            "entries",
            PlainData::Array(
                array(field(input, "bodies"))
                    .iter()
                    .map(|body| reply_view(&request, status, body, calls))
                    .collect(),
            ),
        )]),
        "guards" => {
            let tags = [
                "malformed_body",
                "missing_answer",
                "answer_type_mismatch",
                "off_criteria_choice",
                "off_criteria_probabilities",
                "malformed_answer",
                "http_retry",
                "port_threw",
                "unknown",
            ];
            let guards = tags
                .iter()
                .map(|t| {
                    calls.push("demlik_tea::jev::protocol::is_jev_err");
                    PlainData::Bool(protocol::is_jev_err(&object([(
                        "_tag",
                        PlainData::String((*t).into()),
                    )])))
                })
                .collect();
            let errors = [
                JevAskErr::HttpRetry {
                    status: 429.0.into(),
                },
                JevAskErr::PortThrew {
                    reason: "socket".into(),
                },
                JevAskErr::HttpTerminal {
                    status: 401.0.into(),
                },
                JevAskErr::NoAnswerPath,
                JevAskErr::Protocol(JevErr::MalformedBody {
                    reason: "body".into(),
                }),
            ];
            let transient = errors
                .iter()
                .map(|e| {
                    calls.push("demlik_tea::jev::reply::is_transient_ask_err");
                    PlainData::Bool(reply::is_transient_ask_err(e))
                })
                .collect();
            calls.push("demlik_tea::jev::protocol::is_jev_err");
            object([
                ("guards", PlainData::Array(guards)),
                ("transient", PlainData::Array(transient)),
                (
                    "answerGuard",
                    PlainData::Bool(protocol::is_jev_err(&object([(
                        "_tag",
                        object([
                            ("type", PlainData::String("noul".into())),
                            ("noul", PlainData::Number(1.0)),
                        ]),
                    )]))),
                ),
            ])
        }
        "fresh" => {
            calls.push("demlik_tea::jev::protocol::parse_answers");
            let mut changed = body.clone();
            let parsed = protocol::parse_answers(&request.questions, &changed);
            let before = parsed_view(&parsed);
            let PlainData::Object(b) = &mut changed else {
                unreachable!()
            };
            let PlainData::Object(a) = b.get_mut(&JsText::from("answers")).unwrap() else {
                unreachable!()
            };
            let PlainData::Object(cat) = a.get_mut(&JsText::from("category")).unwrap() else {
                unreachable!()
            };
            cat.insert("choice".into(), PlainData::String("dining".into()));
            let PlainData::Object(prob) = cat.get_mut(&JsText::from("probabilities")).unwrap()
            else {
                unreachable!()
            };
            prob.insert("groceries".into(), PlainData::Number(0.0));
            a.insert(
                "extra".into(),
                object([
                    ("type", PlainData::String("noul".into())),
                    ("noul", PlainData::Number(0.0)),
                ]),
            );
            let PlainData::Object(u) = b.get_mut(&JsText::from("usage")).unwrap() else {
                unreachable!()
            };
            u.insert("input_tokens".into(), PlainData::Number(999.0));
            object([
                ("before", before.clone()),
                ("afterInputMutation", parsed_view(&parsed)),
                ("inputAfter", changed),
            ])
        }
        _ => reply_view(&request, status, body, calls),
    }
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    for line in io::stdin().lock().lines() {
        let input = lift(decode_json(&line?)?);
        let id = field(&input, "id").clone();
        let mut calls = vec![];
        let output = view(&input, &mut calls);
        let response = object([
            ("id", id),
            ("output", output),
            ("observedCalls", js(&calls)),
        ]);
        println!("{}", wire(&response));
    }
    Ok(())
}
