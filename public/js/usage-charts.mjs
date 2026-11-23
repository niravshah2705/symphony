// Pure chart builders for the Usage page.
//
// They return plain `{tag, attrs, children}` specs instead of DOM nodes so the
// geometry is testable without a browser, and so `mount()` is the only place that
// touches the document. Nothing here ever produces markup from data: `mount` sets
// attributes and text nodes, and there is no `html`/innerHTML path at all — a
// project id or a credit-pack name is attacker-reachable text and must not be able
// to open a tag.

const SVG_TAGS = new Set([
  'svg', 'g', 'rect', 'path', 'line', 'circle', 'polyline', 'text', 'tspan', 'title', 'defs', 'linearGradient', 'stop',
]);

const WEEKDAY_LABELS = ['Mon', '', 'Wed', '', 'Fri', '', ''];
const CELL_STEP_PX = 13;

/** Mount a spec (or a string / DOM node) under `parent` and return the node. */
export function mount(spec, parent) {
  const node = build(spec);
  if (parent) parent.append(node);
  return node;
}

function build(spec) {
  if (spec === null || spec === undefined || spec === false) {
    return document.createTextNode('');
  }
  if (typeof spec === 'string' || typeof spec === 'number') return document.createTextNode(String(spec));
  if (spec.nodeType) return spec;
  const { tag, attrs = {}, children = [] } = spec;
  // SVG needs its namespace: created with the HTML factory it exists in the DOM
  // and draws nothing, which is the failure mode this module exists to avoid.
  const node = SVG_TAGS.has(tag)
    ? document.createElementNS('http://www.w3.org/2000/svg', tag)
    : document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.setAttribute('class', value);
    else node.setAttribute(key, String(value));
  }
  for (const child of (Array.isArray(children) ? children : [children])) {
    if (child === null || child === undefined || child === false) continue;
    node.append(build(child));
  }
  return node;
}

const numberOr = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);

/**
 * A number, or `null` — and `null` is not 0.
 *
 * `Number(null)` is 0, which is exactly the confusion this page has to avoid: an
 * unreadable day drawn at zero tells the org it used nothing, when the truth is
 * that the read failed.
 */
const plainNumber = (value) => (
  value === null || value === undefined || !Number.isFinite(Number(value)) ? null : Number(value)
);

/**
 * Quantile levels 0..4 over the readable cells, so the legend means "this
 * org's own busiest days" rather than an absolute threshold that would colour a
 * small account entirely in the lightest shade.
 *
 * `null` (unreadable) is not a low number: it gets no level, and the caller draws
 * it as an empty cell with its own title.
 */
export function heatmapLevels(days) {
  const values = days.map((d) => d.tokenCredits).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!values.length) return () => null;
  // Zero is its own level: "nothing used" must be visually distinct from "a
  // little", and a quantile over all values would blur them together.
  const positive = values.filter((v) => v > 0);
  if (!positive.length) return (tokenCredits) => (Number.isFinite(tokenCredits) && tokenCredits === 0 ? 0 : null);
  const cuts = [1, 2, 3, 4].map((q) => positive[Math.min(positive.length - 1, Math.floor((positive.length * q) / 5))]);
  return (tokenCredits) => {
    if (!Number.isFinite(tokenCredits)) return null;
    if (tokenCredits === 0) return 0;
    for (let level = 0; level < cuts.length; level += 1) if (tokenCredits <= cuts[level]) return level + 1;
    return 5 - 1;
  };
}

/**
 * The 13x7 consumption grid, column-major (FlexPrice answers newest day last).
 *
 * Column 0 is the oldest week; each column holds 7 days Monday-first, matching
 * GitHub's convention and the mock's Mon/Wed/Fri rail.
 */
export function heatmapSpec(days, { weeks = 13, todayIso = null } = {}) {
  const cells = days.slice(-weeks * 7);
  const levelOf = heatmapLevels(cells);
  const columns = [];
  for (let week = 0; week * 7 < cells.length; week += 1) {
    const column = [];
    for (let dow = 0; dow < 7; dow += 1) {
      const cell = cells[week * 7 + dow];
      if (!cell) {
        // A trailing hole keeps the grid rectangular; it is drawn as an absent
        // day rather than as a zero, so it cannot be misread as "no usage".
        column.push({ tag: 'rect', attrs: { class: 'usage-cell usage-cell-pad', x: week * CELL_STEP_PX, y: dow * CELL_STEP_PX, width: 11, height: 11, rx: 2 } });
        continue;
      }
      const level = levelOf(cell.tokenCredits);
      const future = Boolean(todayIso) && cell.date > todayIso;
      column.push({
        tag: 'rect',
        attrs: {
          class: [
            'usage-cell',
            level === null ? 'usage-cell-unknown' : `usage-cell-l${level}`,
            future ? 'usage-cell-future' : null,
            cell.date === todayIso ? 'usage-cell-today' : null,
          ].filter(Boolean).join(' '),
          x: week * CELL_STEP_PX,
          y: dow * CELL_STEP_PX,
          width: 11,
          height: 11,
          rx: 2,
          'data-date': cell.date,
          role: 'img',
          'aria-label': `${cell.date}: ${cell.credits === null ? 'no data' : `${cell.credits} credits`}`,
        },
      });
    }
    columns.push({ tag: 'g', attrs: { class: 'usage-cell-column' }, children: column });
  }

  const width = Math.max(1, Math.ceil(cells.length / 7)) * CELL_STEP_PX;
  const height = 7 * CELL_STEP_PX;
  return {
    tag: 'div',
    attrs: { class: 'usage-heatmap' },
    children: [
      {
        tag: 'div',
        attrs: { class: 'usage-heatmap-grid' },
        children: [
          {
            tag: 'svg',
            attrs: { class: 'usage-svg usage-heatmap-svg', viewBox: `0 0 ${width} ${height}`, width, height, role: 'img', 'aria-label': 'Daily credit consumption' },
            children: columns,
          },
        ],
      },
      {
        tag: 'div',
        attrs: { class: 'usage-weekday-labels', 'aria-hidden': 'true' },
        children: WEEKDAY_LABELS.map((label, index) => el_spec('span', { class: `usage-weekday usage-weekday-${index}` }, label || ' ')),
      },
      legendSpec(),
    ],
  };
}

function el_spec(tag, attrs, child) {
  return { tag, attrs, children: child === undefined || child === '' ? [] : [child] };
}

function legendSpec() {
  return {
    tag: 'div',
    attrs: { class: 'usage-legend' },
    children: [
      el_spec('span', { class: 'usage-legend-label' }, 'Less'),
      ...[0, 1, 2, 3, 4].map((level) => el_spec('span', { class: `usage-legend-cell usage-cell-l${level}` })),
      el_spec('span', { class: 'usage-legend-label' }, 'More'),
    ],
  };
}

/**
 * Catmull-Rom through the given points, emitted as cubic béziers.
 *
 * Pure numbers in, path string out: the smoothing is the part a browser cannot
 * tell us about, and a wrong `C` segment shows up as a loop in the line rather
 * than as a failed assertion — hence the test on the coordinates themselves.
 */
export function splinePath(points, { yOf = (p) => p.y, xOf = (p) => p.x } = {}) {
  const pts = points.map((p) => ({ x: xOf(p), y: yOf(p) }));
  if (pts.length === 0) return '';
  if (pts.length === 1) return `M ${round(pts[0].x)} ${round(pts[0].y)}`;
  let d = `M ${round(pts[0].x)} ${round(pts[0].y)}`;
  for (let i = 0; i < pts.length - 1; i += 1) {
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || p2;
    d += ` C ${round(p1.x + (p2.x - p0.x) / 6)} ${round(p1.y + (p2.y - p0.y) / 6)}`
      + ` ${round(p2.x - (p3.x - p1.x) / 6)} ${round(p2.y - (p3.y - p1.y) / 6)}`
      + ` ${round(p2.x)} ${round(p2.y)}`;
  }
  return d;
}

const round = (value) => Math.round(numberOr(value, 0) * 100) / 100;

/**
 * The trend line for one window.
 *
 * A day with no data is skipped, never drawn as zero: a gap in a line reads as
 * "usage dropped", while a missing read means we do not know. When FlexPrice
 * answers with no buckets at all, `points` is empty and the caller shows the
 * notice instead of this chart.
 */
export function trendSpec(points, {
  width = 720,
  height = 220,
  // Credits, not tokenCredits: the axis is read by a customer, and the route already
  // did the money conversion. (Deliberately not named `valueOf`: a binding with
  // that name is looked up as the intrinsic before it is called as a function.)
  creditValueOf = (p) => (p.credits === null || p.credits === undefined ? null : Number(p.credits)),
  labelOf = (p) => p.date,
} = {}) {
  const pad = { top: 14, right: 12, bottom: 26, left: 44 };
  const usableW = Math.max(1, width - pad.left - pad.right);
  const usableH = Math.max(1, height - pad.top - pad.bottom);
  const series = points
    .map((point, index) => ({ index, label: labelOf(point), value: plainNumber(creditValueOf(point)) }))
    .filter((point) => point.value !== null && point.value >= 0);
  const max = Math.max(0, ...series.map((p) => p.value));
  const scale = max > 0 ? max : 1;
  const xOf = (p) => pad.left + (series.length === 1 ? usableW / 2 : (p.index / Math.max(1, series.length - 1)) * usableW);
  const yOf = (p) => pad.top + usableH - (p.value / scale) * usableH;
  const coords = series.map((p) => ({ x: xOf(p), y: yOf(p), value: p.value, label: p.label }));
  const baseline = pad.top + usableH;
  const line = splinePath(coords);
  const peak = coords.reduce((best, p) => (!best || p.value > best.value ? p : best), null);
  const gridlines = [0, 0.25, 0.5, 0.75, 1].map((ratio) => ({
    y: pad.top + usableH - ratio * usableH,
    label: formatCompact(ratio * scale),
  }));

  return {
    tag: 'div',
    attrs: { class: 'usage-trend' },
    children: [
      {
        tag: 'svg',
        attrs: { class: 'usage-svg usage-trend-svg', viewBox: `0 0 ${width} ${height}`, width, height, role: 'img', 'aria-label': 'Credit consumption trend' },
        children: [
          {
            tag: 'defs',
            children: [{
              tag: 'linearGradient',
              attrs: { id: 'usage-trend-fill', x1: '0', y1: '0', x2: '0', y2: '1' },
              children: [
                { tag: 'stop', attrs: { offset: '0%', 'stop-color': 'var(--accent)', 'stop-opacity': '0.28' } },
                { tag: 'stop', attrs: { offset: '100%', 'stop-color': 'var(--accent)', 'stop-opacity': '0' } },
              ],
            }],
          },
          ...gridlines.map((grid) => ({
            tag: 'g',
            attrs: { class: 'usage-gridline' },
            children: [
              { tag: 'line', attrs: { x1: pad.left, x2: width - pad.right, y1: grid.y, y2: grid.y, class: 'usage-grid-line' } },
              { tag: 'text', attrs: { x: pad.left - 8, y: grid.y + 4, class: 'usage-axis-label', 'text-anchor': 'end' }, children: [grid.label] },
            ],
          })),
          coords.length > 1 && {
            tag: 'path',
            attrs: {
              class: 'usage-trend-area',
              d: `${line} L ${round(coords[coords.length - 1].x)} ${round(baseline)} L ${round(coords[0].x)} ${round(baseline)} Z`,
              fill: 'url(#usage-trend-fill)',
            },
          },
          coords.length > 0 && { tag: 'path', attrs: { class: 'usage-trend-line', d: line, fill: 'none' } },
          peak && { tag: 'circle', attrs: { class: 'usage-trend-peak', cx: round(peak.x), cy: round(peak.y), r: 4 } },
          // Only the ends and the peak are labelled: every day named would be a
          // wall of text on a 30-point window.
          ...[coords[0], coords[coords.length - 1]].filter(Boolean).map((p) => ({
            tag: 'text',
            attrs: { x: round(p.x), y: height - 8, class: 'usage-axis-label', 'text-anchor': 'middle' },
            children: [p.label],
          })),
        ].filter(Boolean),
      },
    ],
  };
}

/** A y-axis in credits, compact: 1,240 as "1.2k" so the label never wraps. */
export function formatCompact(value) {
  const amount = numberOr(value, 0);
  if (Math.abs(amount) >= 1_000_000) return `${round(amount / 1_000_000)}M`;
  if (Math.abs(amount) >= 1_000) return `${round(amount / 1_000)}k`;
  return String(round(amount));
}

export const CHART_GEOMETRY = Object.freeze({ CELL_STEP_PX, WEEKDAY_LABELS });
