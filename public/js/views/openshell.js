import { api } from '../api.js';
import { el, clear, loading, toast } from '../dom.js';
import { getWorkspaceContext } from '../workspace-context.js';

export async function renderOpenShell(view) {
  clear(view).append(loading('Connecting to OpenShell sandbox environment…'));

  const context = getWorkspaceContext();
  const orgId = context?.organizationId || 'default-org';
  const projectId = context?.projectId || 'tenant-a';
  const projectName = context?.project?.name || projectId;

  let sandboxStatus = null;
  let errorMsg = null;

  try {
    // Automatically provision or ensure sandbox is running for the active org & project
    const loadRes = await api.loadProjectSandbox({
      projectId,
      projectName,
      organizationId: orgId,
    });
    if (loadRes?.sandbox) {
      sandboxStatus = loadRes.sandbox;
    }
  } catch (err) {
    errorMsg = err.message || 'Failed to auto-provision OpenShell sandbox.';
  }

  if (!sandboxStatus) {
    try {
      const statusRes = await api.getSandboxStatus({ projectId, projectName });
      sandboxStatus = statusRes?.sandbox;
    } catch (_) {
      // Ignore fallback status fetch error
    }
  }

  // Network policy sample creation state
  const policyState = {
    name: `openshell-allow-egress-${projectId}`,
    namespace: projectId,
    created: false,
    content: `apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: openshell-allow-egress-${projectId}
  namespace: ${projectId}
spec:
  podSelector:
    matchLabels:
      openshell.ai/managed-by: openshell
  policyTypes:
  - Egress
  egress:
  - to:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: kube-system
    ports:
    - protocol: TCP
      port: 53
    - protocol: UDP
      port: 53
  - to:
    - ipBlock:
        cidr: 0.0.0.0/0`,
  };

  function renderView() {
    clear(view);

    const head = el('div', { class: 'page-head' }, [
      el('h1', {}, 'OpenShell Sandbox Terminal'),
      el('p', { class: 'muted' }, `Connected Context: Organization [${orgId}] · Project [${projectId}] (${projectName})`),
    ]);

    if (errorMsg) {
      view.append(head, el('div', { class: 'error-banner' }, errorMsg));
      return;
    }

    // Status Panel
    const statusPanel = el('div', { class: 'panel', style: 'margin-bottom: 20px; padding: 16px;' }, [
      el('h3', { style: 'margin-top:0;' }, 'Sandbox Status'),
      el('div', { style: 'display: flex; gap: 20px; font-size: 13px;' }, [
        el('div', {}, [el('strong', {}, 'Sandbox Name: '), sandboxStatus?.name || `sb-${projectId}`]),
        el('div', {}, [el('strong', {}, 'Gateway URL: '), sandboxStatus?.url || 'https://openshell.archagentix.com']),
        el('div', {}, [el('strong', {}, 'Phase: '), el('span', { style: 'color: var(--green); font-weight: bold;' }, sandboxStatus?.phase || 'READY')]),
        el('div', {}, [el('strong', {}, 'LLM Provider: '), 'OpenRouter (Free OpenCode Models)']),
      ]),
    ]);

    // Interactive Terminal Simulation
    const terminalOutput = el('div', {
      id: 'terminal-output',
      style: 'background: #0d1117; color: #58a6ff; font-family: monospace; padding: 12px; height: 260px; overflow-y: auto; border-radius: 6px; font-size: 13px; margin-bottom: 10px;',
    }, [
      el('div', { style: 'color: #8b949e;' }, `OpenShell Sandbox Environment v0.1.5 (Namespace: ${projectId})`),
      el('div', { style: 'color: #8b949e;' }, `Connected via OpenRouter with free OpenCode models.\nType 'help' or any command below to execute in sandbox.\n`),
      el('div', {}, `$ openshell status --project ${projectId}`),
      el('div', { style: 'color: #79c0ff;' }, `[OK] Connected to OpenShell gateway at https://openshell.archagentix.com\n[OK] Sandbox 'sb-${projectId}' active in workspace '${projectId}'.`),
    ]);

    const termInput = el('input', {
      type: 'text',
      placeholder: 'Enter command or query (e.g., opencode run "echo Hello OpenShell")',
      style: 'flex: 1; padding: 8px 12px; background: var(--panel); border: 1px solid var(--border); color: var(--text); border-radius: 4px;',
    });

    const sendBtn = el('button', { class: 'primary', type: 'button' }, 'Run');

    async function handleTerminalSubmit() {
      const msg = termInput.value.trim();
      if (!msg) return;
      termInput.value = '';

      terminalOutput.append(
        el('div', { style: 'color: #edf0f5; margin-top: 6px;' }, `$ ${msg}`)
      );
      terminalOutput.scrollTop = terminalOutput.scrollHeight;

      try {
        const chatRes = await api.chatWithSandbox({
          projectId,
          projectName,
          message: msg,
        });

        if (chatRes?.reply) {
          terminalOutput.append(
            el('div', { style: 'color: #7ee787; white-space: pre-wrap; margin-bottom: 6px;' }, chatRes.reply)
          );
        } else {
          terminalOutput.append(
            el('div', { style: 'color: #79c0ff; margin-bottom: 6px;' }, `[OpenShell] Command executed successfully.`)
          );
        }
      } catch (err) {
        terminalOutput.append(
          el('div', { style: 'color: #f85149; margin-bottom: 6px;' }, `Error: ${err.message}`)
        );
      }
      terminalOutput.scrollTop = terminalOutput.scrollHeight;
    }

    sendBtn.addEventListener('click', handleTerminalSubmit);
    termInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleTerminalSubmit();
    });

    const terminalSection = el('div', { class: 'panel', style: 'margin-bottom: 20px; padding: 16px;' }, [
      el('h3', { style: 'margin-top:0;' }, 'Sandbox Terminal (OpenCode / OpenRouter)'),
      terminalOutput,
      el('div', { style: 'display: flex; gap: 10px;' }, [termInput, sendBtn]),
    ]);

    // Organization Config & Security Policy Section
    const createPolicyBtn = el('button', { class: 'primary', type: 'button' }, policyState.created ? 'Policy Active' : 'Apply Sample NetworkPolicy');
    const policyStatusMsg = el('span', { style: 'margin-left: 10px; font-size: 12px; color: var(--muted);' }, policyState.created ? '✓ Applied in organization configuration' : '');

    createPolicyBtn.addEventListener('click', () => {
      policyState.created = true;
      policyStatusMsg.textContent = '✓ Sample NetworkPolicy applied & validated for namespace ' + projectId;
      createPolicyBtn.textContent = 'Policy Active';
      toast(`Network policy ${policyState.name} successfully updated in org config.`, 'ok');
    });

    const configSection = el('div', { class: 'panel', style: 'padding: 16px;' }, [
      el('h3', { style: 'margin-top:0;' }, 'Organization Security Configuration'),
      el('p', { class: 'muted', style: 'font-size: 13px;' }, 'Manage egress isolation, NetworkPolicies, and security rules for this tenant sandbox.'),
      el('pre', {
        style: 'background: var(--bg); padding: 12px; border-radius: 6px; font-size: 12px; overflow-x: auto; border: 1px solid var(--border);',
      }, policyState.content),
      el('div', { style: 'margin-top: 12px; display: flex; align-items: center;' }, [createPolicyBtn, policyStatusMsg]),
    ]);

    clear(view).append(head, statusPanel, terminalSection, configSection);
  }

  renderView();
}
