use demlik_tea::command::{CommandContractError, CommandFamily};
use demlik_tea::{Step, Tagged, messages};
use serde::{Deserialize, Serialize};

// @section model
// Model is the tea-house ledger. Only update writes a new one.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Cold,
    Heating,
    Hot,
    Brewing,
    Ready,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum OrderStatus {
    Waiting,
    Serving,
    Served,
    Cancelled,
}

#[derive(Clone, Debug, Serialize)]
pub struct Order {
    pub id: u32,
    pub table: u8,
    pub glasses: u8,
    pub status: OrderStatus,
}

#[derive(Clone, Debug, Serialize)]
pub struct Model {
    pub phase: Phase,
    pub water: u8,
    pub leaves: u8,
    pub tea: u8,
    pub orders: Vec<Order>,
    pub served: u32,
    pub next_order: u32,
    pub generation: u64,
    pub error: Option<String>,
    pub note: String,
}

impl Default for Model {
    fn default() -> Self {
        Self {
            phase: Phase::Cold,
            water: 12,
            leaves: 4,
            tea: 0,
            orders: vec![],
            served: 0,
            next_order: 1,
            generation: 0,
            error: None,
            note: "Hoş geldin! Bir masaya tıkla, ilk siparişi al.".into(),
        }
    }
}

impl Tagged for Model {
    fn tag(&self) -> &str {
        "tea_house"
    }
}
// @endsection

// @section messages
// Msg is something that happened: a guest asked, or an effect finished.
messages! {
    #[derive(Clone, Debug, Serialize, Deserialize)]
    #[serde(tag = "type")]
    pub enum Msg {
        OrderPlaced { table: u8, glasses: u8 },
        HeatRequested,
        HeatFinished { generation: u64, result: Result<(), String> },
        BrewRequested,
        BrewFinished { generation: u64, glasses: u8 },
        ServeRequested { id: u32 },
        ServeFinished { generation: u64, id: u32 },
        OrderCancelled { id: u32 },
        WaterRefilled,
        LeavesRestocked,
        WaterEmptied,
        ResetRequested,
    }
}

// Cmd is a work order. Describing the work does not perform it.
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type")]
pub enum Cmd {
    HeatWater { generation: u64, has_water: bool },
    SteepTea { generation: u64, glasses: u8 },
    DeliverTea { generation: u64, id: u32 },
}
// @endsection

// @section update
// This function is pure: the same Model + Msg always gives the same Step.
pub fn update(model: &Model, message: &Msg) -> Step<Model, Cmd> {
    let mut next = model.clone();
    let mut commands = vec![];
    next.error = None;
    match message {
        Msg::OrderPlaced { table, glasses } => {
            if next
                .orders
                .iter()
                .filter(|o| o.status == OrderStatus::Waiting)
                .count()
                >= 12
            {
                next.error = Some("Sipariş defteri dolu. Önce bekleyen çayları servis et.".into());
            } else {
                next.orders.push(Order {
                    id: next.next_order,
                    table: *table,
                    glasses: *glasses,
                    status: OrderStatus::Waiting,
                });
                next.next_order += 1;
                next.note = format!("Masa {table}: {glasses} çay, lütfen!");
            }
        }
        Msg::HeatRequested => {
            if next.phase != Phase::Cold {
                next.error = Some("Semaver zaten sıcak ya da çalışıyor.".into());
            } else {
                next.phase = Phase::Heating;
                next.note = "Ateş yandı. Suyu ısıtıyoruz…".into();
                commands.push(Cmd::HeatWater {
                    generation: next.generation,
                    has_water: next.water > 0,
                });
            }
        }
        Msg::HeatFinished { generation, result } => {
            if *generation != next.generation {
                return Step::new(model.clone(), vec![]);
            }
            match result {
                Ok(()) => {
                    next.phase = Phase::Hot;
                    next.note = "Su kaynadı! Şimdi çayı demle.".into();
                }
                Err(reason) => {
                    next.phase = Phase::Cold;
                    next.error = Some(reason.clone());
                    next.note = "Sorun bir mesaj olarak geri geldi. Su ekle, tekrar dene.".into();
                }
            }
        }
        Msg::BrewRequested => {
            if next.phase != Phase::Hot && next.phase != Phase::Ready {
                next.error = Some("Demlemek için önce suyu kaynat.".into());
            } else if next.leaves == 0 || next.water == 0 {
                next.error =
                    Some("Demlemek için su ve çay yaprağı gerekiyor. Stokları tamamla.".into());
            } else if next.tea > 0 {
                next.error = Some("Demlikte hâlâ çay var. Önce servis et.".into());
            } else {
                next.phase = Phase::Brewing;
                next.note = "Çay demleniyor. Bu sırada başka sipariş alabilirsin.".into();
                commands.push(Cmd::SteepTea {
                    generation: next.generation,
                    glasses: next.water.min(6),
                });
            }
        }
        Msg::BrewFinished {
            generation,
            glasses,
        } => {
            if *generation != next.generation {
                return Step::new(model.clone(), vec![]);
            }
            next.phase = Phase::Ready;
            next.water -= glasses;
            next.leaves -= 1;
            next.tea = *glasses;
            next.note = format!("Tavşan kanı! {glasses} bardak çay hazır.");
        }
        Msg::ServeRequested { id } => {
            if let Some(order) = next.orders.iter_mut().find(|o| o.id == *id) {
                if order.status != OrderStatus::Waiting {
                    next.error = Some("Bu sipariş artık beklemiyor.".into());
                } else if next.phase != Phase::Ready || next.tea < order.glasses {
                    next.error = Some(format!(
                        "Bu sipariş için {} bardak hazır çay gerekiyor.",
                        order.glasses
                    ));
                } else {
                    next.tea -= order.glasses;
                    order.status = OrderStatus::Serving;
                    next.note = format!("Masa {} için tepsi yola çıktı…", order.table);
                    commands.push(Cmd::DeliverTea {
                        generation: next.generation,
                        id: *id,
                    });
                    if next.tea == 0 {
                        next.phase = Phase::Hot;
                    }
                }
            } else {
                next.error = Some("Sipariş bulunamadı.".into());
            }
        }
        Msg::ServeFinished { generation, id } => {
            if *generation != next.generation {
                return Step::new(model.clone(), vec![]);
            }
            if let Some(order) = next
                .orders
                .iter_mut()
                .find(|o| o.id == *id && o.status == OrderStatus::Serving)
            {
                order.status = OrderStatus::Served;
                next.served += u32::from(order.glasses);
                next.note = format!("Masa {}: Eline sağlık! ☕", order.table);
            }
        }
        Msg::OrderCancelled { id } => {
            if let Some(order) = next
                .orders
                .iter_mut()
                .find(|o| o.id == *id && o.status == OrderStatus::Waiting)
            {
                order.status = OrderStatus::Cancelled;
                next.note = format!("Sipariş #{id} iptal edildi.");
            } else {
                next.error = Some("Yalnızca bekleyen siparişler iptal edilebilir.".into());
            }
        }
        Msg::WaterRefilled => {
            if matches!(next.phase, Phase::Heating | Phase::Brewing) {
                next.error =
                    Some("Semaver çalışırken su eklenmez. İşlem bitince tekrar dene.".into());
            } else {
                next.water = 12;
                next.note = "Semavere taze su eklendi.".into();
            }
        }
        Msg::LeavesRestocked => {
            next.leaves = 4;
            next.note = "Çay kutusu yeniden doldu.".into();
        }
        Msg::WaterEmptied => {
            if next.phase == Phase::Cold {
                next.water = 0;
                next.note = "Su boşaldı. Ateşi yak ve hatanın nasıl geri döndüğünü izle.".into();
            } else {
                next.error =
                    Some("Bu deney için önce yeni vardiya başlat: semaver soğuk olmalı.".into());
            }
        }
        Msg::ResetRequested => {
            next = Model {
                generation: model.generation + 1,
                ..Model::default()
            };
        }
    }
    Step::new(next, commands)
}
// @endsection

impl Tagged for Cmd {
    fn tag(&self) -> &str {
        match self {
            Self::HeatWater { .. } => "HeatWater",
            Self::SteepTea { .. } => "SteepTea",
            Self::DeliverTea { .. } => "DeliverTea",
        }
    }
}
impl CommandFamily for Cmd {
    type Msg = Msg;
    type Completion = Vec<Msg>;
    fn settle(self, messages: Vec<Msg>, _: f64) -> Result<Vec<Msg>, CommandContractError> {
        Ok(messages)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn full_service_conserves_stock_and_ignores_old_shift_completions() {
        let mut m = Model::default();
        for msg in [
            Msg::OrderPlaced {
                table: 1,
                glasses: 2,
            },
            Msg::HeatRequested,
            Msg::HeatFinished {
                generation: 0,
                result: Ok(()),
            },
            Msg::BrewRequested,
            Msg::BrewFinished {
                generation: 0,
                glasses: 6,
            },
            Msg::ServeRequested { id: 1 },
            Msg::ServeFinished {
                generation: 0,
                id: 1,
            },
        ] {
            m = update(&m, &msg).state;
            assert!(m.error.is_none());
        }
        assert_eq!((m.water, m.leaves, m.tea, m.served), (6, 3, 4, 2));
        m = update(&m, &Msg::ResetRequested).state;
        m = update(
            &m,
            &Msg::BrewFinished {
                generation: 0,
                glasses: 6,
            },
        )
        .state;
        assert_eq!((m.water, m.leaves, m.tea), (12, 4, 0));
    }
    #[test]
    fn an_empty_semaver_returns_a_failure_and_can_be_retried() {
        let mut m = update(&Model::default(), &Msg::WaterEmptied).state;
        m = update(&m, &Msg::HeatRequested).state;
        m = update(
            &m,
            &Msg::HeatFinished {
                generation: 0,
                result: Err("No water".into()),
            },
        )
        .state;
        assert_eq!(m.phase, Phase::Cold);
        assert_eq!(m.error.as_deref(), Some("No water"));
        m = update(&m, &Msg::WaterRefilled).state;
        let step = update(&m, &Msg::HeatRequested);
        assert!(matches!(
            step.commands.as_slice(),
            [Cmd::HeatWater {
                has_water: true,
                ..
            }]
        ));
    }
}
