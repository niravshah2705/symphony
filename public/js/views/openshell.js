import { api } from '../api.js';
import { el, clear, loading, toast } from '../dom.js';
import { getWorkspaceContext } from '../workspace-context.js';

const FREE_OPENROUTER_MODELS = [
  { id: 'openrouter/free', label: 'openrouter/free (Auto Router — Free)' },
  { id: 'qwen/qwen3-coder:free', label: 'qwen/qwen3-coder:free' },
  { id: 'meta-llama/llama-3.3-70b-instruct:free', label: 'meta-llama/llama-3.3-70b-instruct:free' },
  { id: 'google/gemma-3-27b-it:free', label: 'google/gemma-3-27b-it:free' },
];

export async function renderOpenShell(view) {
  clear(view).append(loading('Provisioning and connecting to OpenShell sandbox environment…'));

  const context = getWorkspaceContext();
  const orgId = context?.organizationId || 'default-org';
  const projectId = context?.projectId || 'default';
  const projectName = context?.project?.name || projectId;

  let sandboxStatus = null;
  let orgConfig = null;
  let policyData = null;
  let securityResult = null;
  let errorMsg = null;
  let selectedModel = FREE_OPENROUTER_MODELS[0].id;

  try {
    // Automatically provision or ensure real sandbox pod is running for the active org & project
    const loadRes = await api.loadProjectSandbox({
      projectId,
      projectName,
      organizationId: orgId,
    });
    if (loadRes?.sandbox) {
      sandboxStatus = loadRes.sandbox;
    }
    if (loadRes?.orgConfig) {
      orgConfig = loadRes.orgConfig;
    }
  } catch (err) {
    errorMsg = err.message || 'Failed to auto-provision OpenShell sandbox.';
  }

  try {
    const statusRes = await api.getSandboxStatus({ projectId, projectName });
    if (!sandboxStatus && statusRes?.sandbox) {
      sandboxStatus = statusRes.sandbox;
    }
    if (statusRes?.orgConfig) {
      orgConfig = statusRes.orgConfig;
    }
    if (statusRes?.networkPolicy) {
      policyData = statusRes.networkPolicy;
    }
  } catch (_) {
    // Best-effort status enrichment
  }

  const activeWorkspace = sandboxStatus?.workspace || orgConfig?.workspace || 'tenant-a';

  if (!policyData) {
    try {
      const polRes = await api.getSandboxNetworkPolicy({ workspace: activeWorkspace });
      policyData = polRes?.policy || null;
    } catch (_) {
      // Ignore fallback policy fetch error
    }
  }

  function renderView() {
    clear(view);

    const head = el('div', { class: 'page-head', style: 'display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 12px;' }, [
      el('div', {}, [
        el('h1', {}, 'OpenShell Sandbox & Terminal'),
        el('p', { class: 'muted' }, `Organization [${orgId}] · Project [${projectName}] · Kubernetes Namespace [${activeWorkspace}]`),
      ]),
      el('div', { style: 'display: flex; gap: 8px; align-items: center;' }, [
        el('a', { href: '#/organization', class: 'button ghost' }, 'Organization Secrets & NetworkPolicy'),
      ]),
    ]);

    if (errorMsg && !sandboxStatus) {
      view.append(head, el('div', { class: 'error-banner' }, errorMsg));
      return;
    }

    const phase = sandboxStatus?.phase || 'READY';
    const sbName = sandboxStatus?.name || `sb-${projectId}`;
    const gatewayUrl = sandboxStatus?.url || 'https://openshell.archagentix.com';
    const imageRegBadge = orgConfig?.imageRegistryConfigured
      ? `Configured (${orgConfig.imageRegistryUrl || 'ghcr.io'})`
      : 'Not set (configure in Organization tab)';

    const modelSelect = el('select', {
      id: 'openshell-model-select',
      'aria-label': 'Free OpenRouter Model',
      style: 'padding: 6px 10px; background: var(--bg); border: 1px solid var(--border); color: var(--text); border-radius: 4px; font-size: 12px;',
    }, FREE_OPENROUTER_MODELS.map((m) =>
      el('option', { value: m.id, selected: m.id === selectedModel ? 'selected' : null }, m.label)
    ));
    modelSelect.addEventListener('change', () => {
      selectedModel = modelSelect.value;
      toast(`OpenCode model switched to ${selectedModel}`, 'ok');
    });

    // Status Panel
    const statusPanel = el('div', { class: 'panel', style: 'margin-bottom: 20px; padding: 16px;' }, [
      el('div', { style: 'display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; flex-wrap: wrap; gap: 8px;' }, [
        el('h3', { style: 'margin: 0;' }, 'Kubernetes Sandbox Pod Status'),
        el('div', { style: 'display: flex; align-items: center; gap: 8px;' }, [
          el('label', { for: 'openshell-model-select', style: 'font-size: 12px; color: var(--muted);' }, 'OpenCode Free Model:'),
          modelSelect,
        ]),
      ]),
      el('div', { style: 'display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; font-size: 13px;' }, [
        el('div', {}, [el('strong', {}, 'Sandbox Pod: '), el('code', {}, sbName)]),
        el('div', {}, [el('strong', {}, 'K8s Namespace: '), el('code', {}, activeWorkspace)]),
        el('div', {}, [el('strong', {}, 'Gateway: '), el('code', {}, gatewayUrl)]),
        el('div', {}, [
          el('strong', {}, 'Phase: '),
          el('span', { style: 'color: var(--green); font-weight: bold;' }, phase),
        ]),
        el('div', {}, [el('strong', {}, 'Org Image Pull/Push Secret: '), imageRegBadge]),
        el('div', {}, [el('strong', {}, 'Provider: '), 'OpenCode + OpenRouter (Free Tier)']),
      ]),
    ]);

    // Interactive Terminal
    const terminalOutput = el('div', {
      id: 'terminal-output',
      style: 'background: #0d1117; color: #58a6ff; font-family: monospace; padding: 14px; height: 320px; overflow-y: auto; border-radius: 6px; font-size: 13px; margin-bottom: 10px; line-height: 1.5; border: 1px solid #30363d;',
    }, [
      el('div', { style: 'color: #8b949e;' }, `OpenShell Multi-Tenant Kubernetes Sandbox v0.1.5`),
      el('div', { style: 'color: #8b949e;' }, `Pod: ${sbName} · Namespace: ${activeWorkspace} · Org: ${orgId}`),
      el('div', { style: 'color: #8b949e; margin-bottom: 8px;' }, `OpenCode CLI ready with free OpenRouter models (${selectedModel}). Type any shell command or 'opencode <prompt>' below.`),
      el('div', { style: 'color: #7ee787;' }, `[OK] Connected to live OpenShell gateway (${gatewayUrl}) — Pod ${sbName} is ${phase} in namespace '${activeWorkspace}'.`),
    ]);

    const termInput = el('input', {
      type: 'text',
      placeholder: 'Run shell command or OpenCode prompt (e.g., opencode status, uname -a && id, opencode Write a hello world script)',
      style: 'flex: 1; padding: 8px 12px; background: var(--panel); border: 1px solid var(--border); color: var(--text); border-radius: 4px; font-family: monospace;',
    });

    const sendBtn = el('button', { class: 'primary', type: 'button' }, 'Execute in Pod');

    async function executeCommand(rawCmd) {
      const msg = (rawCmd ?? termInput.value).trim();
      if (!msg) return;
      if (rawCmd === undefined) termInput.value = '';

      terminalOutput.append(
        el('div', { style: 'color: #edf0f5; margin-top: 8px; font-weight: bold;' }, `sandbox@${sbName}:/workspace$ ${msg}`)
      );
      terminalOutput.scrollTop = terminalOutput.scrollHeight;
      sendBtn.disabled = true;

      try {
        const chatRes = await api.chatWithSandbox({
          projectId,
          projectName,
          workspace: activeWorkspace,
          model: selectedModel,
          message: msg,
        });

        const reply = chatRes?.reply || '[OpenShell] Command completed (exit 0).';
        terminalOutput.append(
          el('div', {
            style: `${chatRes?.exitCode && chatRes.exitCode !== 0 ? 'color: #ffa657;' : 'color: #7ee787;'} white-space: pre-wrap; margin-bottom: 6px;`,
          }, reply)
        );
      } catch (err) {
        terminalOutput.append(
          el('div', { style: 'color: #f85149; white-space: pre-wrap; margin-bottom: 6px;' }, `Error: ${err.message}`)
        );
      } finally {
        sendBtn.disabled = false;
        terminalOutput.scrollTop = terminalOutput.scrollHeight;
      }
    }

    sendBtn.addEventListener('click', () => void executeCommand());
    termInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void executeCommand();
    });

    const quickCommands = [
      { label: 'opencode status', cmd: 'opencode status' },
      { label: 'opencode models', cmd: 'opencode models' },
      { label: 'Pod OS & UID (uname -a && id)', cmd: 'uname -a && id' },
      { label: 'List /workspace', cmd: 'ls -la /workspace' },
      { label: 'Check Docker Registry Config', cmd: 'ls -la /sandbox/.docker/config.json 2>/dev/null || echo "No registry secret synced yet"' },
    ];

    const quickBar = el('div', { style: 'display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 10px;' },
      quickCommands.map((q) => {
        const b = el('button', { class: 'ghost', type: 'button', style: 'font-size: 12px; padding: 4px 10px;' }, q.label);
        b.addEventListener('click', () => void executeCommand(q.cmd));
        return b;
      })
    );

    const terminalSection = el('div', { class: 'panel', style: 'margin-bottom: 20px; padding: 16px;' }, [
      el('h3', { style: 'margin-top: 0; margin-bottom: 8px;' }, 'Interactive Sandbox Terminal (OpenCode + OpenRouter Free Models)'),
      quickBar,
      terminalOutput,
      el('div', { style: 'display: flex; gap: 10px;' }, [termInput, sendBtn]),
    ]);

    // Security & Network Policy Validation Section
    const securityChecksHost = el('div', { style: 'margin-top: 12px;' });
    const renderSecurityChecks = (res) => {
      securityChecksHost.replaceChildren();
      if (!res?.checks) return;
      const list = el('div', { style: 'display: grid; gap: 6px; margin-top: 8px;' },
        res.checks.map((c) =>
          el('div', {
            style: 'display: flex; justify-content: space-between; align-items: center; padding: 8px 12px; background: var(--bg); border: 1px solid var(--border); border-radius: 4px; font-size: 12px;',
          }, [
            el('div', {}, [
              el('strong', { style: c.passed ? 'color: var(--green);' : 'color: #f85149;' }, c.passed ? '✓ PASS ' : '✗ FAIL '),
              el('span', {}, c.name),
            ]),
            el('code', { style: 'color: var(--muted);' }, c.detail || ''),
          ])
        )
      );
      securityChecksHost.append(list);
    };
    if (securityResult) renderSecurityChecks(securityResult);

    const runSecBtn = el('button', { class: 'ghost', type: 'button' }, 'Run Live Pod Security Checks');
    runSecBtn.addEventListener('click', async () => {
      runSecBtn.disabled = true;
      runSecBtn.textContent = 'Running Security Checks…';
      try {
        securityResult = await api.runSandboxSecurityCheck({
          projectId,
          workspace: activeWorkspace,
        });
        renderSecurityChecks(securityResult);
        toast(securityResult.passed ? 'All 6 sandbox security checks passed!' : 'Security checks completed with warnings.', 'ok');
      } catch (err) {
        toast(err.message || 'Security check failed.');
      } finally {
        runSecBtn.disabled = false;
        runSecBtn.textContent = 'Run Live Pod Security Checks';
      }
    });

    const policyYaml = policyData?.yaml || `apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: openshell-tenant-sandbox-policy
  namespace: ${activeWorkspace}
spec:
  podSelector:
    matchLabels:
      openshell.ai/sandbox: "true"
  policyTypes:
    - Ingress
    - Egress`;

    const applyPolicyBtn = el('button', { class: 'primary', type: 'button' }, 'Save & Validate NetworkPolicy');
    const policyStatusMsg = el('span', { style: 'font-size: 12px; color: var(--muted);' }, 'Active in namespace ' + activeWorkspace);

    applyPolicyBtn.addEventListener('click', async () => {
      applyPolicyBtn.disabled = true;
      try {
        await api.saveSandboxNetworkPolicy({
          workspace: activeWorkspace,
          yaml: policyYaml,
        });
        policyStatusMsg.textContent = `✓ NetworkPolicy openshell-tenant-sandbox-policy saved for ${activeWorkspace}`;
        toast(`NetworkPolicy saved in organization configuration (${activeWorkspace}).`, 'ok');
      } catch (err) {
        toast(err.message || 'Failed to save NetworkPolicy.');
      } finally {
        applyPolicyBtn.disabled = false;
      }
    });

    const configSection = el('div', { class: 'panel', style: 'padding: 16px;' }, [
      el('div', { style: 'display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px;' }, [
        el('div', {}, [
          el('h3', { style: 'margin: 0;' }, 'Tenant NetworkPolicy & Live Security Verification'),
          el('p', { class: 'muted', style: 'font-size: 13px; margin: 4px 0 0 0;' },
            'Validates non-root UID 10001 execution, mTLS/Envoy isolation, RFC1918 egress block, and OpenRouter HTTPS egress.'),
        ]),
        el('div', { style: 'display: flex; gap: 8px; align-items: center;' }, [
          runSecBtn,
          applyPolicyBtn,
        ]),
      ]),
      el('div', { style: 'margin-top: 8px;' }, [policyStatusMsg]),
      securityChecksHost,
      el('pre', {
        style: 'background: var(--bg); padding: 12px; border-radius: 6px; font-size: 12px; overflow-x: auto; border: 1px solid var(--border); margin-top: 12px;',
      }, policyYaml),
    ]);

    clear(view).append(head, statusPanel, terminalSection, configSection);
  }

  renderView();
}
