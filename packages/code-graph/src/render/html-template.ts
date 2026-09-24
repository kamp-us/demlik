import type { Graph } from "../schema.js";
import { type HtmlModel, SEVERITY_COLOR, type Severity, type Summary } from "./html-model.js";
import { stableStringify } from "./json.js";

const D3_CDN = "https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js";
const CYTOSCAPE_CDN = "https://cdn.jsdelivr.net/npm/cytoscape@3.30.2/dist/cytoscape.min.js";
const FCOSE_DEPS = [
  "https://cdn.jsdelivr.net/npm/layout-base@2.0.1/layout-base.min.js",
  "https://cdn.jsdelivr.net/npm/cose-base@2.2.0/cose-base.min.js",
  "https://cdn.jsdelivr.net/npm/cytoscape-fcose@2.2.0/cytoscape-fcose.min.js",
];

const HEALTH_SEVERITY: Record<Summary["health"], Severity> = {
  healthy: "none",
  rough: "warn",
  rotten: "high",
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function cdnScriptTags(): string {
  return [D3_CDN, CYTOSCAPE_CDN, ...FCOSE_DEPS]
    .map((src) => `  <script src="${src}"></script>`)
    .join("\n");
}

const STYLE = `<style>
  :root {
    --none: ${SEVERITY_COLOR.none};
    --warn: ${SEVERITY_COLOR.warn};
    --high: ${SEVERITY_COLOR.high};
    --bg: #0f1115; --panel: #181b22; --ink: #e7e9ee; --muted: #9aa1ad; --line: #2a2f3a;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink);
    font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
  header { padding: 20px 28px; border-bottom: 1px solid var(--line); }
  header h1 { margin: 0 0 6px; font-size: 18px; font-weight: 650; }
  .chip { display: inline-block; padding: 2px 10px; border-radius: 999px;
    color: #0b0d10; font-weight: 700; text-transform: uppercase; font-size: 11px; letter-spacing: .04em; }
  .meta { color: var(--muted); font-size: 13px; }
  section { padding: 20px 28px; border-bottom: 1px solid var(--line); }
  section h2 { margin: 0 0 12px; font-size: 14px; text-transform: uppercase;
    letter-spacing: .06em; color: var(--muted); }
  #treemap { width: 100%; height: 460px; }
  #treemap rect { stroke: var(--bg); stroke-width: 1px; cursor: pointer; }
  #treemap text { fill: #0b0d10; font-size: 11px; pointer-events: none; }
  #cy { width: 100%; height: 520px; background: var(--panel); border: 1px solid var(--line);
    border-radius: 8px; }
  #panel { margin-top: 12px; min-height: 22px; color: var(--muted); font-size: 13px;
    white-space: pre-wrap; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .hidden-note { color: var(--muted); font-size: 13px; margin-top: 8px; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--line); }
  th { cursor: pointer; user-select: none; color: var(--muted); font-weight: 600;
    text-transform: uppercase; font-size: 11px; letter-spacing: .04em; }
  th:hover { color: var(--ink); }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  tr.row-high td:first-child { border-left: 3px solid var(--high); }
  tr.row-warn td:first-child { border-left: 3px solid var(--warn); }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  footer { padding: 16px 28px; color: var(--muted); font-size: 12px; }
  .tip { position: fixed; pointer-events: none; background: #000d; color: var(--ink);
    padding: 6px 8px; border-radius: 6px; font-size: 12px; max-width: 320px; display: none;
    border: 1px solid var(--line); z-index: 10; }
</style>`;

function bodyMarkup(graph: Graph, summary: Summary, chip: string): string {
  const root = escapeHtml(graph.root || ".");
  return `<header>
  <h1>${root} &middot;
    <span class="chip" style="background:${chip}">${summary.health}</span></h1>
  <div class="meta">
    ${summary.fileCount} files &middot; ${summary.functionCount} fns &middot;
    ${summary.smellCount} smells (${summary.highSeverityCount} high)
    &middot; worst fn: <code>${escapeHtml(summary.worstFunction ?? "-")}</code>
    &middot; worst file: <code>${escapeHtml(summary.worstFile ?? "-")}</code>
  </div>
</header>

<section>
  <h2>Hotspot treemap</h2>
  <svg id="treemap" role="img" aria-label="File hotspot treemap sized by lines of code, colored by worst smell severity"></svg>
</section>

<section>
  <h2>Hub call graph</h2>
  <div id="cy" role="img" aria-label="Hub call graph: nodes are hubs and smelly functions, sized by fan-in"></div>
  <div id="panel">Click a node for its coordinates and smells.</div>
  <div class="hidden-note" id="hidden-note"></div>
</section>

<section>
  <h2>Top targets</h2>
  <table id="targets">
    <thead><tr>
      <th data-key="rank" data-type="num">#</th>
      <th data-key="id" data-type="str">id</th>
      <th data-key="file" data-type="str">file:line</th>
      <th data-key="loc" data-type="num">loc</th>
      <th data-key="complexity" data-type="num">cx</th>
      <th data-key="fanIn" data-type="num">fanIn</th>
      <th data-key="smells" data-type="num">smells</th>
      <th data-key="score" data-type="num">score</th>
    </tr></thead>
    <tbody></tbody>
  </table>
</section>

<footer>
  Generated by <code>code-graph --html</code>. The data is deterministic (sorted, SPEC §3);
  only the call-graph layout (fcose) varies run-to-run -- pixel positions are not part of the data.
  Libraries load from CDN, so first open needs a network connection.
</footer>

<div class="tip" id="tip"></div>`;
}

const CLIENT_SCRIPT = `
const COLOR = { none: getComputedStyle(document.documentElement).getPropertyValue('--none').trim(),
  warn: getComputedStyle(document.documentElement).getPropertyValue('--warn').trim(),
  high: getComputedStyle(document.documentElement).getPropertyValue('--high').trim() };

const tip = document.getElementById('tip');
function showTip(html, x, y) { tip.innerHTML = html; tip.style.display = 'block';
  tip.style.left = (x + 12) + 'px'; tip.style.top = (y + 12) + 'px'; }
function hideTip() { tip.style.display = 'none'; }

function drawTreemap() {
  const svg = document.getElementById('treemap');
  const w = svg.clientWidth || 900, h = 460;
  svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
  const root = d3.hierarchy(DATA.treemap)
    .sum(d => d.loc || 0)
    .sort((a, b) => (b.value || 0) - (a.value || 0));
  d3.treemap().size([w, h]).paddingInner(1).paddingTop(0)(root);
  const sel = d3.select(svg);
  const leaves = sel.selectAll('g').data(root.leaves()).join('g')
    .attr('transform', d => 'translate(' + d.x0 + ',' + d.y0 + ')');
  leaves.append('rect')
    .attr('width', d => Math.max(0, d.x1 - d.x0))
    .attr('height', d => Math.max(0, d.y1 - d.y0))
    .attr('fill', d => COLOR[d.data.severity || 'none'])
    .on('mousemove', (e, d) => showTip(
      '<b>' + d.data.file + '</b><br>loc ' + (d.data.loc || 0) +
      '<br>smells: ' + ((d.data.smellKinds || []).join(', ') || 'none'), e.clientX, e.clientY))
    .on('mouseleave', hideTip)
    .on('click', (e, d) => filterTargets(d.data.file));
  leaves.append('text').attr('x', 4).attr('y', 14)
    .text(d => (d.x1 - d.x0 > 46 && d.y1 - d.y0 > 16) ? d.data.name : '');
}

function drawGraph() {
  const maxFan = Math.max(1, ...DATA.graph.nodes.map(n => n.fanIn || 0));
  const els = [
    ...DATA.graph.nodes.map(n => ({ data: { ...n, size: 18 + 42 * (n.fanIn / maxFan) } })),
    ...DATA.graph.edges.map(e => ({ data: e })),
  ];
  const cy = cytoscape({
    container: document.getElementById('cy'),
    elements: els,
    style: [
      { selector: 'node', style: {
        'background-color': n => COLOR[n.data('severity') || 'none'],
        'width': 'data(size)', 'height': 'data(size)',
        'label': 'data(label)', 'font-size': 9, 'color': '#e7e9ee',
        'text-valign': 'bottom', 'text-margin-y': 2, 'opacity': n => n.data('hidden') ? 0.45 : 1 } },
      { selector: 'edge', style: {
        'width': 1, 'line-color': '#3a4150', 'target-arrow-color': '#3a4150',
        'target-arrow-shape': 'triangle', 'curve-style': 'bezier', 'arrow-scale': 0.7 } },
    ],
  });
  try { cy.layout({ name: 'fcose', animate: false, quality: 'default' }).run(); }
  catch (_) { cy.layout({ name: 'cose', animate: false }).run(); }
  cy.on('tap', 'node', (e) => {
    const d = e.target.data();
    document.getElementById('panel').textContent =
      d.id + '\\n' + d.file + ':' + d.startLine + '-' + d.endLine +
      '\\nloc=' + d.loc + ' cx=' + d.complexity + ' fanIn=' + d.fanIn +
      ' chain=' + d.callChainDepth +
      '\\nsmells: ' + ((d.smellKinds || []).join(', ') || 'none');
  });
  document.getElementById('hidden-note').textContent =
    DATA.graph.hiddenCount + ' functions hidden (no smell, not a hub, not a neighbor).';
}

let sortKey = 'rank', sortDir = 1, activeFilter = null;
function severityClass(row) {
  if (row.smells.some(s => s.severity === 'high')) return 'row-high';
  if (row.smells.length) return 'row-warn';
  return '';
}
function rowValue(row, key, rank) {
  switch (key) {
    case 'rank': return rank;
    case 'fanIn': return row.calledByCount == null ? -1 : row.calledByCount;
    case 'smells': return row.components.smells;
    case 'id': return row.id;
    case 'file': return row.file + ':' + row.startLine;
    default: return row[key];
  }
}
function renderTable(filterFile) {
  const tbody = document.querySelector('#targets tbody');
  const ranked = DATA.plan.map((row, i) => ({ row, rank: i + 1 }));
  let rows = filterFile ? ranked.filter(r => r.row.file === filterFile) : ranked;
  rows = rows.slice().sort((a, b) => {
    const av = rowValue(a.row, sortKey, a.rank), bv = rowValue(b.row, sortKey, b.rank);
    if (typeof av === 'string') return sortDir * av.localeCompare(bv);
    return sortDir * (av - bv);
  });
  tbody.innerHTML = rows.map(({ row, rank }) =>
    '<tr class="' + severityClass(row) + '"><td class="num">' + rank + '</td>' +
    '<td><code>' + row.id + '</code></td>' +
    '<td><code>' + row.file + ':' + row.startLine + '</code></td>' +
    '<td class="num">' + row.loc + '</td>' +
    '<td class="num">' + row.complexity + '</td>' +
    '<td class="num">' + (row.calledByCount == null ? '-' : row.calledByCount) + '</td>' +
    '<td class="num">' + row.components.smells + '</td>' +
    '<td class="num">' + row.score + '</td></tr>').join('');
}
function filterTargets(file) {
  activeFilter = activeFilter === file ? null : file;
  renderTable(activeFilter);
  document.getElementById('targets').scrollIntoView({ behavior: 'smooth' });
}
function wireSort() {
  document.querySelectorAll('#targets th').forEach(th => th.addEventListener('click', () => {
    const key = th.dataset.key;
    if (key === sortKey) sortDir = -sortDir; else { sortKey = key; sortDir = 1; }
    renderTable(activeFilter);
  }));
}
function boot() { drawTreemap(); drawGraph(); wireSort(); renderTable(null); }
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();`;

export function renderPage(graph: Graph, model: HtmlModel): string {
  const data = stableStringify(model, false);
  const chip = SEVERITY_COLOR[HEALTH_SEVERITY[model.summary.health]];
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>code-graph -- ${escapeHtml(graph.root || ".")}</title>
${cdnScriptTags()}
${STYLE}
</head>
<body>
${bodyMarkup(graph, model.summary, chip)}

<script>
const DATA = ${data};
${CLIENT_SCRIPT}
</script>
</body>
</html>
`;
}
