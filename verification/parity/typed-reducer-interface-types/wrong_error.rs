use demlik_tea::{messages,TryUpdate};messages!{enum Msg{Rejected}}fn main(){let _:TryUpdate<'_,(),Msg,(),&'static str>=TryUpdate::try_reducer(|_,_|Err(7_u8));}
