let benchmarkData = [];
let slmWorker = null;

document.addEventListener('DOMContentLoaded', () => {
  initApp();
  initWorker();
});

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
  if (!num || num === 0) return '<em>N/A (0.0)</em>';
  return `$${num.toFixed(3)}/1M`;
}

function renderTable(data) {
  const tbody = document.getElementById('table-body');
  tbody.innerHTML = '';

  data.forEach((m, idx) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><span class="rank-badge">${idx + 1}</span></td>
      <td><strong>${m.model_name || m.model_id}</strong><br><small style="color:#8b949e">${m.provider} (${m.category || 'all'})</small></td>
      <td><span class="score-tag">${m.license || 'N/A'}</span></td>
      <td>${parseInt(m.context_length_tokens || 0).toLocaleString()} tokens</td>
      <td>${formatVal(m.input_usd_per_1m)}</td>
      <td>${formatVal(m.output_usd_per_1m)}</td>
      <td><small>Batch: ${formatVal(m.batch_input_usd_per_1m)}<br>Cache Read: ${formatVal(m.cache_read_usd_per_1m)}</small></td>
      <td><small>${m.available_regions || m.region || 'Global'}</small></td>
      <td>
        ${m.source_url ? `<a href="${m.source_url}" target="_blank" style="color:#58a6ff; font-size:0.8rem">Source</a>` : ''}
      </td>
    `;
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
    if (cacheHitVal) cacheHitVal.textContent = `${cacheHitInput.value}%`;

    let html = '<div style="display:flex; flex-direction:column; gap:0.5rem">';
    benchmarkData.slice(0, 10).forEach(m => {
      const inPrice = parseFloat(m.input_usd_per_1m) || 0;
      const outPrice = parseFloat(m.output_usd_per_1m) || 0;
      const cachePrice = parseFloat(m.cache_read_usd_per_1m) || inPrice;

      if (inPrice > 0) {
        const promptCostUncached = promptM * (1 - hitRatio) * inPrice;
        const promptCostCached = promptM * hitRatio * cachePrice;
        const compCost = compM * outPrice;
        const totalEst = promptCostUncached + promptCostCached + compCost;

        html += `
          <div style="display:flex; justify-content:space-between; padding:0.5rem; background:#161b22; border-radius:4px">
            <span><strong>${m.model_name || m.model_id}</strong> <small style="color:#8b949e">(${m.provider})</small></span>
            <span style="color:#58a6ff; font-weight:bold">$${totalEst.toFixed(2)}/mo</span>
          </div>
        `;
      }
    });
    html += '</div>';
    if (resultsDiv) resultsDiv.innerHTML = html;
  };

  if (promptInput) promptInput.addEventListener('input', recalculate);
  if (compInput) compInput.addEventListener('input', recalculate);
  if (cacheHitInput) cacheHitInput.addEventListener('input', recalculate);
  recalculate();
}

function initWorker() {
  slmWorker = new Worker('evaluator-worker.js');

  const chatInput = document.getElementById('chat-input');
  const sendBtn = document.getElementById('send-btn');
  const messagesList = document.getElementById('chat-messages');

  slmWorker.onmessage = (e) => {
    const { response } = e.data;
    const botMsg = document.createElement('div');
    botMsg.className = 'msg bot';
    botMsg.innerHTML = response.replace(/\n/g, '<br>');
    messagesList.appendChild(botMsg);
    messagesList.scrollTop = messagesList.scrollHeight;
  };

  const sendQuery = () => {
    const query = chatInput.value.trim();
    if (!query) return;

    const userMsg = document.createElement('div');
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
