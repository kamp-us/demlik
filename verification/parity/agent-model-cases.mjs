export function agentModelCases() {
  const result = [],
    add = (id, input, operation = "scenario") =>
      result.push({ id: `agent-model.${id}`, operation, input });
  for (const style of ["factory", "plain", "wrapped"]) {
    for (const noLoader of [false, true])
      for (const transform of [false, true])
        for (const validateModel of style === "factory"
          ? [false, true]
          : [false])
          add(
            `${style}-${noLoader ? "empty" : "loaded"}-${transform ? "transform" : "identity"}-${validateModel ? "validated" : "raw"}`,
            { style, noLoader, transform, validateModel },
          );
    for (const failure of [
      "loader",
      "invoke",
      "parse1",
      ...(style === "factory" ? ["factory", "bind"] : []),
    ]) {
      add(`${style}-failure-${failure}`, { style, failure });
      add(`${style}-undefined-${failure}`, {
        style,
        failure,
        undefinedCause: true,
      });
    }
    add(`${style}-second-parse-failure`, {
      style,
      failure: "parse2",
      validateModel: style === "factory",
    });
    add(`${style}-second-schema`, {
      style,
      transform: true,
      differentSchema: true,
    });
    add(`${style}-fresh-empty-repeated`, { style, noLoader: true, repeats: 3 });
    add(`${style}-shared-loaded-repeated`, { style, repeats: 2 });
    add(`${style}-unicode`, {
      style,
      purpose: "目的\ud800",
      key: "call\udfff",
      model: "model\ud800",
      reason: "cause\ud800",
      failure: "invoke",
    });
  }
  for (const profile of ["promise", "effect"])
    for (const style of ["factory", "plain", "wrapped"]) {
      for (const failure of [
        undefined,
        "invoke",
        "loader",
        "parse1",
        "parse2",
      ]) {
        add(
          `${profile}-${style}-${failure ?? "success"}`,
          {
            style,
            transform: true,
            ...(failure ? { failure } : {}),
            validateModel: style === "factory" && failure === "parse2",
          },
          `runtime-${profile}`,
        );
      }
      add(
        `${profile}-${style}-unicode-undefined`,
        {
          style,
          reason: "\ud800",
          purpose: "call\ud800",
          model: "id\udfff",
          key: "job",
          failure: "invoke",
          undefinedCause: true,
        },
        `runtime-${profile}`,
      );
    }
  add("vocabulary", {}, "vocabulary");
  return result;
}
