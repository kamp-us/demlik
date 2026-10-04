/** One row of the `MsgLog`: a timestamp, a category and the text to show. */
export type MsgLogEntry = {
  /** Display timestamp (whatever format you produced). */
  ts: string;
  /** Visual category — drives the row icon. Defaults to "msg" via CSS. */
  kind?: "msg" | "sub" | "cmd" | "ok" | "fail";
  /** Row text — usually the Msg tag plus a short detail. */
  text: string;
};

/** Props for `MsgLog`: the rows to render and an optional `className`. */
export interface MsgLogProps {
  history: readonly MsgLogEntry[];
  className?: string;
}

/**
 * React component that renders a list of `MsgLogEntry` rows as a message log.
 */
export function MsgLog({ history, className }: MsgLogProps) {
  return (
    <div className={`tea-dt-log${className ? ` ${className}` : ""}`}>
      {history.map((r, i) => (
        <div
          key={`${r.ts}-${i}`}
          className={`tea-dt-row tea-dt-${r.kind ?? "msg"}`}
        >
          <span className="tea-dt-t">{r.ts}</span>
          <span className="tea-dt-m">{r.text}</span>
        </div>
      ))}
    </div>
  );
}
