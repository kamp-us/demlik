/// Declare one finite typed table. Names, commands, completions, messages and
/// result variants all come from these entries; no handler registry is built.
#[macro_export]
macro_rules! tool_router {
    (@route $router:ident, $call:ident, $id:expr, $name:expr, $route:path; $first:ident($first_field:ident) $(, $tool:ident($field:ident))*) => {
        {
            if ($name).as_utf8()==Some($router.$first_field.name()){return Ok(match $route(&$router.$first_field,$call)?{Ok(c)=>Commands::$first(c),Err(c)=>Commands::Rejected(c)})}
            $(if ($name).as_utf8()==Some($router.$field.name()){return Ok(match $route(&$router.$field,$call)?{Ok(c)=>Commands::$tool(c),Err(c)=>Commands::Rejected(c)})})*
            Ok(Commands::Rejected($crate::agent::tool::rejected(($id).clone(),$crate::agent::tool::ToolRejection::UnknownTool{name:($name).clone()})))
        }
    };
    ($vis:vis mod $module:ident {}) => {
        $vis mod $module {
            pub use $crate::agent::tool::{EmptyRouter as Router, EmptyInterpreter as Interpreter, EmptyAgentTools as AgentTools};
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
                    $crate::tool_router!(@route self,call,&call.call_id,&call.name,$crate::agent::tool::reject_route;$first($first_field)$(,$tool($field))*)
                }
                /// Routes the original guarded call through parse_args/from_input.
                /// Native-shaped custom command overrides belong to tool_of.
                pub fn tool_of_plain(&self,call:&std::rc::Rc<$crate::agent::PlainToolCall>)->Result<Commands<$first,$($tool),*>,$crate::agent::tool::ToolError>
                where $first:ToolDefinition<RawArgs=$crate::agent::PlainToolArgs> {
                    $crate::tool_router!(@route self,call,call.call_id(),call.name(),$crate::agent::tool::reject_plain_route;$first($first_field)$(,$tool($field))*)
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
                    self.parts_by_name(&call.name,outcome)
                }
                pub fn parts_of_plain(&self,call:&$crate::agent::PlainToolCall,outcome:&$crate::agent::types::ToolOutcome<Results<SignatureOf<$first>,$(SignatureOf<$tool>),*>,Errors<SignatureOf<$first>,$(SignatureOf<$tool>),*>>)->Result<Option<$crate::agent::content::Parts>,ContentErrors<$first::ContentError,$($tool::ContentError),*>>{
                    self.parts_by_name(call.name(),outcome)
                }
                fn parts_by_name(&self,name:&$crate::data::JsText,outcome:&$crate::agent::types::ToolOutcome<Results<SignatureOf<$first>,$(SignatureOf<$tool>),*>,Errors<SignatureOf<$first>,$(SignatureOf<$tool>),*>>)->Result<Option<$crate::agent::content::Parts>,ContentErrors<$first::ContentError,$($tool::ContentError),*>>{
                    let $crate::agent::types::ToolOutcome::Ok(value)=outcome else{return Ok(None)};match value.as_ref(){Results::$first(v) if name.as_utf8()==Some(self.$first_field.name())=>self.$first_field.parts(v).map_err(ContentErrors::$first),$(Results::$tool(v) if name.as_utf8()==Some(self.$field.name())=>self.$field.parts(v).map_err(ContentErrors::$tool),)*_=>Ok(None)}
                }
                /// Settlement names in declaration order, including rejection.
                pub fn settlement_types(&self)->Vec<String>{
                    let mut names=Vec::new();
                    let definition=$crate::command::CmdDef::<SignatureOf<$first>>::named(self.$first_field.name().to_owned());
                    names.extend([definition.ok_type(),definition.err_type()]);
                    $(let definition=$crate::command::CmdDef::<SignatureOf<$tool>>::named(self.$field.name().to_owned());names.extend([definition.ok_type(),definition.err_type()]);)*
                    let rejection=$crate::command::CmdDef::<$crate::agent::tool::RejectedSpec>::new();
                    names.extend([rejection.ok_type(),rejection.err_type()]);
                    names
                }
                pub fn update<'a,S:$crate::Tagged>(&self,cell:impl Fn(&S,&Messages<SignatureOf<$first>,$(SignatureOf<$tool>),*>)->$crate::Step<S,Commands<$first,$($tool),*>>+'a)->$crate::Update<'a,S,Messages<SignatureOf<$first>,$(SignatureOf<$tool>),*>,Commands<$first,$($tool),*>> {
                    let cell=std::rc::Rc::new(cell);let mut row:$crate::core::Row<'a,S,Messages<SignatureOf<$first>,$(SignatureOf<$tool>),*>,Commands<$first,$($tool),*>>=Default::default();
                    for name in self.settlement_types(){let cell=std::rc::Rc::clone(&cell);row.insert(name,Box::new(move|s,m|cell(s,m)));}
                    $crate::Update::raw_reducer(row)
                }
                pub fn interpreter(self:std::rc::Rc<Self>,host:std::rc::Rc<$first::Host>)->Interpreter<$first,$($tool),*>{Interpreter{router:self,host}}
                pub fn for_agent(self:std::rc::Rc<Self>,host:std::rc::Rc<$first::Host>)->AgentTools<$first,$($tool),*>{AgentTools{router:self,host}}
            }
            impl<$first:ToolDefinition<RawArgs=$crate::agent::PlainToolArgs>+'static,$($tool:ToolDefinition<Host=$first::Host,RawArgs=$crate::agent::PlainToolArgs>+'static),*> $crate::agent::DefinedAgentTools for Router<$first,$($tool),*>
            where $first::Host:'static {
                type Host=$first::Host;
                type Result=Results<SignatureOf<$first>,$(SignatureOf<$tool>),*>;
                type Error=Errors<SignatureOf<$first>,$(SignatureOf<$tool>),*>;
                type ContentError=ContentErrors<$first::ContentError,$($tool::ContentError),*>;
                type Command=Commands<$first,$($tool),*>;
                type Bound=AgentTools<$first,$($tool),*>;
                fn route(&self,call:&std::rc::Rc<$crate::agent::PlainToolCall>)->Result<Self::Command,$crate::agent::tool::ToolError>{self.tool_of_plain(call)}
                fn parts(&self,call:&$crate::agent::PlainToolCall,outcome:&$crate::agent::types::ToolOutcome<Self::Result,Self::Error>)->Result<Option<$crate::agent::content::Parts>,Self::ContentError>{self.parts_of_plain(call,outcome)}
                fn bind(self:std::rc::Rc<Self>,host:std::rc::Rc<Self::Host>)->Self::Bound{self.for_agent(host)}
                fn failure(&self,command:&Self::Command,completion:&<Self::Command as $crate::command::CommandFamily>::Completion)->Result<Option<$crate::agent::defined::DefinedToolFailure<Self::Error>>,$crate::agent::tool::ToolError>{
                    match(command,completion){
                        (Commands::$first(command),Completions::$first(completion))=>{
                            if let Some($crate::command::Outcome::Err{error})=completion.outcome(){Ok(Some($crate::agent::defined::DefinedToolFailure{context:$crate::agent::defined::ToolErrorContext{call_id:command.cmd().input().call_id.clone(),name:command.tool().name().into()},outcome:std::rc::Rc::new(Errors::$first($crate::agent::tool::snapshot_error(completion.tool().as_ref(),&$crate::command::Failure::Declared(error.clone()))?))}))}else{Ok(None)}
                        },
                        $((Commands::$tool(command),Completions::$tool(completion))=>{
                            if let Some($crate::command::Outcome::Err{error})=completion.outcome(){Ok(Some($crate::agent::defined::DefinedToolFailure{context:$crate::agent::defined::ToolErrorContext{call_id:command.cmd().input().call_id.clone(),name:command.tool().name().into()},outcome:std::rc::Rc::new(Errors::$tool($crate::agent::tool::snapshot_error(completion.tool().as_ref(),&$crate::command::Failure::Declared(error.clone()))?))}))}else{Ok(None)}
                        },)*
                        (Commands::Rejected(command),Completions::Rejected(completion))=>Ok($crate::agent::defined::rejected_tool_failure(command,completion)?.map(|(context,outcome)|$crate::agent::defined::DefinedToolFailure{context,outcome:std::rc::Rc::new(Errors::Rejected(outcome))})),
                        _=>Ok(None),
                    }
                }
            }
            pub struct Interpreter<$first:ToolDefinition,$($tool:ToolDefinition),*>{router:std::rc::Rc<Router<$first,$($tool),*>>,host:std::rc::Rc<$first::Host>}
            impl<$first:ToolDefinition,$($tool:ToolDefinition<Host=$first::Host,RawArgs=$first::RawArgs>),*> $crate::runtime::Interpreter<Commands<$first,$($tool),*>> for Interpreter<$first,$($tool),*> {
                type Error=$crate::agent::tool::ToolError;
                fn interpret<'s>(&'s self,cmd:&'s Commands<$first,$($tool),*>,ctx:$crate::runtime::CommandContext<<Commands<$first,$($tool),*> as $crate::command::CommandFamily>::Msg,Self::Error>)->Option<$crate::runtime::CommandWork<'s,<Commands<$first,$($tool),*> as $crate::command::CommandFamily>::Completion,Self::Error>>{
                    Some($crate::runtime::CommandWork::new(async move{self.router.interpret(cmd,$crate::agent::tool::ToolContext::runtime(self.host.as_ref(),&ctx)).await}))
                }
            }
            /// Retains the actual router and host for an Agent's outer message family.
            pub struct AgentTools<$first:ToolDefinition,$($tool:ToolDefinition),*>{router:std::rc::Rc<Router<$first,$($tool),*>>,host:std::rc::Rc<$first::Host>}
            impl<$first:ToolDefinition,$($tool:ToolDefinition<Host=$first::Host,RawArgs=$first::RawArgs>),*> $crate::agent::tool::AgentToolRoutes<Commands<$first,$($tool),*>,Results<SignatureOf<$first>,$(SignatureOf<$tool>),*>,Errors<SignatureOf<$first>,$(SignatureOf<$tool>),*>> for AgentTools<$first,$($tool),*> {
                fn settlement_types(&self)->Vec<String>{self.router.settlement_types()}
                fn outcome_of(&self,message:&Messages<SignatureOf<$first>,$(SignatureOf<$tool>),*>)->Result<Option<$crate::agent::tool::ToolSettlement<Results<SignatureOf<$first>,$(SignatureOf<$tool>),*>,Errors<SignatureOf<$first>,$(SignatureOf<$tool>),*>>>,$crate::command::CommandContractError>{self.router.outcome_of(message)}
                fn at(&self,message:&Messages<SignatureOf<$first>,$(SignatureOf<$tool>),*>)->Option<$crate::data::NumberOrNull>{match message{Messages::$first(m)=>m.at(),$(Messages::$tool(m)=>m.at(),)*Messages::Rejected(m)=>m.at()}}
            }
            impl<M,$first:ToolDefinition,$($tool:ToolDefinition<Host=$first::Host,RawArgs=$first::RawArgs>),*> $crate::runtime::Interpreter<Commands<$first,$($tool),*>,M> for AgentTools<$first,$($tool),*> {
                type Error=$crate::agent::AgentWorkError<$crate::agent::tool::ToolError>;
                fn interpret<'s>(&'s self,cmd:&'s Commands<$first,$($tool),*>,ctx:$crate::runtime::CommandContext<M,Self::Error>)->Option<$crate::runtime::CommandWork<'s,<Commands<$first,$($tool),*> as $crate::command::CommandFamily>::Completion,Self::Error>>{
                    let context=$crate::agent::tool::ToolContext::runtime(self.host.as_ref(),&ctx);
                    Some($crate::runtime::CommandWork::new(async move{self.router.interpret(cmd,context).await.map_err($crate::agent::AgentWorkError::Tool)}))
                }
            }
        }
    };
}
