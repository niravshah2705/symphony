import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mount,
  heatmapSpec,
  trendSpec,
  splinePath,
  heatmapLevels,
  formatCompact,
  CHART_GEOMETRY,
} from './usage-charts.mjs';

const CELL = CHART_GEOMETRY.CELL_STEP_PX;

const days = (count, { start = '2026-08-22', every = 1 } = {}) => {
  const first = Date.parse(`${start}T00:00:00.000Z`);
  return Array.from({ length: count }, (_, index) => {
    const ms = first + index * every * 86400000;
    return { date: new Date(ms).toISOString().slice(0, 10), tokenCredits: null, credits: null };
  });
};

const withValues = (list, values) => list.map((day, index) => ({
  ...day,
  tokenCredits: values[index] ?? null,
  // The wire shape: the route sends credits as a fixed two-decimal string.
  credits: values[index] === null || values[index] === undefined ? null : (values[index] / 100).toFixed(2),
}));

/** Walk a spec tree, collecting every attribute key. */
function attributeKeys(node, into = []) {
  if (!node || typeof node !== 'object') return into;
  if (node.attrs) into.push(...Object.keys(node.attrs));
  for (const child of (Array.isArray(node.children) ? node.children : [])) attributeKeys(child.tag ? child : null, into);
  return into;
}

test('a chart spec never carries an html attribute', () => {
  // The XSS rule for this page is structural: values like a credit-pack name or a
  // project id are text, and nothing in the tree may be able to open a tag.
  const spec = heatmapSpec(withValues(days(91), Array.from({ length: 91 }, (_, i) => i * 100)), { todayIso: '2026-11-20' });
  const trend = trendSpec(withValues(days(30), Array.from({ length: 30 }, (_, i) => (i % 7) * 5000)));
  for (const node of [spec, trend]) {
    assert.equal(attributeKeys(node).includes('html'), false);
  }
  const classes = [];
  (function walk(node) {
    if (node?.attrs?.class) classes.push(node.attrs.class);
    for (const child of (node?.children || [])) walk(child);
  })(spec);
  assert.ok(classes.some((c) => c.includes('usage-cell-l4')), 'the busiest quantile is drawn, not just described');
});

test('text reaches the document as a text node, never as markup', () => {
  const calls = { html: [], text: [], ns: [], plain: [] };
  const fakeDocument = {
    createElement: (tag) => {
      calls.plain.push(tag);
      return node(tag, false);
    },
    createElementNS: (ns, tag) => {
      calls.ns.push(`${ns}/${tag}`);
      return node(tag, true);
    },
    createTextNode: (value) => {
      calls.text.push(value);
      return { nodeType: 3, text: value };
    },
  };
  function node(tag, isSvg) {
    const el = {
      nodeType: 1,
      tagName: tag,
      isSvg,
      attrs: {},
      children: [],
      setAttribute(name, value) {
        if (name === 'innerHTML') calls.html.push(value);
        this.attrs[name] = value;
      },
      set innerHTML(_value) { calls.html.push('setter'); },
      get innerHTML() { return ''; },
      append(...kids) { this.children.push(...kids); },
    };
    return el;
  }
  const original = globalThis.document;
  globalThis.document = fakeDocument;
  try {
    const hostile = '<img src=x onerror=alert(1)>';
    const spec = trendSpec([{ date: hostile, credits: '12.00' }, { date: '2026-11-20', credits: '3.00' }]);
    mount(spec);
    assert.deepEqual(calls.html, [], 'no path writes innerHTML');
    assert.ok(calls.text.includes(hostile), 'the value is present as text, which is what makes it inert');
    // SVG built with the HTML factory is in the DOM and draws nothing — the
    // namespace call is the only thing that makes the chart visible.
    assert.ok(calls.ns.length >= 5, `svg tags used createElementNS (${calls.ns.length})`);
    assert.equal(calls.ns.every((entry) => entry.startsWith('http://www.w3.org/2000/svg/')), true);
    assert.equal(calls.plain.includes('svg'), false);
  } finally {
    globalThis.document = original;
  }
});

test('the heatmap is weeks columns of seven days, Monday first', () => {
  const cells = withValues(days(91), Array.from({ length: 91 }, (_, i) => (i % 3) * 400));
  const spec = heatmapSpec(cells, { weeks: 13, todayIso: cells[90].date });
  const svg = spec.children[0].children[0];
  const columns = svg.children;
  assert.equal(columns.length, 13, 'one column per week, oldest first');
  assert.equal(columns[0].children.length, 7, 'every column holds a full week');
  assert.equal(svg.attrs.viewBox, `0 0 ${13 * CELL} ${7 * CELL}`);
  // Column 0 day 0 is the oldest Monday; the newest day sits in the last column.
  assert.equal(columns[0].children[0].attrs['data-date'], '2026-08-22');
  assert.equal(columns[12].children[6].attrs['data-date'], cells[90].date);
  assert.ok(columns[12].children[6].attrs.class.includes('usage-cell-today'), 'today is marked, since it is a partial day');
  assert.equal(CHART_GEOMETRY.WEEKDAY_LABELS.filter(Boolean).join(','), 'Mon,Wed,Fri', 'the rail matches the mock');
});

test('a day with no reading is an unknown cell, not the zero level', () => {
  const cells = withValues(days(7), [null, 0, 100, 200, 300, 400, 500]);
  const spec = heatmapSpec(cells, { weeks: 1, todayIso: null });
  const column = spec.children[0].children[0].children[0];
  assert.ok(column.children[0].attrs.class.includes('usage-cell-unknown'), 'a failed read cannot be coloured as no usage');
  assert.ok(column.children[1].attrs.class.includes('usage-cell-l0'), 'a real zero is its own level');
  assert.equal(column.children[0].attrs['aria-label'], '2026-08-22: no data');
  assert.equal(column.children[1].attrs['aria-label'], '2026-08-23: 0.00 credits');
});

test('levels are quantiles of this org, so a small account still shows a shape', () => {
  const flat = heatmapLevels(withValues(days(7), Array(7).fill(100)));
  assert.equal(flat(100), 1, 'all-equal usage is the lowest positive level, not the top');
  const spread = heatmapLevels(withValues(days(7), [0, 1, 2, 3, 4, 5, 10_000]));
  assert.equal(spread(0), 0);
  assert.equal(spread(10_000), 4, 'the peak is always the darkest cell');
  assert.equal(spread(null), null, 'unknown is not a level');
  const empty = heatmapLevels(days(0));
  assert.equal(empty(5), null, 'no data means no colour, including for a value that arrives later');
});

test('splinePath is Catmull-Rom expressed as cubic béziers', () => {
  assert.equal(splinePath([]), '');
  assert.equal(splinePath([{ x: 5, y: 7 }]), 'M 5 7');
  // The whole point of the smoothing is that the curve passes THROUGH every
  // sample: each segment ends exactly on its target, with 1/6 tangent handles.
  assert.equal(splinePath([{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 0 }]),
    'M 0 0 C 1.67 1.67 6.67 10 10 10 C 13.33 10 18.33 1.67 20 0');
  const flat = splinePath([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }, { x: 30, y: 0 }]);
  const ys = [...new Set(flat.match(/-?\d+(\.\d+)?/g).filter((_, index) => index % 2 === 1))];
  assert.deepEqual(ys, ['0'], 'a flat series must not overshoot in y');
});

test('the trend puts the peak at the top and the labels on the axis', () => {
  const points = withValues(days(7), [100, 900, 300, 200, 400, 50, 250]);
  const spec = trendSpec(points, { width: 720, height: 220 });
  const svg = spec.children[0];
  const line = svg.children.find((child) => child.attrs?.class === 'usage-trend-line');
  assert.ok(line?.attrs?.d, 'a line is drawn when there is a series');
  const peak = svg.children.find((child) => child.attrs?.class === 'usage-trend-peak');
  // Index 1 is the 900-tokenCredits day and the maximum, so it sits on the top padding
  // edge at its own x (44 left pad + 1/6 of the 664 plot width).
  assert.equal(peak.attrs.cx, 154.67);
  assert.equal(peak.attrs.cy, 14);
  const gridlines = svg.children.filter((child) => child.attrs?.class === 'usage-gridline');
  assert.equal(gridlines.length, 5);
  assert.equal(gridlines[4].children[1].children[0], '9', 'the top gridline is the maximum, in credits');
  assert.equal(gridlines[0].children[1].children[0], '0');
  const labels = svg.children.filter((child) => child.attrs?.class === 'usage-axis-label' && child.attrs.y === 212);
  assert.equal(labels.length, 2, 'only the window ends are named, never all seven days');
  assert.deepEqual(labels.map((child) => child.children[0]), ['2026-08-22', '2026-08-28']);
});

test('a window FlexPrice did not bucket draws nothing instead of a flat zero line', () => {
  const spec = trendSpec([], { width: 400, height: 120 });
  const svg = spec.children[0];
  assert.equal(svg.children.filter((child) => child.attrs?.class === 'usage-trend-line').length, 0);
  assert.equal(svg.children.filter((child) => child.attrs?.class === 'usage-trend-area').length, 0);
  // The grid still exists, so the notice sits in a chart-shaped box rather than
  // collapsing the layout — but it is an empty grid, with no fabricated series.
  assert.equal(svg.children.filter((child) => child.attrs?.class === 'usage-gridline').length, 5);
});

test('an unreadable day is skipped rather than plotted at zero', () => {
  const points = withValues(days(4), [100, null, 300, 200]);
  const spec = trendSpec(points, { width: 300, height: 100 });
  const line = spec.children[0].children.find((child) => child.attrs?.class === 'usage-trend-line');
  assert.equal((line.attrs.d.match(/C/g) || []).length, 2, 'three readable days, two segments');
});

test('axis numbers are compact so a big window does not wrap its own labels', () => {
  assert.equal(formatCompact(0), '0');
  assert.equal(formatCompact(9), '9');
  assert.equal(formatCompact(1240), '1.24k');
  assert.equal(formatCompact(640886), '640.89k');
  assert.equal(formatCompact(2_500_000), '2.5M');
  assert.equal(formatCompact(null), '0');
});
