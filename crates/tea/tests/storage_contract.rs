use std::future::{Future, ready};

use demlik_tea::storage::{Migrated, RestoreCause, Store, restore};

struct EarlyFailure {
    fail: bool,
}
impl Store<()> for EarlyFailure {
    type Raw = ();
    type Error = &'static str;
    fn load(&self) -> impl Future<Output = Result<(), Self::Error>> {
        if self.fail {
            panic!("load construction failed");
        }
        ready(Ok(()))
    }
    async fn save(&self, _: &()) -> Result<(), Self::Error> {
        Ok(())
    }
    fn migrate(&self, _: ()) -> Migrated<()> {
        Migrated::Fresh
    }
}

#[tokio::test]
async fn restore_contains_a_load_failure_before_the_future_is_created() {
    let failure = restore(&EarlyFailure { fail: true }).await.unwrap_err();
    assert_eq!(
        failure.reason,
        "the saved state could not be read (load construction failed)"
    );
    let Some(RestoreCause::Panic(cause)) = failure.cause else {
        panic!("the original panic must remain available")
    };
    assert!(cause.with_payload(|payload| payload.downcast_ref::<&str>().is_some()));
}

#[tokio::test]
async fn a_store_can_restore_a_borrowed_local_model_without_clone_or_serialization() {
    use std::cell::Cell;
    struct Model<'a>(&'a Cell<u8>);
    struct Local<'a>(&'a Cell<u8>);
    impl<'a> Store<Model<'a>> for Local<'a> {
        type Raw = &'a Cell<u8>;
        type Error = &'static str;
        async fn load(&self) -> Result<Self::Raw, Self::Error> {
            Ok(self.0)
        }
        async fn save(&self, state: &Model<'a>) -> Result<(), Self::Error> {
            self.0.set(state.0.get() + 1);
            Ok(())
        }
        fn migrate(&self, raw: Self::Raw) -> Migrated<Model<'a>> {
            Migrated::State(Model(raw))
        }
    }
    let local = Cell::new(3);
    let store = Local(&local);
    let model = restore(&store).await.unwrap().unwrap();
    store.save(&model).await.unwrap();
    assert_eq!(local.get(), 4);
}
