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
  clear(view).append(loading('Checking OpenShell sandbox status…'));

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
  let isActionLoading = false;

  // 1. Fetch current sandbox status FIRST without forcing auto-creation if not running
  try {
    const statusRes = await api.getSandboxStatus({ projectId, projectName });
    if (statusRes?.sandbox) {
      sandboxStatus = statusRes.sandbox;
    }
    if (statusRes?.orgConfig) {
      orgConfig = statusRes.orgConfig;
    }
    if (statusRes?.networkPolicy) {
      policyData = statusRes.networkPolicy;
    }
  } catch (err) {
    // Non-fatal status fetch
  }

  // If status check returned no active sandbox, auto-load/start it
  if (!sandboxStatus) {
    try {
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
      errorMsg = err.message || 'Failed to connect or provision OpenShell sandbox.';
    }
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

    const isRunning = sandboxStatus?.exists && (sandboxStatus?.phase === 'READY' || sandboxStatus?.phase === 'RUNNING');
    const phase = sandboxStatus?.phase || (sandboxStatus?.exists ? 'STOPPED' : 'NOT_LOADED');
    const sbName = sandboxStatus?.name || `sb-${projectId}`;
    const currentImage = sandboxStatus?.image || 'ubuntu:24.04';
    const gatewayUrl = sandboxStatus?.url || 'https://openshell.archagentix.com';
    const imageRegBadge = orgConfig?.imageRegistryConfigured
      ? `Configured (${orgConfig.imageRegistryUrl || 'ghcr.io'})`
      : 'Not set (configure in Organization tab)';

    // Image Change & Sandbox Lifecycle Control Buttons
    const btnChangeImage = el('button', {
      class: 'ghost',
      type: 'button',
      style: 'font-size: 12px;',
      disabled: isActionLoading ? 'disabled' : null,
    }, currentImage === 'openeuler/opencode:latest' ? 'Image: openeuler/opencode:latest ✓' : 'Switch Image to openeuler/opencode:latest');

    const btnStartStop = el('button', {
      class: isRunning ? 'ghost' : 'primary',
      type: 'button',
      style: `font-size: 12px; ${isRunning ? 'color: #f85149; border-color: #f85149;' : 'background: #238636; border-color: #238636;'}`,
      disabled: isActionLoading ? 'disabled' : null,
    }, isRunning ? 'Stop Sandbox' : 'Start Sandbox');

    btnChangeImage.addEventListener('click', async () => {
      isActionLoading = true;
      btnChangeImage.disabled = true;
      btnChangeImage.textContent = 'Updating Sandbox Image to openeuler/opencode:latest…';
      try {
        const res = await api.loadProjectSandbox({
          projectId,
          projectName,
          organizationId: orgId,
          image: 'openeuler/opencode:latest',
        });
        if (res?.sandbox) sandboxStatus = res.sandbox;
        toast('Sandbox container image updated to openeuler/opencode:latest', 'ok');
      } catch (err) {
        toast(err.message || 'Failed to update sandbox image.');
      } finally {
        isActionLoading = false;
        renderView();
      }
    });

    btnStartStop.addEventListener('click', async () => {
      isActionLoading = true;
      btnStartStop.disabled = true;
      if (isRunning) {
        btnStartStop.textContent = 'Stopping Sandbox…';
        try {
          const res = await api.saveSandboxOrgConfig({
            workspace: activeWorkspace,
            stopSandbox: true,
            projectId,
          });
          if (res?.sandbox) sandboxStatus = res.sandbox;
          else sandboxStatus = { ...sandboxStatus, phase: 'STOPPED', exists: false };
          toast(`Sandbox ${sbName} stopped.`, 'ok');
        } catch (err) {
          toast(err.message || 'Failed to stop sandbox.');
        } finally {
          isActionLoading = false;
          renderView();
        }
      } else {
        btnStartStop.textContent = 'Starting Sandbox…';
        try {
          const res = await api.loadProjectSandbox({
            projectId,
            projectName,
            organizationId: orgId,
            image: currentImage,
          });
          if (res?.sandbox) sandboxStatus = res.sandbox;
          toast(`Sandbox ${sbName} started successfully.`, 'ok');
        } catch (err) {
          toast(err.message || 'Failed to start sandbox.');
        } finally {
          isActionLoading = false;
          renderView();
        }
      }
    });

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
    const phaseBadgeColor = isRunning ? 'var(--green)' : '#ffa657';
    const statusPanel = el('div', { class: 'panel', style: 'margin-bottom: 20px; padding: 16px;' }, [
      el('div', { style: 'display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; flex-wrap: wrap; gap: 8px;' }, [
        el('h3', { style: 'margin: 0;' }, 'Kubernetes Sandbox Pod Status'),
        el('div', { style: 'display: flex; align-items: center; gap: 8px; flex-wrap: wrap;' }, [
          btnChangeImage,
          btnStartStop,
          el('label', { for: 'openshell-model-select', style: 'font-size: 12px; color: var(--muted); margin-left: 8px;' }, 'OpenCode Model:'),
          modelSelect,
        ]),
      ]),
      el('div', { style: 'display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; font-size: 13px;' }, [
        el('div', {}, [el('strong', {}, 'Sandbox Pod: '), el('code', {}, sbName)]),
        el('div', {}, [el('strong', {}, 'Container Image: '), el('code', {}, currentImage)]),
        el('div', {}, [el('strong', {}, 'K8s Namespace: '), el('code', {}, activeWorkspace)]),
        el('div', {}, [
          el('strong', {}, 'Phase: '),
          el('span', { style: `color: ${phaseBadgeColor}; font-weight: bold;` }, phase),
        ]),
        el('div', {}, [el('strong', {}, 'Gateway: '), el('code', {}, gatewayUrl)]),
        el('div', {}, [el('strong', {}, 'Org Image Pull/Push Secret: '), imageRegBadge]),
      ]),
    ]);

    // IF SANDBOX IS NOT LOADED / NOT RUNNING, SHOW DISCONNECTED NOTICE PAGE (OTHER PAGE VISIBLE)
    if (!isRunning) {
      const notLoadedPage = el('div', { class: 'panel', style: 'padding: 30px; text-align: center; margin-top: 10px; background: var(--panel); border-radius: 8px;' }, [
        el('h2', { style: 'margin-bottom: 8px; color: var(--text);' }, `OpenShell Sandbox is currently ${phase}`),
        el('p', { class: 'muted', style: 'max-width: 600px; margin: 0 auto 20px auto; font-size: 14px;' },
          `The sandbox container (${sbName} using image ${currentImage}) is not currently active in namespace '${activeWorkspace}'. Click Start Sandbox above to launch or resume your interactive environment.`),
        el('div', { style: 'display: flex; gap: 12px; justify-content: center;' }, [
          btnStartStop,
          el('a', { href: '#/organization', class: 'button ghost' }, 'Manage Organization Secrets & Config'),
        ]),
      ]);

      clear(view).append(head, statusPanel, notLoadedPage);
      return;
    }

    // Interactive xterm.js Terminal Container
    const termContainer = el('div', {
      id: 'terminal-container',
      style: 'background: #0d1117; padding: 10px; height: 360px; border-radius: 6px; border: 1px solid #30363d; margin-bottom: 10px; font-family: monospace;',
    });

    let xterm = null;
    let fitAddon = null;
    let inputBuffer = '';

    function initXterm() {
      if (typeof window.Terminal !== 'function') {
        termContainer.append(el('div', { style: 'color: #8b949e; padding: 10px;' }, 'Loading xterm.js terminal engine…'));
        return;
      }

      xterm = new window.Terminal({
        cursorBlink: true,
        fontFamily: 'Menlo, Monaco, "Courier New", monospace',
        fontSize: 13,
        theme: {
          background: '#0d1117',
          foreground: '#58a6ff',
          cursor: '#58a6ff',
          selectionBackground: '#163356',
        },
      });

      if (window.FitAddon?.FitAddon) {
        fitAddon = new window.FitAddon.FitAddon();
        xterm.loadAddon(fitAddon);
      }

      xterm.open(termContainer);
      if (fitAddon) {
        setTimeout(() => { try { fitAddon.fit(); } catch (_) {} }, 100);
      }

      xterm.writeln('\x1b[38;5;244mOpenShell Multi-Tenant Kubernetes Sandbox v0.1.5 (xterm.js Active)\x1b[0m');
      xterm.writeln(`\x1b[38;5;244mPod: ${sbName} · Image: ${currentImage} · Namespace: ${activeWorkspace} · Org: ${orgId}\x1b[0m`);
      xterm.writeln(`\x1b[38;5;244mOpenCode CLI ready with free OpenRouter models (${selectedModel}). Type any shell command or 'opencode <prompt>' below.\x1b[0m`);
      xterm.writeln(`\x1b[38;5;82m[OK] Connected to live OpenShell gateway (${gatewayUrl}) — Pod ${sbName} is ${phase} in namespace '${activeWorkspace}'.\x1b[0m\n`);

      const promptStr = `\x1b[38;5;75msandbox@${sbName}:/workspace$\x1b[0m `;
      xterm.write(promptStr);

      xterm.onData(async (data) => {
        const code = data.charCodeAt(0);
        if (code === 13) { // Enter key
          xterm.write('\r\n');
          const cmd = inputBuffer.trim();
          inputBuffer = '';
          if (cmd) {
            try {
              const chatRes = await api.chatWithSandbox({
                projectId,
                projectName,
                workspace: activeWorkspace,
                model: selectedModel,
                message: cmd,
              });
              const reply = chatRes?.reply || '[OpenShell] Command completed (exit 0).';
              xterm.writeln(reply);
            } catch (err) {
              xterm.writeln(`\x1b[31mError: ${err.message || String(err)}\x1b[0m`);
            }
          }
          xterm.write(promptStr);
        } else if (code === 127) { // Backspace
          if (inputBuffer.length > 0) {
            inputBuffer = inputBuffer.slice(0, -1);
            xterm.write('\b \b');
          }
        } else if (code === 3) { // Ctrl+C
          xterm.write('^C\r\n');
          inputBuffer = '';
          xterm.write(promptStr);
        } else if (code >= 32) { // Printable characters
          inputBuffer += data;
          xterm.write(data);
        }
      });
    }

    // Initialize xterm upon DOM mount
    setTimeout(() => initXterm(), 50);

    async function executeCommand(rawCmd) {
      if (!rawCmd) return;
      if (xterm) {
        xterm.writeln(`\x1b[38;5;75msandbox@${sbName}:/workspace$\x1b[0m ${rawCmd}`);
        try {
          const chatRes = await api.chatWithSandbox({
            projectId,
            projectName,
            workspace: activeWorkspace,
            model: selectedModel,
            message: rawCmd,
          });
          const reply = chatRes?.reply || '[OpenShell] Command completed (exit 0).';
          xterm.writeln(reply);
        } catch (err) {
          xterm.writeln(`\x1b[31mError: ${err.message || String(err)}\x1b[0m`);
        }
        xterm.write(`\x1b[38;5;75msandbox@${sbName}:/workspace$\x1b[0m `);
      }
    }

    const quickCommands = [
      { label: 'opencode status', cmd: 'opencode status' },
      { label: 'opencode models', cmd: 'opencode models' },
      { label: 'Pod OS & UID (uname -a && id)', cmd: 'uname -a && id' },
      { label: 'List /workspace', cmd: 'ls -la /workspace' },
      { label: 'Check Container Image', cmd: 'cat /etc/os-release | grep PRETTY_NAME || uname -a' },
    ];

    const quickBar = el('div', { style: 'display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 10px;' },
      quickCommands.map((q) => {
        const b = el('button', { class: 'ghost', type: 'button', style: 'font-size: 12px; padding: 4px 10px;' }, q.label);
        b.addEventListener('click', () => void executeCommand(q.cmd));
        return b;
      })
    );

    const terminalSection = el('div', { class: 'panel', style: 'margin-bottom: 20px; padding: 16px;' }, [
      el('h3', { style: 'margin-top: 0; margin-bottom: 8px;' }, 'Interactive Sandbox Terminal (xterm.js + OpenCode)'),
      quickBar,
      termContainer,
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
