use demlik_tea::{Step, Tagged, TryUpdate, Update, core::ApplyError};
use std::{cell::Cell, rc::Rc};

struct Wire<'a>(&'a str);
impl Tagged for Wire<'_> {
    fn tag(&self) -> &str {
        self.0
    }
}
struct Model<'a>(&'a Cell<usize>);
struct Cause<'a>(&'a Cell<usize>);

#[test]
fn owned_names_preserve_order_duplicates_and_authored_error_ownership() {
    let marker = Cell::new(0);
    let original_cause = Rc::new(Cause(&marker));
    let update = TryUpdate::try_reducer_with_types(
        vec!["z_ok".into(), "a_err".into(), "z_ok".into()],
        |model: &Model<'_>, message: &Wire<'_>| {
            model.0.set(model.0.get() + 1);
            if message.0 == "a_err" {
                Err(Rc::clone(&original_cause))
            } else {
                Ok(Step::new(Model(model.0), vec![model.0]))
            }
        },
    );
    let model = Model(&marker);
    assert_eq!(
        update.accepted_types(Some(&model)),
        ["z_ok", "a_err", "z_ok"]
    );
    assert!(update.accepted_types(None).is_empty());
    // Authored metadata is introspection, not a second dispatch/validation pass.
    let Ok(step) = update.try_apply(&model, &Wire("caller_decides")) else {
        panic!("authored cell skipped")
    };
    assert!(std::ptr::eq(step.state.0, &marker));
    assert!(std::ptr::eq(step.commands[0], &marker));
    let Err(ApplyError::Reduce(error)) = update.try_apply(&model, &Wire("a_err")) else {
        panic!("failure yielded a Step")
    };
    assert!(Rc::ptr_eq(&error, &original_cause));
    assert!(std::ptr::eq(error.0, &marker));
    assert_eq!(marker.get(), 2);
}

demlik_tea::messages! { enum Fixed { Keep, Fail } }
#[test]
fn existing_static_variants_and_constructors_keep_their_public_types() {
    let fixed: Update<'_, usize, Fixed, ()> = Update::Exhaustive {
        cell: Box::new(|n, _| Step::new(*n + 1, vec![])),
        accepted_types: &["Keep", "Fail"],
    };
    assert_eq!(fixed.accepted_types(Some(&0)), ["Keep", "Fail"]);
    assert_eq!(fixed.apply(&0, &Fixed::Keep).unwrap().state, 1);
    let old: TryUpdate<'_, usize, Fixed, (), &'static str> = TryUpdate::Fallible {
        cell: Box::new(|n, m| match m {
            Fixed::Keep => Ok(Step::new(*n, vec![])),
            Fixed::Fail => Err("same cause"),
        }),
        accepted_types: &["Keep", "Fail"],
    };
    let Err(ApplyError::Reduce(error)) = old.try_apply(&0, &Fixed::Fail) else {
        panic!("static cause changed")
    };
    assert_eq!(error, "same cause");
    let constructed: TryUpdate<'_, usize, Fixed, (), ()> =
        TryUpdate::try_reducer(|n, _| Ok(Step::new(*n, vec![])));
    assert_eq!(constructed.accepted_types(Some(&0)), ["Keep", "Fail"]);
    let inferred = Update::reducer(|n: &usize, _: &Fixed| Step::<_, ()>::new(*n, vec![]));
    assert_eq!(inferred.accepted_types(Some(&0)), ["Keep", "Fail"]);
}

struct Ready;
impl Tagged for Ready {
    fn tag(&self) -> &str {
        "ready"
    }
}
#[test]
fn empty_router_update_uses_canonical_rejection_names_and_keeps_no_cell_data() {
    let router = demlik_tea::agent::tool::EmptyRouter::new().unwrap();
    let update = router.update(|_: &Ready, _| Step::new(Ready, vec![]));
    let expected = vec![
        "tool_rejected_ok".to_owned(),
        "tool_rejected_err".to_owned(),
    ];
    assert_eq!(router.settlement_types(), expected);
    assert_eq!(update.accepted_types(Some(&Ready)), expected);
    assert!(update.accepted_types(None).is_empty());
    let row = demlik_tea::core::Row::<Ready, Wire<'_>, ()>::default();
    let empty = Update::raw_reducer(row);
    let Err(error) = empty.apply(&Ready, &Wire("unknown")) else {
        panic!("empty raw table ran a cell")
    };
    assert_eq!(error.msg_type, "unknown");
    assert_eq!(error.state_name, "ready");
    assert!(error.accepted_types.is_empty());
}
