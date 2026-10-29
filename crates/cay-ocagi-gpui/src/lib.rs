//! GPUI renders and handles input. The existing Rust BrowserHost owns the shop.
use cay_ocagi_web::{
    Action, BrowserHost, Request,
    domain::{OrderStatus, Phase},
};
use gpui::prelude::*;
use gpui::{
    App, ApplicationHandle, Bounds, Context, FocusHandle, Image, ImageFormat, SharedString, Task,
    Window, WindowBounds, WindowOptions, div, img, px, rgb, size,
};
use serde_json::json;
use std::{borrow::Cow, cell::RefCell, sync::Arc, time::Duration};
use wasm_bindgen::prelude::*;

thread_local! {
    static APPLICATION: RefCell<Option<ApplicationHandle>> = const { RefCell::new(None) };
    // A read-only projection for the adjacent HTML teaching panel, not another host.
    static SNAPSHOT: RefCell<String> = RefCell::new(String::new());
    static SOURCE: RefCell<String> = RefCell::new(String::new());
}
#[wasm_bindgen]
pub fn gpui_snapshot() -> String {
    SNAPSHOT.with(|value| value.borrow().clone())
}
#[wasm_bindgen]
pub fn gpui_source() -> String {
    SOURCE.with(|value| value.borrow().clone())
}

#[derive(Clone)]
enum Intent {
    Send(Action),
    Order(u8),
    More,
    Less,
    ServeNext,
    TogglePause,
    Speed,
}
struct TeaShop {
    host: BrowserHost,
    glasses: u8,
    focus: FocusHandle,
    scene: Arc<Image>,
    scene_key: String,
    boundary_error: Option<String>,
    _clock: Task<()>,
}
fn now() -> f64 {
    web_sys::window().unwrap().performance().unwrap().now()
}
impl TeaShop {
    fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let mut host = BrowserHost::default();
        let mut source = host.request(Request::Source).expect("embedded source");
        let lines: Vec<_> = include_str!("lib.rs").lines().collect();
        let start = lines
            .iter()
            .position(|line| line.trim() == "// @section gpui_dispatch")
            .unwrap()
            + 1;
        let length = lines[start..]
            .iter()
            .position(|line| line.trim() == "// @endsection")
            .unwrap();
        source["gpui"] = json!({"path":"cay-ocagi-gpui/src/lib.rs","start":start + 1,"code":lines[start..start + length].join("\n")});
        SOURCE.with(|value| *value.borrow_mut() = source.to_string());
        let focus = cx.focus_handle();
        window.focus(&focus, cx);
        // @section gpui_clock
        // GPUI supplies elapsed time. BrowserHost alone schedules effects,
        // queues completion messages, and applies the actual TEA Machine.
        let clock = cx.spawn_in(window, async move |this, cx| {
            let mut previous = now();
            loop {
                cx.background_executor()
                    .timer(Duration::from_millis(50))
                    .await;
                let current = now();
                let elapsed = current - previous;
                previous = current;
                if this
                    .update_in(cx, |this, _, cx| {
                        if let Err(error) = this.host.advance(elapsed) {
                            this.boundary_error = Some(error);
                        }
                        this.publish();
                        cx.notify();
                    })
                    .is_err()
                {
                    break;
                }
            }
        });
        // @endsection
        let mut shop = Self {
            host,
            glasses: 2,
            focus,
            scene: Arc::new(Image::from_bytes(
                ImageFormat::Svg,
                include_bytes!("../assets/shop.svg").to_vec(),
            )),
            scene_key: String::new(),
            boundary_error: None,
            _clock: clock,
        };
        shop.publish();
        shop
    }
    fn publish(&mut self) {
        let mut state = self.host.state();
        state["renderer"] = json!("GPUI Web · shared BrowserHost");
        state["boundary_error"] = json!(self.boundary_error);
        SNAPSHOT.with(|value| *value.borrow_mut() = state.to_string());
        let model = self.host.model();
        let served: Vec<_> = model
            .orders
            .iter()
            .filter(|order| order.status == OrderStatus::Served)
            .map(|order| order.table)
            .collect();
        let key = format!("{:?}-{}-{:?}", model.phase, model.tea, served);
        if key != self.scene_key {
            let hot = !matches!(model.phase, Phase::Cold);
            let flame = matches!(model.phase, Phase::Heating);
            let mut style = format!(
                ".flame{{opacity:{}}}.steam{{opacity:{}}}#ready-glasses{{opacity:{}}}.table-tea,#delivery-tray{{opacity:0}}",
                u8::from(flame),
                u8::from(hot),
                u8::from(model.tea > 0)
            );
            for table in served {
                style.push_str(&format!("#table-art-{table} .table-tea{{opacity:1}}"));
            }
            self.scene = Arc::new(Image::from_bytes(
                ImageFormat::Svg,
                include_str!("../assets/shop.svg")
                    .replace("/*STATE*/", &style)
                    .into_bytes(),
            ));
            self.scene_key = key;
        }
    }
    // @section gpui_dispatch
    // Every GPUI click and keyboard shortcut uses this one dispatch path.
    // A click sends an Action to the existing Rust host; it never edits Model.
    fn dispatch(&mut self, intent: Intent, cx: &mut Context<Self>) {
        let state = self.host.state();
        let action = match intent {
            Intent::More => {
                self.glasses = (self.glasses + 1).min(6);
                cx.notify();
                return;
            }
            Intent::Less => {
                self.glasses = self.glasses.saturating_sub(1).max(1);
                cx.notify();
                return;
            }
            Intent::Order(table) => Action::Order {
                table,
                glasses: self.glasses,
            },
            Intent::Send(action) => action,
            Intent::TogglePause => Action::Pause {
                paused: !state["paused"].as_bool().unwrap(),
            },
            Intent::Speed => Action::Speed {
                speed: if state["speed"].as_f64().unwrap() < 4.0 {
                    4.0
                } else {
                    1.0
                },
            },
            Intent::ServeNext => {
                let Some(order) = self
                    .host
                    .model()
                    .orders
                    .iter()
                    .find(|order| order.status == OrderStatus::Waiting)
                else {
                    self.boundary_error = Some("Önce bir masadan sipariş al.".into());
                    self.publish();
                    cx.notify();
                    return;
                };
                Action::Serve { id: order.id }
            }
        };
        self.boundary_error = self.host.request(Request::Action { action }).err();
        self.publish();
        cx.notify();
    }
    // @endsection
    fn button(
        &self,
        id: impl Into<SharedString>,
        label: impl Into<SharedString>,
        intent: Intent,
        primary: bool,
        cx: &Context<Self>,
    ) -> impl IntoElement {
        div()
            .id(id.into())
            .px_3()
            .py_2()
            .rounded_md()
            .border_1()
            .border_color(rgb(if primary { 0x326451 } else { 0xd9c7aa }))
            .bg(rgb(if primary { 0x326451 } else { 0xf8f1df }))
            .text_color(rgb(if primary { 0xfff8e9 } else { 0x385346 }))
            .text_sm()
            .cursor_pointer()
            .hover(|style| style.bg(rgb(if primary { 0x244d3e } else { 0xeadcc0 })))
            .child(label.into())
            .on_click(cx.listener(move |this, _, window, cx| {
                window.focus(&this.focus, cx);
                this.dispatch(intent.clone(), cx);
            }))
    }
}
impl Render for TeaShop {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let state = self.host.state();
        let model = self.host.model().clone();
        let paused = state["paused"].as_bool().unwrap();
        let phase = match model.phase {
            Phase::Cold => "Semaver soğuk",
            Phase::Heating => "Su ısınıyor…",
            Phase::Hot => "Su sıcak, demleme vakti",
            Phase::Brewing => "Çay demleniyor…",
            Phase::Ready => "Tavşan kanı, hazır!",
        };
        let width = f32::from(window.viewport_size().width);
        let scene_height = ((width - 32.) * 520. / 760.).min(360.);
        let orders: Vec<_> = model.orders.iter().rev().take(8).cloned().collect();
        div().id("tea-shop").track_focus(&self.focus).size_full().overflow_y_scroll().bg(rgb(0xf4eddd)).text_color(rgb(0x294b40)).font_family("IBM Plex Sans")
            .on_key_down(cx.listener(|this,event: &gpui::KeyDownEvent,_,cx| {
                if event.keystroke.modifiers.control || event.keystroke.modifiers.platform || event.keystroke.modifiers.alt {return;}
                let intent=match event.keystroke.key.as_str(){
                    "1"=>Some(Intent::Order(1)),"2"=>Some(Intent::Order(2)),"3"=>Some(Intent::Order(3)),
                    "h"=>Some(Intent::Send(Action::Heat)),"b"=>Some(Intent::Send(Action::Brew)),"s"=>Some(Intent::ServeNext),
                    "p"=>Some(Intent::TogglePause),"space"=>Some(Intent::Send(Action::Step)),"r"=>Some(Intent::Send(Action::Reset)),_=>None};
                if let Some(intent)=intent {this.dispatch(intent,cx);cx.stop_propagation();}
            }))
            .child(div().flex().flex_col().gap_3().p_4()
                .child(div().flex().justify_between().items_center().child(div().text_xl().child("Çaylar benden."))
                    .child(div().text_sm().child(format!("{} çay servis edildi",model.served))))
                .child(img(self.scene.clone()).w_full().h(px(scene_height)).object_fit(gpui::ObjectFit::Contain))
                .child(div().flex().justify_between().flex_wrap().gap_2().child(div().text_lg().child(phase)).child(div().text_sm().child(format!("Su {} · Yaprak {} · Hazır {}",model.water,model.leaves,model.tea))))
                .child(div().text_sm().child(self.boundary_error.clone().or(model.error.clone()).unwrap_or(model.note.clone())))
                .child(div().flex().flex_wrap().gap_2()
                    .child(self.button("heat","H · Ateşi yak",Intent::Send(Action::Heat),true,cx))
                    .child(self.button("brew","B · Demle",Intent::Send(Action::Brew),true,cx))
                    .child(self.button("serve","S · Sıradakini götür",Intent::ServeNext,true,cx)))
                .child(div().flex().flex_wrap().items_center().gap_2().child(div().text_sm().child("Her siparişte"))
                    .child(self.button("less","−",Intent::Less,false,cx)).child(format!("{} bardak",self.glasses)).child(self.button("more","+",Intent::More,false,cx)))
                .child(div().flex().flex_wrap().gap_2().child(self.button("table1","1 · Kemal amca",Intent::Order(1),false,cx))
                    .child(self.button("table2","2 · Elif",Intent::Order(2),false,cx)).child(self.button("table3","3 · Deniz",Intent::Order(3),false,cx)))
                .child(div().border_t_1().border_color(rgb(0xd9c7aa)).pt_3().flex().flex_wrap().gap_2()
                    .child(self.button("pause",if paused {"P · Devam et"} else {"P · Duraklat"},Intent::TogglePause,false,cx))
                    .child(self.button("step","Space · Tek adım",Intent::Send(Action::Step),false,cx))
                    .child(self.button("speed",format!("Hız {}×",state["speed"]),Intent::Speed,false,cx)))
                .child(div().text_sm().child(format!("Rust mesaj kutusu: {}  ·  Sipariş defteri: {}",state["pending"].as_array().unwrap().len(),model.orders.len())))
                .children(orders.into_iter().map(|order| {
                    let status=match order.status {OrderStatus::Waiting=>"Bekliyor",OrderStatus::Serving=>"Tepside",OrderStatus::Served=>"Afiyet olsun",OrderStatus::Cancelled=>"İptal"};
                    let row=div().flex().flex_wrap().items_center().justify_between().gap_2().p_2().rounded_md().bg(rgb(0xede0c8))
                        .child(format!("#{} · Masa {} · {} çay · {status}",order.id,order.table,order.glasses));
                    if order.status == OrderStatus::Waiting { row.child(div().flex().gap_2()
                        .child(self.button(format!("serve-{}",order.id),"Götür",Intent::Send(Action::Serve{id:order.id}),true,cx))
                        .child(self.button(format!("cancel-{}",order.id),"İptal",Intent::Send(Action::Cancel{id:order.id}),false,cx))).into_any_element() } else {row.into_any_element()}
                }))
                .child(div().border_t_1().border_color(rgb(0xd9c7aa)).pt_3().flex().flex_wrap().gap_2()
                    .child(self.button("refill","Su doldur",Intent::Send(Action::Refill),false,cx))
                    .child(self.button("restock","Yaprak ekle",Intent::Send(Action::Restock),false,cx))
                    .child(self.button("empty","Suyu boşalt",Intent::Send(Action::EmptyWater),false,cx))
                    .child(self.button("reset","R · Baştan",Intent::Send(Action::Reset),false,cx)))
                .child(div().text_xs().child("Klavye: 1/2/3 sipariş · H ısıt · B demle · S servis · P duraklat · Space adım · R baştan")))
    }
}
#[wasm_bindgen(start)]
pub fn start() {
    gpui_platform::web_init();
    let handle = gpui_platform::single_threaded_web().run_embedded(|cx: &mut App| {
        cx.text_system()
            .add_fonts(vec![Cow::Borrowed(include_bytes!(
                "../assets/IBMPlexSans-Regular.ttf"
            ))])
            .expect("bundled font");
        let bounds = Bounds::centered(None, size(px(760.), px(900.)), cx);
        cx.open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                ..Default::default()
            },
            |window, cx| cx.new(|cx| TeaShop::new(window, cx)),
        )
        .expect("GPUI browser window");
        cx.activate(true);
    });
    APPLICATION.with(|application| *application.borrow_mut() = Some(handle));
}
