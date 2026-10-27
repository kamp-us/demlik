use demlik_code_graph::project::{Collation, CollationError, CollationInput};
use std::{cell::Cell, rc::Rc, sync::Arc};
struct Opaque<'a> { units: &'a [u16], touched: &'a Cell<usize>, token: Rc<()> }
fn main() -> Result<(), CollationError> {
    let touched = Cell::new(0);
    let private = [0xe000];
    let high = [0xd800];
    let original = Arc::new(Opaque { units: &high, touched: &touched, token: Rc::new(()) });
    let other = Arc::new(Opaque { units: &private, touched: &touched, token: Rc::new(()) });
    let rows = [other, Arc::clone(&original)];
    let collation = Collation::try_node22_en_us()?;
    let mut prepared = rows.iter().map(|row| {
        CollationInput::from_utf16(row.units).map(|input| (Arc::clone(row), input))
    }).collect::<Result<Vec<_>, _>>()?;
    prepared.sort_by(|a, b| collation.compare(&a.1, &b.1));
    let ordered: Vec<_> = prepared.into_iter().map(|(row, _)| row).collect();
    drop(collation);
    assert!(Arc::ptr_eq(&ordered[0], &original));
    assert!(Rc::ptr_eq(&ordered[0].token, &original.token));
    ordered[0].touched.set(17);
    assert_eq!(touched.get(), 17);
    println!("borrowed opaque Arc retained; high-surrogate sorts before private-use; local owner dropped");
    Ok(())
}
