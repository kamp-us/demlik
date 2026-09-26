import { useEffect, useRef } from "react";

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"]/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string,
  );
}

function fmtJson(obj: unknown, indent = 0): string {
  if (obj === null) return '<span class="tea-dt-b">null</span>';
  if (typeof obj === "number") return `<span class="tea-dt-n">${obj}</span>`;
  if (typeof obj === "boolean") return `<span class="tea-dt-b">${obj}</span>`;
  if (typeof obj === "string")
    return `<span class="tea-dt-s">"${escapeHtml(obj)}"</span>`;
  if (Array.isArray(obj)) {
    if (obj.length === 0) return '<span class="tea-dt-br">[]</span>';
    return (
      '<span class="tea-dt-br">[</span>' +
      obj
        .map((v) => fmtJson(v, indent + 1))
        .join('<span class="tea-dt-br">, </span>') +
      '<span class="tea-dt-br">]</span>'
    );
  }
  if (typeof obj === "object") {
    const keys = Object.keys(obj as object);
    if (keys.length === 0) return '<span class="tea-dt-br">{}</span>';
    const pad = "&nbsp;&nbsp;".repeat(indent + 1);
    const lines = keys.map((k, i) => {
      const v = (obj as Record<string, unknown>)[k];
      const comma =
        i < keys.length - 1 ? '<span class="tea-dt-br">,</span>' : "";
      return `${pad}<span class="tea-dt-k">${escapeHtml(k)}</span><span class="tea-dt-br">:</span> ${fmtJson(v, indent + 1)}${comma}`;
    });
    return [
      '<span class="tea-dt-br">{</span>',
      ...lines,
      `${"&nbsp;&nbsp;".repeat(indent)}<span class="tea-dt-br">}</span>`,
    ].join("<br/>");
  }
  return escapeHtml(String(obj));
}

export interface StateInspectorProps {
  /**
   * The machine state to display. Render-derived shape — pass whatever you
   * want surfaced to the inspector (often a hand-picked subset of the model).
   */
  state: unknown;
  /**
   * When this number changes, the inspector flashes. Pass `model.msgCount` or
   * any other monotonic counter you already have. Omit to disable flashing.
   */
  flashKey?: number;
  /**
   * Optional className appended to the container. Use to override layout.
   */
  className?: string;
}

export function StateInspector({
  state,
  flashKey,
  className,
}: StateInspectorProps) {
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (flashKey === undefined || !boxRef.current) return;
    boxRef.current.classList.remove("tea-dt-flash");
    void boxRef.current.offsetWidth;
    boxRef.current.classList.add("tea-dt-flash");
  }, [flashKey]);

  return (
    <div
      ref={boxRef}
      className={`tea-dt-state${className ? ` ${className}` : ""}`}
    >
      <div
        className="tea-dt-json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: formatter output
        dangerouslySetInnerHTML={{ __html: fmtJson(state) }}
      />
    </div>
  );
}
