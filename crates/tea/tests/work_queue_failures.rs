use demlik_tea::{
    storage::{MemoryStore, Migrated, RestoreCause, Store, memory_store},
    work_queue::*,
};
use std::{cell::Cell, fmt, rc::Rc};

#[derive(Debug)]
struct Fault {
    code: u32,
    bytes: Vec<u8>,
}
impl fmt::Display for Fault {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "queue I/O {}", self.code)
    }
}
impl std::error::Error for Fault {}
struct Failing {
    memory: MemoryStore<Queue<&'static str>>,
    fail_load: bool,
    fail_save: bool,
    panic_save: bool,
}
impl Store<Queue<&'static str>> for Failing {
    type Raw = Option<Queue<&'static str>>;
    type Error = Fault;
    async fn load(&self) -> Result<Self::Raw, Self::Error> {
        if self.fail_load {
            Err(Fault {
                code: 7,
                bytes: vec![0, 255],
            })
        } else {
            Ok(self.memory.load().await.unwrap())
        }
    }
    async fn save(&self, state: &Queue<&'static str>) -> Result<(), Self::Error> {
        if self.panic_save {
            std::panic::panic_any(vec![3_u8, 4]);
        }
        if self.fail_save {
            return Err(Fault {
                code: 9,
                bytes: vec![1, 254],
            });
        }
        self.memory.save(state).await.unwrap();
        Ok(())
    }
    fn migrate(&self, raw: Self::Raw) -> Migrated<Queue<&'static str>> {
        self.memory.migrate(raw)
    }
}
#[tokio::test(flavor = "current_thread")]
async fn unreadable_or_unsavable_queue_never_returns_a_false_success() {
    let calls = Cell::new(0);
    let source = || {
        calls.set(calls.get() + 1);
        0.0
    };
    let load = QueueClient::with_sources(
        Failing {
            memory: memory_store(None),
            fail_load: true,
            fail_save: false,
            panic_save: false,
        },
        source,
        || "id".into(),
    );
    let QueueError::Restore(error) = load.enqueue(Rc::new("a")).await.unwrap_err() else {
        panic!("restore failure")
    };
    assert_eq!(calls.get(), 0);
    let Some(RestoreCause::Load(cause)) = error.cause else {
        panic!("load cause")
    };
    assert_eq!((cause.code, cause.bytes), (7, vec![0, 255]));
    let memory = memory_store(None);
    let save = QueueClient::with_sources(
        Failing {
            memory: memory.clone(),
            fail_load: false,
            fail_save: true,
            panic_save: false,
        },
        source,
        || "id".into(),
    );
    let QueueError::Save(error) = save.enqueue(Rc::new("a")).await.unwrap_err() else {
        panic!("save failure")
    };
    assert_eq!((error.code, error.bytes), (9, vec![1, 254]));
    assert!(memory.load().await.unwrap().is_none());
    assert_eq!(calls.get(), 1);
}
#[tokio::test(flavor = "current_thread")]
async fn save_and_source_panics_retain_their_original_typed_payloads() {
    let store = Failing {
        memory: memory_store(None),
        fail_load: false,
        fail_save: false,
        panic_save: true,
    };
    let queue = QueueClient::with_sources(store, || 0.0, || "id".into());
    let QueueError::SavePanic(cause) = queue.enqueue(Rc::new("a")).await.unwrap_err() else {
        panic!("save panic")
    };
    cause.with_payload(|payload| assert_eq!(payload.downcast_ref::<Vec<u8>>().unwrap(), &[3, 4]));
    let queue =
        QueueClient::with_sources(memory_store(None), || 0.0, || std::panic::panic_any(17_u32));
    let QueueError::SourcePanic(cause) = queue.enqueue(Rc::new("a")).await.unwrap_err() else {
        panic!("source panic")
    };
    cause.with_payload(|payload| assert_eq!(payload.downcast_ref::<u32>(), Some(&17)));
    assert!(queue.store().load().await.unwrap().is_none());
}
