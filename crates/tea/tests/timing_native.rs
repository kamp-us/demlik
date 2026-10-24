#![cfg(not(target_arch = "wasm32"))]
use demlik_tea::{
    Sub,
    resilience::deadline::*,
    timing::{Edges, Timer, TokioTimer, debounce},
};
use std::{cell::RefCell, rc::Rc, time::Duration};

#[tokio::test(flavor = "current_thread")]
async fn native_timers_fire_asynchronously_and_cancelled_work_never_dispatches() {
    tokio::task::LocalSet::new()
        .run_until(async {
            assert_eq!(TokioTimer::new(|_| {}).now_ms().fract(), 0.0);
            assert_eq!(TokioTimer::with_clock(|| 17.25, |_| {}).now_ms(), 17.25);
            let errors = Rc::new(RefCell::new(Vec::new()));
            let timer = Rc::new(TokioTimer::with_clock(|| 1000.0, {
                let errors = errors.clone();
                move |error| errors.borrow_mut().push(error)
            }));
            let (send, mut receive) = tokio::sync::mpsc::unbounded_channel();
            let d = debounce(
                {
                    let send = send.clone();
                    move |value| send.send(value).unwrap()
                },
                5.0,
                Edges::default(),
                timer.clone(),
            );
            d.invoke("cancelled").unwrap();
            d.cancel();
            d.invoke("delivered").unwrap();
            assert!(receive.try_recv().is_err());
            assert_eq!(
                tokio::time::timeout(Duration::from_secs(1), receive.recv())
                    .await
                    .unwrap(),
                Some("delivered")
            );
            d.invoke("teardown cancelled").unwrap();
            d.cancel();
            drop(d);
            assert!(
                tokio::time::timeout(Duration::from_millis(25), receive.recv())
                    .await
                    .is_err()
            );
            assert!(errors.borrow().is_empty());

            let events = Rc::new(RefCell::new(Vec::new()));
            let notify = Rc::new(tokio::sync::Notify::new());
            let sub = Sub::new(
                "deadline",
                vec![deadline_sub("past", 900.0), deadline_sub("future", 1100.0)],
            )
            .unwrap();
            let cleanup = subscribe_deadline(&sub, timer, {
                let events = events.clone();
                let notify = notify.clone();
                Rc::new(move |msg: DeadlineExceeded| {
                    events
                        .borrow_mut()
                        .push(msg.id.as_utf8().unwrap().to_owned());
                    notify.notify_one();
                })
            })
            .unwrap();
            assert!(events.borrow().is_empty());
            tokio::time::timeout(Duration::from_secs(1), notify.notified())
                .await
                .unwrap();
            cleanup.cancel().unwrap();
            tokio::time::sleep(Duration::from_millis(120)).await;
            assert_eq!(*events.borrow(), ["past"]);
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn native_callback_failures_keep_the_original_panic_payload() {
    tokio::task::LocalSet::new()
        .run_until(async {
            #[derive(Debug)]
            struct Original {
                code: u32,
            }
            let (send, mut receive) = tokio::sync::mpsc::unbounded_channel();
            let timer = TokioTimer::new(move |error| send.send(error).unwrap());
            let _handle = timer
                .set_timeout(
                    1.0,
                    Box::new(|| std::panic::panic_any(Original { code: 42 })),
                )
                .unwrap();
            let error = tokio::time::timeout(Duration::from_secs(1), receive.recv())
                .await
                .unwrap()
                .unwrap();
            let cause = error
                .cause
                .expect("a captured callback panic retains its data");
            assert!(cause.with_payload(|payload| {
                payload
                    .downcast_ref::<Original>()
                    .is_some_and(|original| original.code == 42)
            }));
        })
        .await;
}
