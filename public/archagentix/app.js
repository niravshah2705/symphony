import { initQuestionBank } from './questions.js';

// Registry keys arrive as snake_case identifiers; the table shows words.
const readable = (value) => String(value || '').replace(/_/g, ' ');

// A price register: grouped thousands, two decimals, a third only when the cent
// is finer than a cent. $10.000 would read as ten thousand dollars.
const money = (value) =>
  Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 3 });

// Two rows of one model differ by region or by context tier; the register says which.
// "global" is nearly always true, so it is never the discriminator — the tier usually is.
const scopeOf = (m) => {
  const parts = [];
  const region = m.available_regions;
  if (region && !/^global$/i.test(region)) parts.push(readable(region));
  const tier = m.context_tier;
  if (tier && tier !== 'standard') parts.push(/^[<>]=?\d/.test(tier) ? `${tier} context` : readable(tier));
  return parts.join(', ');
};

let benchmarkData = [];
let slmWorker = null;

document.addEventListener('DOMContentLoaded', () => {
  initApp();
  initWorker();
  // A failed session must not take the benchmark tables down with it.
  initQuestionBank().catch(() => {});
  initCatalog().catch(() => {});
});

async function initCatalog() {
  const res = await fetch('/data/benchmarks/catalog-scored.json');
  if (!res.ok) throw new Error(`Agentic catalog fetch failed: ${res.status}`);
  renderCatalog(await res.json());
}

function renderCatalog(rows) {  const tbody = document.getElementById('catalog-body');
  if (!tbody) return;
  tbody.textContent = '';

  const cell = (value, className) => {
    const td = document.createElement('td');
        td.textContent = value;
    return td;
  };

  rows.forEach((m) => {
    const tr = document.createElement('tr');

    const rank = document.createElement('td');
    const badge = document.createElement('span');
    badge.className = 'rank-badge';
    badge.textContent = m.rank;
    rank.appendChild(badge);

    // Feature labels are fixed strings; only booleans from the data decide which show.
    const features = document.createElement('td');
    for (const [on, label] of [
      [m.agentic_features?.tool_use, 'Tool use'],
      [m.agentic_features?.function_calling, 'Function calling'],
      [m.agentic_features?.computer_use, 'Computer use'],
      [m.agentic_features?.reasoning_effort_control, 'Reasoning control'],
    ]) {
      if (!on) continue;
      const tag = document.createElement('span');
      tag.className = 'feature-pill';
      tag.textContent = label;
      features.appendChild(tag);
      features.appendChild(document.createTextNode(' '));
    }

    const cost = m.best_cloud
      ? `$${money(m.best_cloud.prompt_cost_per_1m)}/1M via ${readable(m.best_cloud.provider)}`
      : 'Direct only';

    tr.append(
      rank,
      cell(`${m.name} · ${m.provider}`),
      cell(readable(m.model_type)),
      cell(`${Number(m.parameters?.context_window_tokens || 0).toLocaleString()} tokens`),
      cell(Number(m.parameters?.max_output_tokens || 0).toLocaleString()),
      features,
      cell(cost),
      cell(m.simple_score),
    );
    tbody.appendChild(tr);
  });
}

async function initApp() {
  try {
    const res = await fetch('/data/benchmarks/index.json');
    benchmarkData = await res.json();
  } catch (err) {
    console.error('Failed to load dataset:', err);
  }

  renderTable(benchmarkData.slice(0, 100)); // Paginated view of top 100
  setupFilters();
  setupEvaluator();
}

function formatVal(val) {
  const num = parseFloat(val);
  if (!num || num === 0) return 'N/A';
  return `$${money(num)}/1M`;
}

// One row per fetched model. Built from textContent rather than innerHTML: the
// names and URLs come from an upstream registry file, not from this repo.
function renderTable(data) {
  const tbody = document.getElementById('table-body');
  tbody.replaceChildren();

  const cell = (value, className) => {
    const td = document.createElement('td');
        if (className) td.className = className;
    td.textContent = value;
    return td;
  };

  data.forEach((m, idx) => {
    const tr = document.createElement('tr');

    const rank = document.createElement('td');
    const badge = document.createElement('span');
    badge.className = 'rank-badge';
    badge.textContent = idx + 1;
    rank.appendChild(badge);

    const model = document.createElement('td');
    const name = document.createElement('strong');
    name.textContent = m.model_name || m.model_id;
    const meta = document.createElement('span');
    meta.className = 'muted';
    meta.textContent = `${m.provider} · ${m.category || 'general'}`;
    model.append(name, document.createElement('br'), meta);
    const scope = scopeOf(m);
    if (scope) {
      const where = document.createElement('span');
      where.className = 'row-scope';
      where.textContent = scope;
      model.append(document.createElement('br'), where);
    }

    const source = document.createElement('td');
    if (m.source_url) {
      const link = document.createElement('a');
      link.className = 'textlink';
      link.href = m.source_url;
      link.target = '_blank';
      link.rel = 'noopener';
      link.textContent = 'Source';
      source.appendChild(link);
    } else {
      source.textContent = 'Registry only';
      source.className = 'muted';
    }

    tr.append(
      rank,
      model,
      cell(m.license === 'open_source' ? 'Open source' : 'Proprietary'),
      cell(parseInt(m.context_length_tokens || 0).toLocaleString(), 'num'),
      cell(formatVal(m.input_usd_per_1m), 'num'),
      cell(formatVal(m.output_usd_per_1m), 'num'),
      cell(formatVal(m.cache_read_usd_per_1m), 'num'),
      cell(formatVal(m.batch_input_usd_per_1m), 'num'),
      source,
    );
    tbody.appendChild(tr);
  });
}

function setupFilters() {
  const providerSel = document.getElementById('filter-provider');
  const typeSel = document.getElementById('filter-type');
  const searchInput = document.getElementById('search-input');

  const filterHandler = () => {
    const provider = providerSel.value.toLowerCase();
    const type = typeSel.value.toLowerCase();
    const q = searchInput.value.toLowerCase();

    const filtered = benchmarkData.filter(m => {
      const matchProvider = !provider || (m.provider && m.provider.toLowerCase().includes(provider));
      const matchType = !type || (m.license && m.license.toLowerCase().includes(type));
      const matchQ = !q || (m.model_name && m.model_name.toLowerCase().includes(q)) || (m.model_id && m.model_id.toLowerCase().includes(q));
      return matchProvider && matchType && matchQ;
    });

    renderTable(filtered.slice(0, 100));
  };

  if (providerSel) providerSel.addEventListener('change', filterHandler);
  if (typeSel) typeSel.addEventListener('change', filterHandler);
  if (searchInput) searchInput.addEventListener('input', filterHandler);
}

function setupEvaluator() {
  const promptInput = document.getElementById('eval-prompts');
  const compInput = document.getElementById('eval-completions');
  const cacheHitInput = document.getElementById('eval-cache-hit');
  const cacheHitVal = document.getElementById('cache-hit-val');
  const resultsDiv = document.getElementById('eval-results');

  const recalculate = () => {
    const promptM = parseFloat(promptInput?.value) || 0;
    const compM = parseFloat(compInput?.value) || 0;
    const hitRatio = (parseFloat(cacheHitInput?.value) || 0) / 100;
    if (cacheHitVal) cacheHitVal.value = `${cacheHitInput.value}%`;

    if (!resultsDiv) return;
    resultsDiv.replaceChildren();

    benchmarkData.slice(0, 10).forEach((m) => {
      const inPrice = parseFloat(m.input_usd_per_1m) || 0;
      const outPrice = parseFloat(m.output_usd_per_1m) || 0;
      const cachePrice = parseFloat(m.cache_read_usd_per_1m) || inPrice;
      if (inPrice <= 0) return;

      const promptCostUncached = promptM * (1 - hitRatio) * inPrice;
      const promptCostCached = promptM * hitRatio * cachePrice;
      const compCost = compM * outPrice;
      const totalEst = promptCostUncached + promptCostCached + compCost;

      const row = document.createElement('div');
      row.className = 'eval-row';

      const who = document.createElement('p');
      const name = document.createElement('strong');
      name.textContent = m.model_name || m.model_id;
      const provider = document.createElement('span');
      provider.className = 'muted';
      const scope = scopeOf(m);
      provider.textContent = scope ? ` (${m.provider}, ${scope})` : ` (${m.provider})`;
      who.append(name, provider);

      const cost = document.createElement('p');
      cost.className = 'eval-cost';
      cost.textContent = `$${money(totalEst)}/mo`;

      row.append(who, cost);
      resultsDiv.append(row);
    });
  };

  if (promptInput) promptInput.addEventListener('input', recalculate);
  if (compInput) compInput.addEventListener('input', recalculate);
  if (cacheHitInput) cacheHitInput.addEventListener('input', recalculate);
  recalculate();
}

function initWorker() {
  // Resolved against this module, not the page URL, so the worker still loads when
  // the panel is opened at /archagentix without its trailing slash.
  slmWorker = new Worker(new URL('evaluator-worker.js', import.meta.url));

  const chatInput = document.getElementById('chat-input');
  const sendBtn = document.getElementById('send-btn');
  const messagesList = document.getElementById('chat-messages');

  slmWorker.onmessage = (e) => {
    const { response } = e.data;
    const botMsg = document.createElement('p');
    botMsg.className = 'msg bot';
    // The model's text goes in as text nodes: a reply is not trusted markup.
    String(response).split('\n').forEach((line, i) => {
      if (i) botMsg.appendChild(document.createElement('br'));
      botMsg.appendChild(document.createTextNode(line));
    });
    messagesList.appendChild(botMsg);
    messagesList.scrollTop = messagesList.scrollHeight;
  };

  const sendQuery = () => {
    const query = chatInput.value.trim();
    if (!query) return;

    const userMsg = document.createElement('p');
    userMsg.className = 'msg user';
    userMsg.textContent = query;
    messagesList.appendChild(userMsg);

    chatInput.value = '';
    messagesList.scrollTop = messagesList.scrollHeight;

    slmWorker.postMessage({ query, dataset: benchmarkData.slice(0, 200) });
  };

  if (sendBtn) sendBtn.addEventListener('click', sendQuery);
  if (chatInput) chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendQuery(); });
}
