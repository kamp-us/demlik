use demlik_tea::{
    PlainData,
    agent::{
        transcript::{Transcript, TranscriptOutcome, TranscriptSeed},
        types::{
            AgentEndedStatus, AgentEvent, AgentEventHead, AgentTurn, Awaiting, Conversation,
            ToolCall, ToolOutcome, ToolRecord, TurnUsage,
        },
    },
    data::{JsText, decode_json},
    work_queue::QueueField,
};
use std::{cell::Cell, rc::Rc};
struct Turn<'a>(&'a Cell<u8>);
struct ResultValue<'a>(&'a Cell<u8>);
struct Failure<'a>(&'a Cell<u8>);
fn head() -> AgentEventHead {
    AgentEventHead {
        run_id: "r".into(),
        at: 1.0,
    }
}
#[test]
fn borrowed_opaque_values_are_retained_without_clone_serde_send_or_static_bounds() {
    let changed = Cell::new(1);
    let turn = Rc::new(Turn(&changed));
    let result = Rc::new(ResultValue(&changed));
    let failure = Rc::new(Failure(&changed));
    let t = Transcript::<ResultValue<'_>, Turn<'_>, Failure<'_>>::new();
    let listener = t.listener::<PlainData, PlainData, PlainData>();
    listener(&AgentEvent::TurnSettled {
        head: head(),
        turn: Rc::clone(&turn),
        usage: QueueField::Absent,
    });
    listener(&AgentEvent::ToolSettled {
        head: head(),
        call_id: "c".into(),
        result: Rc::clone(&result),
    });
    let first = t.read();
    let second = t.read();
    assert!(Rc::ptr_eq(&first.turns[0], &turn));
    assert!(Rc::ptr_eq(&first.tools[0], &second.tools[0]));
    assert!(Rc::ptr_eq(&first.tools[0].result, &result));
    assert!(first.outcome.same_identity(&second.outcome));
    let status = Rc::new(AgentEndedStatus::Failed {
        failure: Rc::clone(&failure),
    });
    listener(&AgentEvent::RunDone {
        head: head(),
        status: Rc::clone(&status),
    });
    let done = t.read();
    assert!(Rc::ptr_eq(done.outcome.ended().unwrap(), &status));
    changed.set(2);
    assert_eq!(first.turns[0].0.get(), 2);
    assert_eq!(first.tools[0].result.0.get(), 2);
    let AgentEndedStatus::Failed { failure: retained } = done.outcome.ended().unwrap().as_ref()
    else {
        panic!("failed")
    };
    assert!(Rc::ptr_eq(retained, &failure));
    assert_eq!(retained.0.get(), 2);
    assert!(matches!(first.outcome, TranscriptOutcome::Running(_)));
}
#[test]
fn dense_seed_copies_outer_arrays_keeps_only_ok_results_and_does_not_deduplicate() {
    let turn = Rc::new(AgentTurn::new("seed".into(), vec![]));
    let result = Rc::new(PlainData::Null);
    let call = Rc::new(ToolCall {
        call_id: "2".into(),
        name: "tool".into(),
        args: Rc::new(PlainData::Null),
    });
    let ok = Rc::new(ToolRecord {
        call: Rc::clone(&call),
        outcome: ToolOutcome::Ok(Rc::clone(&result)),
        turn: 1.0,
    });
    let failed = Rc::new(ToolRecord {
        call: Rc::clone(&call),
        outcome: ToolOutcome::Error(Rc::new(PlainData::Null)),
        turn: 1.0,
    });
    let mut conversation = Conversation {
        turns: vec![Rc::clone(&turn)],
        tool_records: vec![failed, ok.clone(), ok],
        turn_count: 1.0,
        awaiting: Awaiting::Llm,
        context_tokens: QueueField::Value(None),
    };
    let t = Transcript::<PlainData>::from_seed(TranscriptSeed {
        conversation: Some(&conversation),
    });
    conversation.turns.clear();
    conversation.tool_records.clear();
    let mut first = t.read();
    let second = t.read();
    assert_eq!(first.turns.len(), 1);
    assert_eq!(first.tools.len(), 2);
    assert!(Rc::ptr_eq(&first.turns[0], &turn));
    assert!(Rc::ptr_eq(&first.tools[0].result, &result));
    assert!(!Rc::ptr_eq(&first.tools[0], &first.tools[1]));
    first.turns.clear();
    first.tools.clear();
    assert_eq!(second.turns.len(), 1);
    assert_eq!(t.read().tools.len(), 2);
}
#[test]
fn ignored_events_add_nothing_and_late_events_and_repeated_statuses_are_kept() {
    let t = Transcript::<PlainData>::new();
    let events: Vec<AgentEvent<PlainData>> = vec![
        AgentEvent::BrainStarted {
            head: head(),
            turn: 2.0,
            purpose: "p".into(),
            model: None,
            payload: Rc::new(PlainData::Null),
        },
        AgentEvent::ToolStarted {
            head: head(),
            call_id: "c".into(),
            name: "tool".into(),
            args: Rc::new(PlainData::Null),
        },
        AgentEvent::ToolFailed {
            head: head(),
            call_id: "c".into(),
            name: "tool".into(),
            failure: Rc::new(PlainData::Null),
        },
    ];
    for e in events {
        t.on_event(&e)
    }
    assert!(t.read().turns.is_empty());
    assert!(t.read().tools.is_empty());
    let status = Rc::new(AgentEndedStatus::Done {
        output: None,
        usage: Rc::new(TurnUsage::new(0.0, 0.0)),
    });
    let event: AgentEvent<PlainData> = AgentEvent::RunDone {
        head: head(),
        status: Rc::clone(&status),
    };
    t.on_event(&event);
    let first = t.read();
    t.on_event(&event);
    assert!(first.outcome.same_identity(&t.read().outcome));
    t.on_event(&AgentEvent::<PlainData>::TurnSettled {
        head: head(),
        turn: Rc::new(AgentTurn::new("late".into(), vec![])),
        usage: QueueField::Absent,
    });
    assert_eq!(t.read().turns.len(), 1);
    assert!(first.turns.is_empty());
    let cancel: AgentEvent<PlainData> = AgentEvent::RunDone {
        head: head(),
        status: Rc::new(AgentEndedStatus::Cancelled { at: 3.5 }),
    };
    t.on_event(&cancel);
    assert!(
        matches!(t.read().outcome.ended().unwrap().as_ref(),AgentEndedStatus::Cancelled{at} if *at==3.5)
    );
}
#[test]
fn wire_output_flattens_the_ended_arm_and_omits_only_undefined_object_values() {
    let t = Transcript::<PlainData, PlainData, PlainData>::new();
    t.on_event(
        &AgentEvent::<PlainData, PlainData, PlainData>::ToolSettled {
            head: head(),
            call_id: "u".into(),
            result: Rc::new(PlainData::Undefined),
        },
    );
    t.on_event(&AgentEvent::<PlainData, PlainData, PlainData>::RunDone {
        head: head(),
        status: Rc::new(AgentEndedStatus::Done {
            output: None,
            usage: Rc::new(TurnUsage::new(0.0, 0.0)),
        }),
    });
    assert_eq!(
        serde_json::to_string(&t.read()).unwrap(),
        r#"{"turns":[],"tools":[{"callId":"u"}],"outcome":{"kind":"done","output":null,"usage":{"inputTokens":0,"outputTokens":0}}}"#
    );
    let raw = decode_json(r#"{"conversation":{"turns":null,"toolRecords":null}}"#).unwrap();
    let empty = Transcript::from_plain_seed(&raw).unwrap();
    assert_eq!(
        serde_json::to_string(&empty.read()).unwrap(),
        r#"{"turns":[],"tools":[],"outcome":{"kind":"running"}}"#
    );
}
#[test]
fn malformed_raw_seed_refusals_keep_the_actual_source_class_message_and_input() {
    for (raw, message) in [
        (
            r#"{"conversation":{"turns":{"0":1,"length":1},"toolRecords":{}}}"#,
            "((intermediate value) ?? []) is not iterable",
        ),
        (
            r#"{"conversation":{"turns":[],"toolRecords":{"0":1,"length":1}}}"#,
            "((intermediate value) ?? []).flatMap is not a function",
        ),
    ] {
        let value = decode_json(raw).unwrap();
        let error = Transcript::from_plain_seed(&value).err().expect("refused");
        assert_eq!(error.name, "TypeError");
        assert_eq!(error.message, JsText::from(message));
        assert!(matches!(error.value.as_ref(), PlainData::Object(_)));
    }
}

#[test]
fn raw_string_turns_iterate_code_points_without_replacing_unpaired_units() {
    let raw = decode_json(r#"{"conversation":{"turns":"a😀\ud800","toolRecords":[]}}"#).unwrap();
    let t = Transcript::from_plain_seed(&raw).unwrap();
    let read = t.read();
    assert_eq!(read.turns.len(), 3);
    let units = read
        .turns
        .iter()
        .map(|value| match value.as_ref() {
            PlainData::String(value) => value.as_units().to_vec(),
            _ => panic!("string"),
        })
        .collect::<Vec<_>>();
    assert_eq!(units, [vec![97], vec![0xd83d, 0xde00], vec![0xd800]]);
}

#[test]
fn a_tool_result_keeps_a_live_media_view_through_snapshot_reads() {
    use demlik_tea::agent::content::{ContentPart, ImagePart, MediaBytes, MediaSource, Parts};
    use std::cell::RefCell;
    struct Screenshot {
        parts: Parts,
    }
    let bytes = MediaBytes::new(vec![1, 2, 3, 4]);
    let view = bytes.view(1..3).unwrap();
    let source = Rc::new(MediaSource::Bytes { data: view.clone() });
    let parts = Rc::new(RefCell::new(vec![ContentPart::Image(Rc::new(ImagePart {
        media_type: "image/png".into(),
        source: Rc::clone(&source),
    }))]));
    let result = Rc::new(Screenshot { parts });
    let t = Transcript::<Screenshot>::new();
    t.on_event(&AgentEvent::<Screenshot>::ToolSettled {
        head: head(),
        call_id: "shot".into(),
        result: Rc::clone(&result),
    });
    let read = t.read();
    bytes.set(1, 9).unwrap();
    assert!(Rc::ptr_eq(&read.tools[0].result, &result));
    let ContentPart::Image(image) = &read.tools[0].result.parts.borrow()[0] else {
        panic!("image")
    };
    assert!(Rc::ptr_eq(&image.source, &source));
    let MediaSource::Bytes { data } = &*image.source else {
        panic!("bytes")
    };
    assert!(data.same_view(&view));
    assert_eq!(data.to_vec(), [9, 3]);
}

#[test]
fn media_result_wire_uses_string_index_keys_through_the_canonical_data_encoder() {
    use demlik_tea::agent::content::MediaBytes;
    let t = Transcript::<MediaBytes>::new();
    t.on_event(&AgentEvent::<MediaBytes>::ToolSettled {
        head: head(),
        call_id: "b".into(),
        result: Rc::new(MediaBytes::new(vec![2, 3])),
    });
    assert_eq!(
        serde_json::to_string(&t.read()).unwrap(),
        r#"{"turns":[],"tools":[{"callId":"b","result":{"0":2,"1":3}}],"outcome":{"kind":"running"}}"#
    );
}

#[test]
fn a_bound_listener_keeps_its_collector_after_the_original_handle_is_dropped() {
    let original = Transcript::<PlainData>::new();
    let retained = original.clone();
    let listener = original.listener::<PlainData, PlainData, PlainData>();
    drop(original);
    listener(&AgentEvent::<PlainData>::TurnSettled {
        head: head(),
        turn: Rc::new(AgentTurn::new("bound".into(), vec![])),
        usage: QueueField::Absent,
    });
    assert_eq!(retained.read().turns[0].content, JsText::from("bound"));
}

#[test]
fn replacing_an_opaque_owned_cause_releases_the_state_borrow_before_drop_code_runs() {
    struct Notify<'a>(Box<dyn Fn() + 'a>);
    impl Drop for Notify<'_> {
        fn drop(&mut self) {
            (self.0)();
        }
    }
    let collector = Transcript::<PlainData, PlainData, Notify<'_>>::new();
    let bound = collector.clone();
    let status = Rc::new(AgentEndedStatus::Failed {
        failure: Rc::new(Notify(Box::new(move || {
            bound.on_event(
                &AgentEvent::<PlainData, PlainData, Notify<'_>>::TurnSettled {
                    head: head(),
                    turn: Rc::new(PlainData::String("drop".into())),
                    usage: QueueField::Absent,
                },
            )
        }))),
    });
    collector.on_event(&AgentEvent::<PlainData, PlainData, Notify<'_>>::RunDone {
        head: head(),
        status: Rc::clone(&status),
    });
    drop(status);
    collector.on_event(&AgentEvent::<PlainData, PlainData, Notify<'_>>::RunDone {
        head: head(),
        status: Rc::new(AgentEndedStatus::Cancelled { at: 2.0 }),
    });
    assert_eq!(collector.read().turns.len(), 1);
}

#[test]
fn the_canonical_turn_keeps_borrowed_tool_args_and_provider_values_without_serde_or_clone() {
    struct Borrowed<'a>(&'a Cell<u8>);
    let value = Cell::new(1);
    let args = Rc::new(Borrowed(&value));
    let provider = Rc::new(Borrowed(&value));
    let call = Rc::new(ToolCall {
        call_id: "c".into(),
        name: "tool".into(),
        args: Rc::clone(&args),
    });
    let mut turn = AgentTurn::new("typed".into(), vec![call]);
    turn.provider = QueueField::Value(Rc::clone(&provider));
    let turn = Rc::new(turn);
    let t = Transcript::<Borrowed<'_>, AgentTurn<Borrowed<'_>, Borrowed<'_>>, Borrowed<'_>>::new();
    t.on_event(&AgentEvent::<Borrowed<'_>,AgentTurn<Borrowed<'_>,Borrowed<'_>>,Borrowed<'_>>::TurnSettled{head:head(),turn:Rc::clone(&turn),usage:QueueField::Absent});
    let read = t.read();
    assert!(Rc::ptr_eq(&read.turns[0], &turn));
    assert!(Rc::ptr_eq(&read.turns[0].tool_calls[0].args, &args));
    assert!(Rc::ptr_eq(
        read.turns[0].provider.value().unwrap(),
        &provider
    ));
    value.set(7);
    assert_eq!(read.turns[0].tool_calls[0].args.0.get(), 7);
    assert_eq!(read.turns[0].provider.value().unwrap().0.get(), 7);
}
