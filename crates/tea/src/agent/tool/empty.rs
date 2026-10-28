use super::*;

/// The zero-tool table still owns the router's normal unknown-tool command.
#[derive(Default)]
pub struct EmptyRouter;
impl EmptyRouter {
    pub fn new() -> Result<Self, ToolError> {
        Ok(Self)
    }
    pub fn tool_of<A>(&self, call: &ToolCall<A>) -> Result<Cmd<RejectedSpec>, ToolError> {
        Ok(rejected(
            call.call_id.clone(),
            ToolRejection::UnknownTool {
                name: call.name.clone(),
            },
        ))
    }
    pub async fn interpret(
        &self,
        command: &Cmd<RejectedSpec>,
    ) -> Result<command::Completion<RejectedSpec>, ToolError> {
        if command.tag() != REJECTED_TYPE {
            return Err(CommandContractError::mismatched(command.tag(), REJECTED_TYPE).into());
        }
        Ok(Some(Outcome::err(command.input().error.clone())))
    }
    pub fn outcome_of(
        &self,
        message: &Settled<RejectedSpec>,
    ) -> Result<Option<ToolSettlement<(), FailureOf<RejectedSpec>>>, CommandContractError> {
        if !matches!(message.tag(), "tool_rejected_ok" | "tool_rejected_err") {
            return Ok(None);
        }
        let outcome = match message.outcome() {
            command::Settlement::Ok(()) => ToolOutcome::Ok(Rc::new(())),
            command::Settlement::Err(error) => ToolOutcome::Error(Rc::new(rejected_error(error)?)),
        };
        Ok(Some(ToolSettlement {
            call_id: message.cmd().input().call_id.clone(),
            outcome,
        }))
    }
    pub fn resilience_of<A>(&self, _: &ToolCall<A>) -> Option<&ToolResilience> {
        None
    }
    pub fn parts_of<A, R, E>(
        &self,
        _: &ToolCall<A>,
        _: &ToolOutcome<R, E>,
    ) -> Result<Option<Parts>, Infallible> {
        Ok(None)
    }
    /// Rejection remains a normal command family even with no configured tools.
    pub fn settlement_types(&self) -> Vec<String> {
        let rejection = CmdDef::<RejectedSpec>::new();
        vec![rejection.ok_type(), rejection.err_type()]
    }
    pub fn update<'a, S: Tagged>(
        &self,
        cell: impl Fn(&S, &Settled<RejectedSpec>) -> crate::Step<S, Cmd<RejectedSpec>> + 'a,
    ) -> crate::Update<'a, S, Settled<RejectedSpec>, Cmd<RejectedSpec>> {
        let cell = Rc::new(cell);
        let mut row: crate::core::Row<'a, S, Settled<RejectedSpec>, Cmd<RejectedSpec>> =
            Default::default();
        for name in self.settlement_types() {
            let cell = Rc::clone(&cell);
            row.insert(name, Box::new(move |state, message| cell(state, message)));
        }
        crate::Update::raw_reducer(row)
    }
    pub fn interpreter(&self) -> EmptyInterpreter {
        EmptyInterpreter
    }
}
pub struct EmptyInterpreter;
impl runtime::Interpreter<Cmd<RejectedSpec>> for EmptyInterpreter {
    type Error = ToolError;
    fn interpret<'s>(
        &'s self,
        cmd: &'s Cmd<RejectedSpec>,
        _: runtime::CommandContext<Settled<RejectedSpec>, ToolError>,
    ) -> Option<runtime::CommandWork<'s, command::Completion<RejectedSpec>, ToolError>> {
        Some(runtime::CommandWork::new(async move {
            EmptyRouter.interpret(cmd).await
        }))
    }
}
