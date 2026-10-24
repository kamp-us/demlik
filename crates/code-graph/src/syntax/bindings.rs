use super::NodeRef;

pub fn pattern_names(pattern: Option<NodeRef<'_>>) -> Vec<String> {
    let Some(pattern) = pattern else {
        return Vec::new();
    };
    match pattern.kind() {
        "Identifier" => pattern
            .string("name")
            .map(str::to_owned)
            .into_iter()
            .collect(),
        "AssignmentPattern" => pattern_names(pattern.node("left")),
        "RestElement" => pattern_names(pattern.node("argument")),
        "TSParameterProperty" => pattern_names(pattern.node("parameter")),
        "Property" => pattern_names(pattern.node("value")),
        "ObjectPattern" => pattern
            .nodes("properties")
            .into_iter()
            .flat_map(|property| pattern_names(Some(property)))
            .collect(),
        "ArrayPattern" => pattern
            .nodes("elements")
            .into_iter()
            .flat_map(|element| pattern_names(Some(element)))
            .collect(),
        _ => Vec::new(),
    }
}
