'use strict';

function renderDashboardHtml(data = {}) {
  const {
    account = {},
    summary = {},
    cashfreeConfigured = false,
    environment = 'sandbox',
  } = data;

  const balanceInr = (Number(account.balancePaise || 0) / 100).toFixed(2);
  const initialCreditInr = (Number(account.initialCreditPaise || 0) / 100).toFixed(2);
  const autoRecharge = account.autoRecharge || {};
  const isAutoEnabled = Boolean(autoRecharge.enabled);
  const mode = autoRecharge.mode || 'amount';
  const thresholdInr = ((Number(autoRecharge.thresholdPaise) || 0) / 100).toFixed(2);
  const thresholdPercent = Number(autoRecharge.thresholdPercent) || 20;
  const rechargeAmountInr = ((Number(autoRecharge.amountPaise) || 0) / 100).toFixed(2);
  const subscriptionId = autoRecharge.cashfreeSubscriptionId || '';
  const paymentInfo = account.paymentInfo || {};
  const billingName = paymentInfo.billingName || 'Not configured';
  const billingEmail = paymentInfo.billingEmail || 'Not configured';
  const taxId = paymentInfo.taxId || 'None';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AI Fleet Billing Control Center</title>
  <style>
    :root {
      --bg: #0b0f19;
      --card-bg: #111827;
      --border: #1f2937;
      --border-focus: #38bdf8;
      --text: #f3f4f6;
      --text-muted: #9ca3af;
      --primary: #2563eb;
      --primary-hover: #1d4ed8;
      --success: #10b981;
      --warn: #f59e0b;
      --danger: #ef4444;
      --font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background-color: var(--bg);
      color: var(--text);
      font-family: var(--font-family);
      line-height: 1.5;
      padding: 2rem 1rem;
    }
    .container {
      max-width: 960px;
      margin: 0 auto;
    }
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 2rem;
      border-bottom: 1px solid var(--border);
      padding-bottom: 1rem;
    }
    h1 { font-size: 1.5rem; font-weight: 600; }
    .badge {
      display: inline-flex;
      align-items: center;
      padding: 0.25rem 0.75rem;
      border-radius: 9999px;
      font-size: 0.75rem;
      font-weight: 500;
      background: var(--card-bg);
      border: 1px solid var(--border);
      color: var(--text-muted);
    }
    .badge.active { border-color: var(--success); color: var(--success); }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 1.25rem;
      margin-bottom: 2rem;
    }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 0.5rem;
      padding: 1.25rem;
    }
    .card-title {
      font-size: 0.875rem;
      color: var(--text-muted);
      margin-bottom: 0.5rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .metric {
      font-size: 1.875rem;
      font-weight: 700;
      color: #fff;
    }
    .metric-sub {
      font-size: 0.8rem;
      color: var(--text-muted);
      margin-top: 0.25rem;
    }
    form {
      display: flex;
      flex-direction: column;
      gap: 1.25rem;
    }
    .form-group {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }
    label {
      font-size: 0.875rem;
      font-weight: 500;
    }
    .radio-row {
      display: flex;
      gap: 1.5rem;
      margin: 0.25rem 0;
    }
    .radio-label {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      cursor: pointer;
    }
    input[type="text"], input[type="number"], select {
      background: #1e293b;
      border: 1px solid var(--border);
      color: var(--text);
      padding: 0.625rem 0.875rem;
      border-radius: 0.375rem;
      font-size: 0.875rem;
      outline: none;
    }
    input:focus, select:focus {
      border-color: var(--border-focus);
    }
    .btn {
      background: var(--primary);
      color: white;
      border: none;
      border-radius: 0.375rem;
      padding: 0.625rem 1.25rem;
      font-size: 0.875rem;
      font-weight: 500;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      transition: background 0.15s ease;
    }
    .btn:hover { background: var(--primary-hover); }
    .btn.secondary {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--text);
    }
    .btn.secondary:hover { background: #1e293b; }
    .actions {
      display: flex;
      gap: 1rem;
      margin-top: 1rem;
    }
    #status-toast {
      padding: 0.75rem 1rem;
      border-radius: 0.375rem;
      font-size: 0.875rem;
      display: none;
      margin-bottom: 1rem;
    }
    #status-toast.ok { background: #064e3b; color: #6ee7b7; border: 1px solid #059669; }
    #status-toast.error { background: #7f1d1d; color: #fca5a5; border: 1px solid #dc2626; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div>
        <h1>AI Fleet · Billing Control Center</h1>
        <p style="color: var(--text-muted); font-size: 0.875rem;">Dedicated Cloud Run Microservice for Usage Metering & Auto-Renew</p>
      </div>
      <div style="display:flex; gap: 0.5rem;">
        <span class="badge active">Service Online</span>
        <span class="badge">${cashfreeConfigured ? 'Cashfree ' + environment : 'Mock Payment Gateway'}</span>
      </div>
    </header>

    <div id="status-toast"></div>

    <div class="grid">
      <div class="card">
        <div class="card-title">Available Balance</div>
        <div class="metric">₹${balanceInr}</div>
        <div class="metric-sub">Seeded credit: ₹${initialCreditInr}</div>
      </div>
      <div class="card">
        <div class="card-title">Auto-Reload Status</div>
        <div class="metric" style="color: ${isAutoEnabled ? 'var(--success)' : 'var(--text-muted)'};">
          ${isAutoEnabled ? 'Active' : 'Disabled'}
        </div>
        <div class="metric-sub">
          ${isAutoEnabled ? (mode === 'percentage' ? `Reload at ${thresholdPercent}% of credit` : `Reload below ₹${thresholdInr}`) : 'No automatic trigger configured'}
        </div>
      </div>
      <div class="card">
        <div class="card-title">Payment Mandate</div>
        <div class="metric" style="font-size: 1.25rem; font-weight: 500; word-break: break-all;">
          ${subscriptionId ? subscriptionId : 'Not Configured'}
        </div>
        <div class="metric-sub">${subscriptionId ? 'UPI AutoPay / eNACH / Card SI active' : 'Authorize via UI to enable auto-charge'}</div>
      </div>
      <div class="card">
        <div class="card-title">Billing Entity & Tax</div>
        <div class="metric" style="font-size: 1.1rem; font-weight: 500;">
          ${billingName}
        </div>
        <div class="metric-sub">${billingEmail} · Tax ID: ${taxId}</div>
      </div>
    </div>

    <div class="card">
      <div class="card-title" style="margin-bottom: 1rem;">Configure Auto-Renew Threshold (OpenAI Style)</div>
      <form id="config-form">
        <div class="form-group">
          <label class="radio-label">
            <input type="checkbox" id="auto-enabled" ${isAutoEnabled ? 'checked' : ''}>
            <span>Enable Auto-Renew (Automatically top-up when balance drops below threshold)</span>
          </label>
        </div>

        <div class="form-group">
          <label>Threshold Mode</label>
          <div class="radio-row">
            <label class="radio-label">
              <input type="radio" name="threshold-mode" value="amount" ${mode === 'amount' ? 'checked' : ''}>
              <span>Fixed Amount (₹)</span>
            </label>
            <label class="radio-label">
              <input type="radio" name="threshold-mode" value="percentage" ${mode === 'percentage' ? 'checked' : ''}>
              <span>Percentage of Initial Credit (%)</span>
            </label>
          </div>
        </div>

        <div class="form-group" id="group-amount" style="${mode === 'amount' ? 'display: flex;' : 'display: none;'}">
          <label for="threshold-amount">Trigger Threshold (₹)</label>
          <input type="number" id="threshold-amount" value="${thresholdInr}" min="0" step="10">
          <span style="font-size: 0.75rem; color: var(--text-muted);">Recharge triggers when balance falls below this amount.</span>
        </div>

        <div class="form-group" id="group-percentage" style="${mode === 'percentage' ? 'display: flex;' : 'display: none;'}">
          <label for="threshold-percent">Trigger Threshold (%)</label>
          <input type="number" id="threshold-percent" value="${thresholdPercent}" min="1" max="100" step="1">
          <span style="font-size: 0.75rem; color: var(--text-muted);">Recharge triggers when balance falls below this % of initial credit.</span>
        </div>

        <div class="form-group">
          <label for="recharge-amount">Auto-Reload Amount (₹)</label>
          <input type="number" id="recharge-amount" value="${rechargeAmountInr}" min="100" step="100">
        </div>

        <div class="actions">
          <button type="submit" class="btn">Save Configuration</button>
          <button type="button" id="trigger-sweep-btn" class="btn secondary">Run Hourly Sweep Now</button>
        </div>
      </form>
    </div>
  </div>

  <script>
    const form = document.getElementById('config-form');
    const toast = document.getElementById('status-toast');
    const modeRadios = document.getElementsByName('threshold-mode');
    const groupAmount = document.getElementById('group-amount');
    const groupPercentage = document.getElementById('group-percentage');
    const sweepBtn = document.getElementById('trigger-sweep-btn');

    function updateVisibility() {
      const isPercent = Array.from(modeRadios).find(r => r.checked)?.value === 'percentage';
      groupAmount.style.display = isPercent ? 'none' : 'flex';
      groupPercentage.style.display = isPercent ? 'flex' : 'none';
    }

    modeRadios.forEach(r => r.addEventListener('change', updateVisibility));

    function showToast(msg, ok = true) {
      toast.textContent = msg;
      toast.className = ok ? 'ok' : 'error';
      toast.style.display = 'block';
      setTimeout(() => { toast.style.display = 'none'; }, 5000);
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const enabled = document.getElementById('auto-enabled').checked;
      const isPercent = Array.from(modeRadios).find(r => r.checked)?.value === 'percentage';
      const thresholdInr = Number(document.getElementById('threshold-amount').value) || 0;
      const thresholdPercent = Number(document.getElementById('threshold-percent').value) || 20;
      const amountInr = Number(document.getElementById('recharge-amount').value) || 0;

      try {
        const res = await fetch('/api/billing/config', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            autoRecharge: {
              enabled,
              mode: isPercent ? 'percentage' : 'amount',
              thresholdInr,
              thresholdPercent,
              amountInr,
            }
          })
        });
        if (res.ok) {
          showToast('Settings saved successfully!');
          setTimeout(() => location.reload(), 1000);
        } else {
          const err = await res.json();
          showToast(err.error || 'Failed to save settings', false);
        }
      } catch (err) {
        showToast(err.message || 'Request failed', false);
      }
    });

    sweepBtn.addEventListener('click', async () => {
      sweepBtn.disabled = true;
      try {
        const res = await fetch('/pubsub/billing-tick', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({})
        });
        if (res.ok) {
          showToast('Hourly sweep executed successfully!');
          setTimeout(() => location.reload(), 1000);
        } else {
          showToast('Sweep returned status: ' + res.status, false);
        }
      } catch (err) {
        showToast('Sweep error: ' + err.message, false);
      } finally {
        sweepBtn.disabled = false;
      }
    });
  </script>
</body>
</html>`;
}

module.exports = { renderDashboardHtml };
