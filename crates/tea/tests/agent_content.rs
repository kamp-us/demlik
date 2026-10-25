use demlik_tea::{
    agent::content::{
        ContentPart, FilePart, ImagePart, MediaBytes, MediaSource, MessageContent, Parts, TextPart,
        content_parts, omit_media,
    },
    data::JsText,
};
use std::{cell::RefCell, rc::Rc};
fn text(value: &str) -> ContentPart {
    ContentPart::Text(Rc::new(TextPart { text: value.into() }))
}
#[test]
fn string_parts_are_fresh_but_a_parts_message_is_the_original_mutable_array() {
    let message = MessageContent::Text("hello".into());
    let first = content_parts(&message);
    let second = content_parts(&message);
    assert!(!Rc::ptr_eq(&first, &second));
    assert!(!first.borrow()[0].same_identity(&second.borrow()[0]));
    let parts: Parts = Rc::new(RefCell::new(vec![text("one")]));
    let out = content_parts(&MessageContent::Parts(Rc::clone(&parts)));
    assert!(Rc::ptr_eq(&parts, &out));
    parts.borrow_mut().push(text("two"));
    assert_eq!(out.borrow().len(), 2);
}
#[test]
fn omission_retains_the_text_and_allocates_each_media_placeholder() {
    let kept = text("kept");
    let raw = MediaSource::Base64 {
        data: JsText::from_units(vec![0xd800]),
    };
    let image = ContentPart::Image(Rc::new(ImagePart {
        media_type: "image/png".into(),
        source: Rc::new(raw),
    }));
    let file = ContentPart::File(Rc::new(FilePart {
        media_type: "application/pdf".into(),
        source: Rc::new(MediaSource::Url {
            url: "https://example.test/a".into(),
        }),
    }));
    let parts = Rc::new(RefCell::new(vec![kept.clone(), image.clone(), image, file]));
    let first = omit_media(&parts);
    let second = omit_media(&parts);
    assert!(!Rc::ptr_eq(&first, &parts));
    assert!(!Rc::ptr_eq(&first, &second));
    let out = first.borrow();
    assert!(out[0].same_identity(&kept));
    assert!(!out[1].same_identity(&out[2]));
    assert!(!out[1].same_identity(&second.borrow()[1]));
    let values = out
        .iter()
        .map(|part| match part {
            ContentPart::Text(value) => value.text.as_utf8().unwrap(),
            _ => panic!("media was not omitted"),
        })
        .collect::<Vec<_>>();
    assert_eq!(
        values,
        [
            "kept",
            "[image omitted]",
            "[image omitted]",
            "[file omitted]"
        ]
    );
}
#[test]
fn byte_subviews_share_real_storage_while_an_explicit_copy_is_independent() {
    let backing = MediaBytes::new(vec![10, 20, 30, 40]);
    let view = backing.view(1..3).unwrap();
    let copy = view.copied();
    assert!(!view.same_view(&backing));
    assert!(view.shares_buffer(&backing));
    assert_eq!(view.offset(), 1);
    assert_eq!(view.len(), 2);
    let source = Rc::new(MediaSource::Bytes { data: view.clone() });
    let image = ContentPart::Image(Rc::new(ImagePart {
        media_type: "image/png".into(),
        source: Rc::clone(&source),
    }));
    let parts = Rc::new(RefCell::new(vec![image]));
    let retained = content_parts(&MessageContent::Parts(parts));
    backing.set(1, 21).unwrap();
    view.set(1, 32).unwrap();
    copy.set(0, 99).unwrap();
    assert_eq!(backing.to_vec(), [10, 21, 32, 40]);
    assert_eq!(view.to_vec(), [21, 32]);
    assert_eq!(copy.to_vec(), [99, 30]);
    let ContentPart::Image(image) = &retained.borrow()[0] else {
        panic!("image")
    };
    assert!(Rc::ptr_eq(&image.source, &source));
    let MediaSource::Bytes { data } = &*image.source else {
        panic!("bytes")
    };
    assert!(data.same_view(&view));
    assert!(backing.view(2..5).is_err());
    assert!(view.set(2, 0).is_err());
}
