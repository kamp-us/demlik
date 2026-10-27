use demlik_code_graph::{cli::{frontdoor::{prepare_cli, Preparation, ApiDispatch, HexagonDispatch, GatePreflightDispatch, LayerDispatch, BoundaryDispatch, EnvKeyDispatch, CommentDispatch},io::CliIo},engine::tsgo::TsgoBinary,text::JsString};
use std::{cell::RefCell,rc::Rc,io::{self,Write},fs};
struct BorrowedWriter<'a>(&'a Rc<RefCell<Vec<u8>>>);
impl Write for BorrowedWriter<'_>{fn write(&mut self,b:&[u8])->io::Result<usize>{self.0.borrow_mut().extend_from_slice(b);Ok(b.len())}fn flush(&mut self)->io::Result<()>{Ok(())}}
fn main(){
 let root=std::env::temp_dir().join(format!("demlik-collapse-public-{}",std::process::id()));fs::create_dir(&root).unwrap();fs::write(root.join("pnpm-workspace.yaml"),"packages: []\n").unwrap();
 let out=Rc::new(RefCell::new(Vec::new()));let err=Rc::new(RefCell::new(Vec::new()));let(mut stdout,mut stderr)=(BorrowedWriter(&out),BorrowedWriter(&err));let mut host=CliIo::new(&mut stdout,&mut stderr,Some(7));let binary=TsgoBinary::pinned("/no-compiler-needed-for-empty-policy");
 let args:Vec<JsString>=vec![root.to_string_lossy().as_ref().into(),"--collapse".into(),"--ci".into()];
 let Preparation::Prepared(p)=prepare_cli(&args,None,&mut host).unwrap()else{panic!("preflight")};
 let ApiDispatch::Continue(p)=p.dispatch_api_blocking(&binary,&mut host).unwrap()else{panic!("api")};
 let HexagonDispatch::Continue(p)=p.dispatch_hexagon(&mut host).unwrap()else{panic!("hexagon")};
 let GatePreflightDispatch::Continue(p)=p.prepare_gates(&mut host).unwrap()else{panic!("gate preflight")};
 let LayerDispatch::Continue(p)=p.dispatch_layers(&mut host).unwrap()else{panic!("layers")};
 let BoundaryDispatch::Continue(p)=p.dispatch_boundaries(&mut host).unwrap()else{panic!("boundaries")};
 let EnvKeyDispatch::Continue(p)=p.dispatch_env_keys(&mut host).unwrap()else{panic!("env")};
 let CommentDispatch::Continue(p)=p.dispatch_comments(&mut host).unwrap()else{panic!("comments")};
 let result=p.dispatch_collapse_gate(&mut host,&binary);assert!(result.is_ok());assert_eq!(host.exit_state().stored_code(),Some(2));drop(host);assert!(out.borrow().is_empty());assert_eq!(String::from_utf8(err.borrow().clone()).unwrap(),"code-graph: no scope at or under \".\" is recorded in collapse-ceilings.json; record one with `--collapse --write-ceilings` before gating on it.\n");fs::remove_dir_all(root).unwrap();
}
