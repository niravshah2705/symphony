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

  renderTable(benchmarkData);
  setupFilters();
  setupEvaluator();
}

function renderTable(data) {
  const tbody = document.getElementById('table-body');
  tbody.innerHTML = '';

  data.forEach((m, idx) => {
    const aws = m.cloud_inference_metrics?.aws_bedrock;
    const gcp = m.cloud_inference_metrics?.gcp_vertex_ai;
    const do_m = m.cloud_inference_metrics?.digital_ocean_gradient;
    const ali = m.cloud_inference_metrics?.alibaba_dashscope;

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><span class="rank-badge">${m.rank || idx + 1}</span></td>
      <td><strong>${m.name}</strong><br><small style="color:#8b949e">${m.provider} (${m.parameters.total_params})</small></td>
      <td><span class="score-tag">${m.simple_score}</span></td>
      <td>${m.parameters.context_window_tokens.toLocaleString()} tokens</td>
      <td>${m.benchmarks.swe_bench_verified}%</td>
      <td>
        <small>AWS: $${aws?.supported ? aws.prompt_cost_per_1m : 'N/A'}/1M<br>
        GCP: $${gcp?.supported ? gcp.prompt_cost_per_1m : 'N/A'}/1M<br>
        DO: $${do_m?.supported ? do_m.prompt_cost_per_1m : 'N/A'}/1M<br>
        Ali: $${ali?.supported ? ali.prompt_cost_per_1m : 'N/A'}/1M</small>
      </td>
      <td><span class="feature-pill">${m.relations.best_cloud_provider_for_cost}</span></td>
      <td>
        ${m.links.paper_link ? `<a href="${m.links.paper_link}" target="_blank" style="color:#58a6ff; font-size:0.8rem">Paper</a>` : ''}
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
      const matchProvider = !provider || m.provider.toLowerCase() === provider;
      const matchType = !type || m.model_type.toLowerCase() === type;
      const matchQ = !q || m.name.toLowerCase().includes(q) || m.provider.toLowerCase().includes(q);
      return matchProvider && matchType && matchQ;
    });

    renderTable(filtered);
  };

  providerSel.addEventListener('change', filterHandler);
  typeSel.addEventListener('change', filterHandler);
  searchInput.addEventListener('input', filterHandler);
}

function setupEvaluator() {
  const promptInput = document.getElementById('eval-prompts');
  const compInput = document.getElementById('eval-completions');
  const cacheHitInput = document.getElementById('eval-cache-hit');
  const cacheHitVal = document.getElementById('cache-hit-val');
  const resultsDiv = document.getElementById('eval-results');

  const recalculate = () => {
    const promptM = parseFloat(promptInput.value) || 0;
    const compM = parseFloat(compInput.value) || 0;
    const hitRatio = (parseFloat(cacheHitInput.value) || 0) / 100;
    cacheHitVal.textContent = `${cacheHitInput.value}%`;

    let html = '<div style="display:flex; flex-direction:column; gap:0.5rem">';
    benchmarkData.forEach(m => {
      const aws = m.cloud_inference_metrics?.aws_bedrock;
      if (aws && aws.supported) {
        const promptCostUncached = promptM * (1 - hitRatio) * aws.prompt_cost_per_1m;
        const promptCostCached = promptM * hitRatio * (aws.cached_prompt_cost_per_1m || aws.prompt_cost_per_1m);
        const compCost = compM * aws.completion_cost_per_1m;
        const totalEst = promptCostUncached + promptCostCached + compCost;

        html += `
          <div style="display:flex; justify-content:space-between; padding:0.5rem; background:#161b22; border-radius:4px">
            <span><strong>${m.name}</strong> <small style="color:#8b949e">(AWS Bedrock)</small></span>
            <span style="color:#58a6ff; font-weight:bold">$${totalEst.toFixed(2)}/mo</span>
          </div>
        `;
      }
    });
    html += '</div>';
    resultsDiv.innerHTML = html;
  };

  promptInput.addEventListener('input', recalculate);
  compInput.addEventListener('input', recalculate);
  cacheHitInput.addEventListener('input', recalculate);
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

    slmWorker.postMessage({ query, dataset: benchmarkData });
  };

  sendBtn.addEventListener('click', sendQuery);
  chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendQuery(); });
}
