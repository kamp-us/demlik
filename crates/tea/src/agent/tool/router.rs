/// Declare one finite typed table. Names, commands, completions, messages and
/// result variants all come from these entries; no handler registry is built.
#[macro_export]
macro_rules! tool_router {
    ($vis:vis mod $module:ident {}) => {
        $vis mod $module {
            pub use $crate::agent::tool::{EmptyRouter as Router, EmptyInterpreter as Interpreter};
            pub type Commands=$crate::command::Cmd<$crate::agent::tool::RejectedSpec>;
            pub type Completions=$crate::command::Completion<$crate::agent::tool::RejectedSpec>;
            pub type Messages=$crate::command::Settled<$crate::agent::tool::RejectedSpec>;
        }
    };
    ($vis:vis mod $module:ident { $first:ident($first_field:ident) $(, $tool:ident($field:ident))* $(,)? }) => {
        $vis mod $module {
            use $crate::{Tagged as _, command::CommandFamily as _};
            use $crate::agent::tool::{ToolDefinition, SignatureOf};
            pub enum Commands<$first:ToolDefinition,$($tool:ToolDefinition),*> {
                $first($crate::agent::tool::ToolCommand<$first>),$($tool($crate::agent::tool::ToolCommand<$tool>),)*
                Rejected($crate::command::Cmd<$crate::agent::tool::RejectedSpec>),
            }
            pub enum Completions<$first:ToolDefinition,$($tool:ToolDefinition),*> {
                $first($crate::agent::tool::ToolCompletion<$first>),$($tool($crate::agent::tool::ToolCompletion<$tool>),)*
                Rejected($crate::command::Completion<$crate::agent::tool::RejectedSpec>),
            }
            pub enum Messages<$first:$crate::command::CommandSpec,$($tool:$crate::command::CommandSpec),*> {
                $first($crate::command::Settled<$first>),$($tool($crate::command::Settled<$tool>),)*
                Rejected($crate::command::Settled<$crate::agent::tool::RejectedSpec>),
            }
            pub enum Results<$first:$crate::command::CommandSpec,$($tool:$crate::command::CommandSpec),*> {
                $first($first::Output),$($tool($tool::Output),)*Rejected(()),
            }
            pub enum Errors<$first:$crate::command::CommandSpec,$($tool:$crate::command::CommandSpec),*> {
                $first($crate::agent::tool::FailureView<$crate::command::Failure<$first::Error>>),$($tool($crate::agent::tool::FailureView<$crate::command::Failure<$tool::Error>>),)*
                Rejected($crate::agent::tool::FailureView<$crate::command::Failure<$crate::agent::tool::ToolRejection>>),
            }
            pub enum ContentErrors<$first,$($tool),*> {$first($first),$($tool($tool),)*}
            impl<$first:ToolDefinition,$($tool:ToolDefinition),*> $crate::Tagged for Commands<$first,$($tool),*> {
                fn tag(&self)->&str {match self {Self::$first(c)=>c.tag(),$(Self::$tool(c)=>c.tag(),)*Self::Rejected(c)=>c.tag()}}
            }
            impl<$first:$crate::command::CommandSpec,$($tool:$crate::command::CommandSpec),*> $crate::Tagged for Messages<$first,$($tool),*> {
                fn tag(&self)->&str {match self {Self::$first(m)=>m.tag(),$(Self::$tool(m)=>m.tag(),)*Self::Rejected(m)=>m.tag()}}
            }
            impl<$first:ToolDefinition,$($tool:ToolDefinition),*> $crate::command::CommandFamily for Commands<$first,$($tool),*> {
                type Msg=Messages<SignatureOf<$first>,$(SignatureOf<$tool>),*>;
                type Completion=Completions<$first,$($tool),*>;
                fn is_defined(&self)->bool{true}
                fn engine_stamp(m:&Self::Msg)->Option<&$crate::command::EngineStamp>{match m {Messages::$first(m)=>m.engine_stamp(),$(Messages::$tool(m)=>m.engine_stamp(),)*Messages::Rejected(m)=>m.engine_stamp()}}
                fn settle(self,c:Self::Completion,at:f64)->Result<Vec<Self::Msg>,$crate::command::CommandContractError>{match(self,c){(Self::$first(cmd),Completions::$first(out))=>Ok(cmd.settle(out,at)?.into_iter().map(Messages::$first).collect()),$((Self::$tool(cmd),Completions::$tool(out))=>Ok(cmd.settle(out,at)?.into_iter().map(Messages::$tool).collect()),)*(Self::Rejected(cmd),Completions::Rejected(out))=>Ok(cmd.settle(out,at)?.into_iter().map(Messages::Rejected).collect()),(cmd,_)=>Err($crate::command::CommandContractError::mismatched(cmd.tag(),"wrong tool completion family"))}}
                fn settle_in(self,c:Self::Completion,edge:&$crate::command::CommandEdge)->Result<Vec<Self::Msg>,$crate::command::CommandContractError>{match(self,c){(Self::$first(cmd),Completions::$first(out))=>Ok(cmd.settle_in(out,edge)?.into_iter().map(Messages::$first).collect()),$((Self::$tool(cmd),Completions::$tool(out))=>Ok(cmd.settle_in(out,edge)?.into_iter().map(Messages::$tool).collect()),)*(Self::Rejected(cmd),Completions::Rejected(out))=>Ok(cmd.settle_in(out,edge)?.into_iter().map(Messages::Rejected).collect()),(cmd,_)=>Err($crate::command::CommandContractError::mismatched(cmd.tag(),"wrong tool completion family"))}}
            }
            impl<$first:ToolDefinition,$($tool:ToolDefinition),*> $crate::agent::tool::__serde::Serialize for Commands<$first,$($tool),*>
            where $first::Args:$crate::agent::tool::__serde::Serialize,$($tool::Args:$crate::agent::tool::__serde::Serialize),* {
                fn serialize<S:$crate::agent::tool::__serde::Serializer>(&self,s:S)->Result<S::Ok,S::Error>{match self {Self::$first(v)=>$crate::agent::tool::__serde::Serialize::serialize(v,s),$(Self::$tool(v)=>$crate::agent::tool::__serde::Serialize::serialize(v,s),)*Self::Rejected(v)=>$crate::agent::tool::__serde::Serialize::serialize(v,s)}}
            }
            impl<$first:ToolDefinition,$($tool:ToolDefinition),*> $crate::agent::tool::__serde::Serialize for Completions<$first,$($tool),*>
            where $first::RawResult:$crate::agent::tool::__serde::Serialize,$first::Error:$crate::agent::tool::__serde::Serialize,$($tool::RawResult:$crate::agent::tool::__serde::Serialize,$tool::Error:$crate::agent::tool::__serde::Serialize),* {
                fn serialize<S:$crate::agent::tool::__serde::Serializer>(&self,s:S)->Result<S::Ok,S::Error>{match self {Self::$first(v)=>$crate::agent::tool::__serde::Serialize::serialize(v,s),$(Self::$tool(v)=>$crate::agent::tool::__serde::Serialize::serialize(v,s),)*Self::Rejected(v)=>$crate::agent::tool::__serde::Serialize::serialize(v,s)}}
            }
            impl<$first:$crate::command::CommandSpec,$($tool:$crate::command::CommandSpec),*> $crate::agent::tool::__serde::Serialize for Messages<$first,$($tool),*>
            where $first::Input:$crate::agent::tool::__serde::Serialize,$first::Output:$crate::agent::tool::__serde::Serialize,$first::Error:$crate::agent::tool::__serde::Serialize,$($tool::Input:$crate::agent::tool::__serde::Serialize,$tool::Output:$crate::agent::tool::__serde::Serialize,$tool::Error:$crate::agent::tool::__serde::Serialize),* {
                fn serialize<S:$crate::agent::tool::__serde::Serializer>(&self,s:S)->Result<S::Ok,S::Error>{match self {Self::$first(v)=>$crate::agent::tool::__serde::Serialize::serialize(v,s),$(Self::$tool(v)=>$crate::agent::tool::__serde::Serialize::serialize(v,s),)*Self::Rejected(v)=>$crate::agent::tool::__serde::Serialize::serialize(v,s)}}
            }
            impl<$first:$crate::command::CommandSpec,$($tool:$crate::command::CommandSpec),*> $crate::agent::tool::__serde::Serialize for Results<$first,$($tool),*>
            where $first::Output:$crate::agent::tool::__serde::Serialize,$($tool::Output:$crate::agent::tool::__serde::Serialize),* {
                fn serialize<S:$crate::agent::tool::__serde::Serializer>(&self,s:S)->Result<S::Ok,S::Error>{match self {Self::$first(v)=>$crate::agent::tool::__serde::Serialize::serialize(v,s),$(Self::$tool(v)=>$crate::agent::tool::__serde::Serialize::serialize(v,s),)*Self::Rejected(v)=>$crate::agent::tool::__serde::Serialize::serialize(v,s)}}
            }
            impl<$first:$crate::command::CommandSpec,$($tool:$crate::command::CommandSpec),*> $crate::agent::tool::__serde::Serialize for Errors<$first,$($tool),*> {
                fn serialize<S:$crate::agent::tool::__serde::Serializer>(&self,s:S)->Result<S::Ok,S::Error>{match self {Self::$first(v)=>$crate::agent::tool::__serde::Serialize::serialize(v,s),$(Self::$tool(v)=>$crate::agent::tool::__serde::Serialize::serialize(v,s),)*Self::Rejected(v)=>$crate::agent::tool::__serde::Serialize::serialize(v,s)}}
            }
            pub struct Router<$first:ToolDefinition,$($tool:ToolDefinition),*> {$first_field:std::rc::Rc<$first>,$($field:std::rc::Rc<$tool>,)*}
            impl<$first:ToolDefinition,$($tool:ToolDefinition<Host=$first::Host,RawArgs=$first::RawArgs>),*> Router<$first,$($tool),*> {
                pub fn $first_field(&self)->&std::rc::Rc<$first>{&self.$first_field}
                $(pub fn $field(&self)->&std::rc::Rc<$tool>{&self.$field})*
                pub fn new($first_field:std::rc::Rc<$first>,$($field:std::rc::Rc<$tool>),*)->Result<Self,$crate::agent::tool::ToolError>{
                    let names=[$first_field.name(),$($field.name()),*];let mut seen=std::collections::HashSet::new();for name in names {if !seen.insert(name){return Err($crate::agent::tool::ToolError::Duplicate{name:name.into()})}}Ok(Self{$first_field,$($field),*})
                }
                pub fn tool_of(&self,call:&$crate::agent::types::ToolCall<$first::RawArgs>)->Result<Commands<$first,$($tool),*>,$crate::agent::tool::ToolError>{
                    if call.name.as_utf8()==Some(self.$first_field.name()){return Ok(match $crate::agent::tool::reject_route(&self.$first_field,call)?{Ok(c)=>Commands::$first(c),Err(c)=>Commands::Rejected(c)})}
                    $(if call.name.as_utf8()==Some(self.$field.name()){return Ok(match $crate::agent::tool::reject_route(&self.$field,call)?{Ok(c)=>Commands::$tool(c),Err(c)=>Commands::Rejected(c)})})*
                    Ok(Commands::Rejected($crate::agent::tool::rejected(call.call_id.clone(),$crate::agent::tool::ToolRejection::UnknownTool{name:call.name.clone()})))
                }
                pub async fn interpret(&self,cmd:&Commands<$first,$($tool),*>,ctx:$crate::agent::tool::ToolContext<'_,$first::Host>)->Result<Completions<$first,$($tool),*>,$crate::agent::tool::ToolError>{
                    match cmd {Commands::$first(c)=>{if c.tag()!=self.$first_field.name(){return Err($crate::command::CommandContractError::mismatched(c.tag(),self.$first_field.name()).into())}Ok(Completions::$first($crate::agent::tool::ToolCompletion::new(std::rc::Rc::clone(&self.$first_field),self.$first_field.handle(&c.cmd().input().args,ctx).await?)))},$(Commands::$tool(c)=>{if c.tag()!=self.$field.name(){return Err($crate::command::CommandContractError::mismatched(c.tag(),self.$field.name()).into())}Ok(Completions::$tool($crate::agent::tool::ToolCompletion::new(std::rc::Rc::clone(&self.$field),self.$field.handle(&c.cmd().input().args,ctx).await?)))},)*Commands::Rejected(c)=>{if c.tag()!=$crate::agent::tool::REJECTED_TYPE{return Err($crate::command::CommandContractError::mismatched(c.tag(),$crate::agent::tool::REJECTED_TYPE).into())}Ok(Completions::Rejected(Some($crate::command::Outcome::err(c.input().error.clone()))))}}
                }
                pub fn resilience_of(&self,call:&$crate::agent::types::ToolCall<$first::RawArgs>)->Option<&$crate::agent::tool_resilience::ToolResilience>{if call.name.as_utf8()==Some(self.$first_field.name()){return self.$first_field.resilience()}$(if call.name.as_utf8()==Some(self.$field.name()){return self.$field.resilience()})*None}
                pub fn outcome_of(&self,msg:&Messages<SignatureOf<$first>,$(SignatureOf<$tool>),*>)->Result<Option<$crate::agent::tool::ToolSettlement<Results<SignatureOf<$first>,$(SignatureOf<$tool>),*>,Errors<SignatureOf<$first>,$(SignatureOf<$tool>),*>>>,$crate::command::CommandContractError>{
                    let value=match msg {
                        Messages::$first(m)=>{if m.tag()!=format!("{}_ok",self.$first_field.name())&&m.tag()!=format!("{}_err",self.$first_field.name()){return Ok(None)}let out=match m.outcome(){$crate::command::Settlement::Ok(v)=>$crate::agent::types::ToolOutcome::Ok(std::rc::Rc::new(Results::$first(v.clone()))),$crate::command::Settlement::Err(e)=>$crate::agent::types::ToolOutcome::Error(std::rc::Rc::new(Errors::$first($crate::agent::tool::snapshot_error(self.$first_field.as_ref(),e)?)))};$crate::agent::tool::ToolSettlement{call_id:m.cmd().input().call_id.clone(),outcome:out}},
                        $(Messages::$tool(m)=>{if m.tag()!=format!("{}_ok",self.$field.name())&&m.tag()!=format!("{}_err",self.$field.name()){return Ok(None)}let out=match m.outcome(){$crate::command::Settlement::Ok(v)=>$crate::agent::types::ToolOutcome::Ok(std::rc::Rc::new(Results::$tool(v.clone()))),$crate::command::Settlement::Err(e)=>$crate::agent::types::ToolOutcome::Error(std::rc::Rc::new(Errors::$tool($crate::agent::tool::snapshot_error(self.$field.as_ref(),e)?)))};$crate::agent::tool::ToolSettlement{call_id:m.cmd().input().call_id.clone(),outcome:out}},)*
                        Messages::Rejected(m)=>{if m.tag()!="tool_rejected_ok"&&m.tag()!="tool_rejected_err"{return Ok(None)}let out=match m.outcome(){$crate::command::Settlement::Ok(())=>$crate::agent::types::ToolOutcome::Ok(std::rc::Rc::new(Results::Rejected(()))),$crate::command::Settlement::Err(e)=>$crate::agent::types::ToolOutcome::Error(std::rc::Rc::new(Errors::Rejected($crate::agent::tool::rejected_error(e)?)))};$crate::agent::tool::ToolSettlement{call_id:m.cmd().input().call_id.clone(),outcome:out}},
                    };Ok(Some(value))
                }
                pub fn parts_of(&self,call:&$crate::agent::types::ToolCall<$first::RawArgs>,outcome:&$crate::agent::types::ToolOutcome<Results<SignatureOf<$first>,$(SignatureOf<$tool>),*>,Errors<SignatureOf<$first>,$(SignatureOf<$tool>),*>>)->Result<Option<$crate::agent::content::Parts>,ContentErrors<$first::ContentError,$($tool::ContentError),*>>{
                    let $crate::agent::types::ToolOutcome::Ok(value)=outcome else{return Ok(None)};match value.as_ref(){Results::$first(v) if call.name.as_utf8()==Some(self.$first_field.name())=>self.$first_field.parts(v).map_err(ContentErrors::$first),$(Results::$tool(v) if call.name.as_utf8()==Some(self.$field.name())=>self.$field.parts(v).map_err(ContentErrors::$tool),)*_=>Ok(None)}
                }
                pub fn update<'a,S:$crate::Tagged>(&self,cell:impl Fn(&S,&Messages<SignatureOf<$first>,$(SignatureOf<$tool>),*>)->$crate::Step<S,Commands<$first,$($tool),*>>+'a)->$crate::Update<'a,S,Messages<SignatureOf<$first>,$(SignatureOf<$tool>),*>,Commands<$first,$($tool),*>> {
                    let cell=std::rc::Rc::new(cell);let mut row:$crate::core::Row<'a,S,Messages<SignatureOf<$first>,$(SignatureOf<$tool>),*>,Commands<$first,$($tool),*>>=Default::default();
                    for name in [self.$first_field.name(),$(self.$field.name(),)*$crate::agent::tool::REJECTED_TYPE]{for suffix in ["_ok","_err"]{let cell=std::rc::Rc::clone(&cell);row.insert(format!("{name}{suffix}"),Box::new(move|s,m|cell(s,m)));}}
                    $crate::Update::raw_reducer(row)
                }
                pub fn interpreter(self:std::rc::Rc<Self>,host:std::rc::Rc<$first::Host>)->Interpreter<$first,$($tool),*>{Interpreter{router:self,host}}
            }
            pub struct Interpreter<$first:ToolDefinition,$($tool:ToolDefinition),*>{router:std::rc::Rc<Router<$first,$($tool),*>>,host:std::rc::Rc<$first::Host>}
            impl<$first:ToolDefinition,$($tool:ToolDefinition<Host=$first::Host,RawArgs=$first::RawArgs>),*> $crate::runtime::Interpreter<Commands<$first,$($tool),*>> for Interpreter<$first,$($tool),*> {
                type Error=$crate::agent::tool::ToolError;
                fn interpret<'s>(&'s self,cmd:&'s Commands<$first,$($tool),*>,ctx:$crate::runtime::CommandContext<<Commands<$first,$($tool),*> as $crate::command::CommandFamily>::Msg,Self::Error>)->Option<$crate::runtime::CommandWork<'s,<Commands<$first,$($tool),*> as $crate::command::CommandFamily>::Completion,Self::Error>>{
                    Some($crate::runtime::CommandWork::new(async move{self.router.interpret(cmd,$crate::agent::tool::ToolContext::runtime(self.host.as_ref(),&ctx)).await}))
                }
            }
        }
    };
}
