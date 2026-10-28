use demlik_tea::{
    Machine, Step, Sub, TryUpdate,
    core::{ProjectionError, SubEntry, SubscriptionEntries},
    data::JsText,
    machine_viz::{self, MachineVizOptions, Samples},
};
use indexmap::IndexMap;
use std::{cell::Cell, rc::Rc};

struct Opaque<'a>(&'a Cell<usize>);
struct Message<'a>(&'a Cell<usize>);
struct Cause<'a>(&'a Cell<usize>);

fn main() {
    let counter = Cell::new(0);
    let state = Opaque(&counter);
    let message = Message(&counter);
    let cause = Rc::new(Cause(&counter));
    let error = Rc::clone(&cause);
    let machine: Machine<'_, Opaque<'_>, Message<'_>, (), Sub<bool>, (), Rc<Cause<'_>>> = Machine {
        init: Box::new(|_, _| panic!("reducer visualization must not call init")),
        update: TryUpdate::try_reducer_with_types(
            vec!["10".into(), "2".into(), "10".into(), "reset".into()],
            |_, _| panic!("reducer visualization must not call the reducer"),
        ),
        subscriptions: Box::new(SubscriptionEntries::new(vec![SubEntry::try_new(
            "watch",
            move |s: &Opaque<'_>| {
                s.0.set(s.0.get() + 1);
                Err::<Option<bool>, _>(Rc::clone(&error))
            },
        )])),
    };
    let empty = machine_viz::to_mermaid(&machine, MachineVizOptions::default());
    let text = match empty {
        Ok(text) => text,
        Err(_) => panic!("no dependencies may be read without samples"),
    };
    let text = text.as_utf8().unwrap();
    assert!(text.find("s_2 : 2").unwrap() < text.find("s_10 : 10").unwrap());
    assert_eq!(text.matches("s_10 : 10").count(), 1);
    assert!(text.contains("Handled msg types: 3"));
    assert_eq!(counter.get(), 0);
    let options = MachineVizOptions {
        samples: Samples {
            states: IndexMap::from([("opaque".into(), &state)]),
            messages: IndexMap::from([("message".into(), &message)]),
            context: None,
        },
        ..MachineVizOptions::default()
    };
    match machine_viz::to_mermaid(&machine, options) {
        Err(ProjectionError::Declared(original)) => assert!(Rc::ptr_eq(&original, &cause)),
        _ => panic!("must retain original borrowed error"),
    }
    assert_eq!(counter.get(), 1);
    assert!(std::ptr::eq(message.0, cause.0));
    assert_eq!(machine_viz::safe_id("😀"), "__");
    assert_eq!(
        machine_viz::safe_label(JsText::from_units(vec![0xfeff, 0xd800, 0x003a, 0xfeff]))
            .as_units(),
        &[0xd800]
    );

    // No Tagged, Clone, Debug, Serialize, Send or 'static bound on the model/message/error.
    let no_entries: Machine<'_, Opaque<'_>, Message<'_>, (), Sub<bool>> = Machine {
        init: Box::new(|_, _| Step::new(Opaque(&counter), vec![])),
        update: TryUpdate::try_reducer_with_types(vec![], |_, _| {
            panic!("empty reducer must not execute")
        }),
        subscriptions: Box::new(SubscriptionEntries::<_, bool>::new(vec![])),
    };
    let text = machine_viz::to_mermaid(
        &no_entries,
        MachineVizOptions {
            samples: Samples {
                states: IndexMap::from([("opaque".into(), &state)]),
                ..Samples::default()
            },
            ..MachineVizOptions::default()
        },
    )
    .unwrap();
    assert!(!text.as_utf8().unwrap().contains("note left"));
    println!(
        "opaque borrowed reducer, original dependency cause, declaration ownership and UTF16: passed"
    );
}
