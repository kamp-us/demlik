use crate::syntax::file::{NodeRef, SyntaxFile};

fn form_of(statement: NodeRef<'_>) -> Option<&'static str> {
    match statement.kind() {
        "ExportAllDeclaration" => Some("export *"),
        "ExportDefaultDeclaration" => Some("export default"),
        "ExportNamedDeclaration" => {
            if let Some(declaration) = statement.node("declaration") {
                form_of(declaration)
            } else if statement.node("source").is_none() {
                Some("local export")
            } else if statement.nodes("specifiers").is_empty() {
                Some("statement")
            } else {
                None
            }
        }
        "ImportDeclaration" => Some("import"),
        "VariableDeclaration"
        | "FunctionDeclaration"
        | "ClassDeclaration"
        | "TSTypeAliasDeclaration"
        | "TSInterfaceDeclaration"
        | "TSEnumDeclaration" => Some("declaration"),
        _ => Some("statement"),
    }
}

pub fn first_offending_form(syntax: &SyntaxFile) -> Option<&'static str> {
    syntax.root().nodes("body").into_iter().find_map(form_of)
}
