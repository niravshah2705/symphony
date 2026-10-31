import { api } from '../api.js';
import { el, clear, loading, toast } from '../dom.js';
import { getWorkspaceContext } from '../workspace-context.js';

const FREE_OPENROUTER_MODELS = [
  { id: 'openrouter/free', label: 'openrouter/free (Auto Router — Free)' },
  { id: 'qwen/qwen3-coder:free', label: 'qwen/qwen3-coder:free' },
  { id: 'meta-llama/llama-3.3-70b-instruct:free', label: 'meta-llama/llama-3.3-70b-instruct:free' },
  { id: 'google/gemma-3-27b-it:free', label: 'google/gemma-3-27b-it:free' },
];

const PRESET_SANDBOX_IMAGES = [
  { id: 'ubuntu:24.04', label: 'ubuntu:24.04 (Default Ubuntu 24.04 LTS)' },
  { id: 'openeuler/opencode:latest', label: 'openeuler/opencode:latest (OpenEuler + OpenCode)' },
  { id: 'python:3.12-slim', label: 'python:3.12-slim (Python 3.12 Runtime)' },
  { id: 'node:22-bookworm', label: 'node:22-bookworm (Node.js 22 LTS)' },
  { id: 'alpine:3.20', label: 'alpine:3.20 (Minimal Alpine Linux)' },
];

// Per-sandbox interactive terminal session state (persisted across tab switches in browser memory)
const terminalSessions = new Map();

function getOrCreateTerminalSession(sandboxName) {
  if (!terminalSessions.has(sandboxName)) {
    terminalSessions.set(sandboxName, {
      cwd: '/workspace',
      user: 'sandbox',
      hostname: sandboxName,
      history: [],
      historyIndex: -1,
      transcript: [],
    });
  }
  return terminalSessions.get(sandboxName);
}

function normalizeCrLf(text) {
  return String(text || '').replace(/\r?\n/g, '\r\n');
}

export async function renderOpenShell(view) {
  clear(view).append(loading('Checking OpenShell sandboxes & gateway status…'));

  const context = getWorkspaceContext();
  const orgId = context?.organizationId || 'default-org';
  const projectId = context?.projectId || 'default';
  const projectName = context?.project?.name || projectId;

  let sandboxStatus = null;
  let sandboxesList = [];
  let activeSandboxName = null;
  let orgConfig = null;
  let policyData = null;
  let securityResult = null;
  let selectedModel = FREE_OPENROUTER_MODELS[0].id;
  let isActionLoading = false;

  async function refreshStatus(targetSandboxName) {
    try {
      const statusRes = await api.getSandboxStatus({
        projectId,
        projectName,
        ...(targetSandboxName ? { sandboxName: targetSandboxName } : {}),
      });
      if (statusRes?.sandbox) {
        sandboxStatus = statusRes.sandbox;
        activeSandboxName = sandboxStatus.name;
      }
      if (Array.isArray(statusRes?.sandboxes) && statusRes.sandboxes.length > 0) {
        sandboxesList = statusRes.sandboxes;
      }
      if (statusRes?.orgConfig) {
        orgConfig = statusRes.orgConfig;
      }
      if (statusRes?.networkPolicy) {
        policyData = statusRes.networkPolicy;
      }
    } catch (_) {
      // Non-fatal initial status fetch
    }
  }

  await refreshStatus();

  // Auto-provision default project sandbox on first visit if not yet created (unless explicitly stopped)
  if (!sandboxStatus || (!sandboxStatus.exists && sandboxStatus.phase !== 'STOPPED')) {
    try {
      const loadRes = await api.loadProjectSandbox({
        projectId,
        projectName,
        organizationId: orgId,
      });
      if (loadRes?.sandbox) {
        sandboxStatus = loadRes.sandbox;
        activeSandboxName = sandboxStatus.name;
      }
      if (Array.isArray(loadRes?.sandboxes) && loadRes.sandboxes.length > 0) {
        sandboxesList = loadRes.sandboxes;
      }
    } catch (_) {
      // Keep page renderable even if gateway is unreachable
    }
  }

  if (sandboxesList.length === 0 && sandboxStatus) {
    sandboxesList = [sandboxStatus];
  }

  const activeWorkspace = sandboxStatus?.workspace || orgConfig?.workspace || 'tenant-a';

  if (!policyData) {
    try {
      const polRes = await api.getSandboxNetworkPolicy({ workspace: activeWorkspace });
      policyData = polRes?.networkPolicy || polRes?.policy || null;
    } catch (_) {
      // Ignore fallback policy fetch error
    }
  }

  function upsertSandboxInLocalList(sb) {
    if (!sb || !sb.name) return;
    const idx = sandboxesList.findIndex((item) => item && item.name === sb.name);
    if (idx >= 0) {
      sandboxesList[idx] = { ...sandboxesList[idx], ...sb };
    } else {
      sandboxesList.push(sb);
    }
  }

  function renderView() {
    clear(view);

    const sbName = activeSandboxName || sandboxStatus?.name || `sb-${projectId}`;
    const currentSandbox =
      sandboxesList.find((s) => s && s.name === sbName) || sandboxStatus || {};
    const phase =
      currentSandbox.phase || (currentSandbox.exists ? 'READY' : 'NOT_LOADED');
    const isRunning =
      Boolean(currentSandbox.exists) &&
      (phase === 'READY' || phase === 'RUNNING');
    const currentImage =
      currentSandbox.image || orgConfig?.defaultImage || 'ubuntu:24.04';
    const gatewayUrl =
      currentSandbox.url || orgConfig?.openshellUrl || 'https://openshell.archagentix.com';
    const imageRegBadge =
      currentSandbox.hasImageRegistrySecret || orgConfig?.hasImageRegistrySecret
        ? `Configured (${orgConfig?.imageRegistryUrl || currentSandbox.imageRegistryUrl || 'ghcr.io'})`
        : 'Public Pull (configure in Organization tab)';

    const session = getOrCreateTerminalSession(sbName);

    const head = el(
      'div',
      {
        class: 'page-head',
        style:
          'display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 12px;',
      },
      [
        el('div', {}, [
          el('h1', {}, 'OpenShell Interactive Sandboxes & Terminal'),
          el(
            'p',
            { class: 'muted' },
            `Organization [${orgId}] · Project [${projectName}] · Kubernetes Namespace [${activeWorkspace}] · Active Sandbox [${sbName}]`
          ),
        ]),
        el('div', { style: 'display: flex; gap: 8px; align-items: center;' }, [
          el(
            'a',
            { href: '#/organization', class: 'button ghost' },
            'Organization Secrets & NetworkPolicy'
          ),
        ]),
      ]
    );

    // ── 1. Multi-Sandbox Switcher & Creation Bar ────────────────────────────
    const sandboxTabsWrap = el(
      'div',
      { style: 'display: flex; gap: 8px; flex-wrap: wrap; align-items: center;' },
      sandboxesList.map((sb, idx) => {
        const isCurrent = sb.name === sbName;
        const sbPhase = sb.phase || (sb.exists ? 'READY' : 'NOT_LOADED');
        const sbReady = sb.exists && (sbPhase === 'READY' || sbPhase === 'RUNNING');
        const dotColor = sbReady ? '#3fb950' : '#d29922';

        const tabBtn = el(
          'button',
          {
            type: 'button',
            class: isCurrent ? 'primary' : 'ghost',
            'data-sandbox-tab': sb.name,
            style: `display: inline-flex; align-items: center; gap: 8px; font-size: 12px; padding: 6px 12px; border-radius: 6px; ${
              isCurrent ? '' : 'border: 1px solid var(--border);'
            }`,
            disabled: isActionLoading ? 'disabled' : null,
          },
          [
            el('span', {
              style: `width: 8px; height: 8px; border-radius: 50%; background: ${dotColor}; display: inline-block;`,
            }),
            el('strong', {}, sb.label || sb.name),
            el(
              'code',
              {
                style:
                  'font-size: 11px; opacity: 0.85; background: rgba(0,0,0,0.2); padding: 1px 5px; border-radius: 4px;',
              },
              sb.image || 'ubuntu:24.04'
            ),
          ]
        );

        tabBtn.addEventListener('click', async () => {
          if (sb.name === sbName) return;
          activeSandboxName = sb.name;
          sandboxStatus = sb;
          await refreshStatus(sb.name);
          renderView();
        });

        // Allow deleting secondary sandboxes when user has more than 1
        if (sandboxesList.length > 1 && idx > 0) {
          const delBtn = el(
            'button',
            {
              type: 'button',
              class: 'ghost',
              title: `Delete sandbox ${sb.name}`,
              style:
                'font-size: 11px; padding: 4px 7px; color: #f85149; border-color: transparent;',
              disabled: isActionLoading ? 'disabled' : null,
            },
            '×'
          );
          delBtn.addEventListener('click', async (ev) => {
            ev.stopPropagation();
            isActionLoading = true;
            renderView();
            try {
              const delRes = await api.deleteSandbox(sb.name, {
                projectId,
                projectName,
              });
              terminalSessions.delete(sb.name);
              if (Array.isArray(delRes?.sandboxes) && delRes.sandboxes.length > 0) {
                sandboxesList = delRes.sandboxes;
              } else {
                sandboxesList = sandboxesList.filter((item) => item.name !== sb.name);
              }
              if (activeSandboxName === sb.name) {
                activeSandboxName = sandboxesList[0]?.name || null;
                sandboxStatus = sandboxesList[0] || null;
              }
              toast(`Deleted sandbox ${sb.name}`, 'ok');
            } catch (err) {
              toast(err.message || `Failed to delete sandbox ${sb.name}`);
            } finally {
              isActionLoading = false;
              renderView();
            }
          });
          return el(
            'div',
            { style: 'display: inline-flex; align-items: center; gap: 2px;' },
            [tabBtn, delBtn]
          );
        }

        return tabBtn;
      })
    );

    const newSandboxNameInput = el('input', {
      type: 'text',
      id: 'new-sandbox-name-input',
      placeholder: 'New sandbox name (e.g. sb-worker-2)',
      style:
        'padding: 6px 10px; font-size: 12px; width: 200px; background: var(--bg); border: 1px solid var(--border); color: var(--text); border-radius: 4px;',
    });

    const newSandboxImageSelect = el(
      'select',
      {
        id: 'new-sandbox-image-select',
        'aria-label': 'New Sandbox Container Image',
        style:
          'padding: 6px 10px; font-size: 12px; background: var(--bg); border: 1px solid var(--border); color: var(--text); border-radius: 4px;',
      },
      PRESET_SANDBOX_IMAGES.map((img) =>
        el(
          'option',
          { value: img.id, selected: img.id === currentImage ? 'selected' : null },
          img.id
        )
      )
    );

    const btnCreateSandbox = el(
      'button',
      {
        type: 'button',
        class: 'ghost',
        id: 'create-sandbox-btn',
        style: 'font-size: 12px; padding: 6px 12px;',
        disabled: isActionLoading ? 'disabled' : null,
      },
      '+ Create Sandbox'
    );

    btnCreateSandbox.addEventListener('click', async () => {
      const rawName = newSandboxNameInput.value.trim() || `sb-${projectName}-${sandboxesList.length + 1}`;
      const chosenImage = newSandboxImageSelect.value || currentImage;
      isActionLoading = true;
      btnCreateSandbox.disabled = true;
      btnCreateSandbox.textContent = 'Creating Sandbox…';
      try {
        const res = await api.createSandbox({
          projectId,
          projectName,
          organizationId: orgId,
          sandboxName: rawName,
          label: rawName,
          image: chosenImage,
        });
        if (res?.sandbox) {
          sandboxStatus = res.sandbox;
          activeSandboxName = res.sandbox.name;
          upsertSandboxInLocalList(res.sandbox);
        }
        if (Array.isArray(res?.sandboxes) && res.sandboxes.length > 0) {
          sandboxesList = res.sandboxes;
        }
        toast(`Created sandbox ${activeSandboxName} with image ${chosenImage}`, 'ok');
      } catch (err) {
        toast(err.message || 'Failed to create sandbox.');
      } finally {
        isActionLoading = false;
        renderView();
      }
    });

    const multiSandboxPanel = el(
      'div',
      { class: 'panel', style: 'margin-bottom: 16px; padding: 14px 16px;' },
      [
        el(
          'div',
          {
            style:
              'display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px;',
          },
          [
            el('div', { style: 'display: flex; align-items: center; gap: 10px; flex-wrap: wrap;' }, [
              el(
                'span',
                { style: 'font-size: 12px; font-weight: 600; color: var(--muted); text-transform: uppercase;' },
                `Sandboxes (${sandboxesList.length}):`
              ),
              sandboxTabsWrap,
            ]),
            el('div', { style: 'display: flex; align-items: center; gap: 8px; flex-wrap: wrap;' }, [
              newSandboxNameInput,
              newSandboxImageSelect,
              btnCreateSandbox,
            ]),
          ]
        ),
      ]
    );

    // ── 2. Image Switcher (Preset + Custom + Quick openeuler/opencode:latest) & Lifecycle Controls ──
    const isPresetImage = PRESET_SANDBOX_IMAGES.some((p) => p.id === currentImage);
    const imageSelect = el(
      'select',
      {
        id: 'openshell-image-select',
        'aria-label': 'Sandbox Container Image',
        style:
          'padding: 6px 10px; background: var(--bg); border: 1px solid var(--border); color: var(--text); border-radius: 4px; font-size: 12px;',
      },
      [
        ...PRESET_SANDBOX_IMAGES.map((img) =>
          el(
            'option',
            { value: img.id, selected: img.id === currentImage ? 'selected' : null },
            img.label
          )
        ),
        ...(!isPresetImage
          ? [
              el(
                'option',
                { value: currentImage, selected: 'selected' },
                `${currentImage} (Active Custom)`
              ),
            ]
          : []),
      ]
    );

    const customImageInput = el('input', {
      type: 'text',
      id: 'openshell-custom-image-input',
      value: currentImage,
      placeholder: 'Container image (e.g. openeuler/opencode:latest)',
      style:
        'padding: 6px 10px; font-size: 12px; width: 220px; background: var(--bg); border: 1px solid var(--border); color: var(--text); border-radius: 4px;',
    });

    imageSelect.addEventListener('change', () => {
      customImageInput.value = imageSelect.value;
    });

    async function applySandboxImage(targetImg) {
      const nextImage = String(targetImg || '').trim();
      if (!nextImage) {
        toast('Please enter a container image tag.');
        return;
      }
      isActionLoading = true;
      renderView();
      try {
        const res = await api.changeSandboxImage({
          projectId,
          projectName,
          organizationId: orgId,
          sandboxName: sbName,
          image: nextImage,
        });
        if (res?.sandbox) {
          sandboxStatus = res.sandbox;
          upsertSandboxInLocalList(res.sandbox);
        }
        if (Array.isArray(res?.sandboxes) && res.sandboxes.length > 0) {
          sandboxesList = res.sandboxes;
        }
        session.transcript.push(
          `\x1b[38;5;82m[OpenShell] Container image for ${sbName} updated to ${nextImage}\x1b[0m`
        );
        toast(`Sandbox ${sbName} container image updated to ${nextImage}`, 'ok');
      } catch (err) {
        toast(err.message || 'Failed to update sandbox image.');
      } finally {
        isActionLoading = false;
        renderView();
      }
    }

    const btnApplyCustomImage = el(
      'button',
      {
        class: 'ghost',
        type: 'button',
        id: 'apply-image-btn',
        style: 'font-size: 12px;',
        disabled: isActionLoading ? 'disabled' : null,
      },
      'Apply Image'
    );
    btnApplyCustomImage.addEventListener('click', () => {
      void applySandboxImage(customImageInput.value || imageSelect.value);
    });

    const btnChangeImage = el(
      'button',
      {
        class: 'ghost',
        type: 'button',
        style: 'font-size: 12px;',
        disabled: isActionLoading ? 'disabled' : null,
      },
      currentImage === 'openeuler/opencode:latest'
        ? 'Image: openeuler/opencode:latest ✓'
        : 'Switch Image to openeuler/opencode:latest'
    );
    btnChangeImage.addEventListener('click', () => {
      void applySandboxImage('openeuler/opencode:latest');
    });

    const btnStartStop = el(
      'button',
      {
        class: isRunning ? 'ghost' : 'primary',
        type: 'button',
        style: `font-size: 12px; ${
          isRunning
            ? 'color: #f85149; border-color: #f85149;'
            : 'background: #238636; border-color: #238636;'
        }`,
        disabled: isActionLoading ? 'disabled' : null,
      },
      isRunning ? 'Stop Sandbox' : 'Start Sandbox'
    );

    btnStartStop.addEventListener('click', async () => {
      isActionLoading = true;
      btnStartStop.disabled = true;
      if (isRunning) {
        btnStartStop.textContent = 'Stopping Sandbox…';
        try {
          const res = await api.stopSandbox({
            projectId,
            projectName,
            organizationId: orgId,
            sandboxName: sbName,
          });
          if (res?.sandbox) {
            sandboxStatus = res.sandbox;
            upsertSandboxInLocalList(res.sandbox);
          } else {
            sandboxStatus = { ...currentSandbox, phase: 'STOPPED', exists: true };
            upsertSandboxInLocalList(sandboxStatus);
          }
          if (Array.isArray(res?.sandboxes) && res.sandboxes.length > 0) {
            sandboxesList = res.sandboxes;
          }
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
          const res = await api.startSandbox({
            projectId,
            projectName,
            organizationId: orgId,
            sandboxName: sbName,
            image: customImageInput.value.trim() || currentImage,
          });
          if (res?.sandbox) {
            sandboxStatus = res.sandbox;
            upsertSandboxInLocalList(res.sandbox);
          }
          if (Array.isArray(res?.sandboxes) && res.sandboxes.length > 0) {
            sandboxesList = res.sandboxes;
          }
          toast(`Sandbox ${sbName} started successfully.`, 'ok');
        } catch (err) {
          toast(err.message || 'Failed to start sandbox.');
        } finally {
          isActionLoading = false;
          renderView();
        }
      }
    });

    const modelSelect = el(
      'select',
      {
        id: 'openshell-model-select',
        'aria-label': 'Free OpenRouter Model',
        style:
          'padding: 6px 10px; background: var(--bg); border: 1px solid var(--border); color: var(--text); border-radius: 4px; font-size: 12px;',
      },
      FREE_OPENROUTER_MODELS.map((m) =>
        el(
          'option',
          { value: m.id, selected: m.id === selectedModel ? 'selected' : null },
          m.label
        )
      )
    );
    modelSelect.addEventListener('change', () => {
      selectedModel = modelSelect.value;
      toast(`OpenCode model switched to ${selectedModel}`, 'ok');
    });

    // Status & Image Control Panel
    const phaseBadgeColor = isRunning ? 'var(--green)' : '#ffa657';
    const statusPanel = el(
      'div',
      { class: 'panel', style: 'margin-bottom: 20px; padding: 16px;' },
      [
        el(
          'div',
          {
            style:
              'display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; flex-wrap: wrap; gap: 8px;',
          },
          [
            el('h3', { style: 'margin: 0;' }, `Kubernetes Sandbox Pod Status (${sbName})`),
            el(
              'div',
              { style: 'display: flex; align-items: center; gap: 8px; flex-wrap: wrap;' },
              [
                imageSelect,
                customImageInput,
                btnApplyCustomImage,
                btnChangeImage,
                btnStartStop,
                el(
                  'label',
                  {
                    for: 'openshell-model-select',
                    style: 'font-size: 12px; color: var(--muted); margin-left: 4px;',
                  },
                  'Model:'
                ),
                modelSelect,
              ]
            ),
          ]
        ),
        el(
          'div',
          {
            style:
              'display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 12px; font-size: 13px;',
          },
          [
            el('div', {}, [el('strong', {}, 'Sandbox Pod: '), el('code', {}, sbName)]),
            el('div', {}, [el('strong', {}, 'Container Image: '), el('code', {}, currentImage)]),
            el('div', {}, [el('strong', {}, 'Working Directory: '), el('code', {}, session.cwd)]),
            el('div', {}, [el('strong', {}, 'K8s Namespace: '), el('code', {}, activeWorkspace)]),
            el('div', {}, [
              el('strong', {}, 'Phase: '),
              el('span', { style: `color: ${phaseBadgeColor}; font-weight: bold;` }, phase),
            ]),
            el('div', {}, [el('strong', {}, 'Gateway: '), el('code', {}, gatewayUrl)]),
            el('div', {}, [el('strong', {}, 'Org Registry Secret: '), imageRegBadge]),
          ]
        ),
      ]
    );

    // IF SELECTED SANDBOX IS STOPPED / NOT LOADED, SHOW NON-LOADED PAGE WHILE KEEPING MULTI-SANDBOX SWITCHER & OTHER PAGES ACCESSIBLE
    if (!isRunning) {
      const startStoppedBtn = el(
        'button',
        {
          class: 'primary',
          type: 'button',
          style: 'background: #238636; border-color: #238636;',
          disabled: isActionLoading ? 'disabled' : null,
        },
        `Start Sandbox (${sbName})`
      );
      startStoppedBtn.addEventListener('click', () => btnStartStop.click());

      const notLoadedPage = el(
        'div',
        {
          class: 'panel',
          style:
            'padding: 30px; text-align: center; margin-top: 10px; background: var(--panel); border-radius: 8px;',
        },
        [
          el(
            'h2',
            { style: 'margin-bottom: 8px; color: var(--text);' },
            `OpenShell Sandbox "${sbName}" is currently ${phase}`
          ),
          el(
            'p',
            {
              class: 'muted',
              style: 'max-width: 640px; margin: 0 auto 20px auto; font-size: 14px;',
            },
            `The sandbox container (${sbName} configured with image ${currentImage}) is not currently running in namespace '${activeWorkspace}'. You can switch to another active sandbox above, change its container image, or click Start Sandbox to launch your interactive shell session.`
          ),
          el('div', { style: 'display: flex; gap: 12px; justify-content: center; flex-wrap: wrap;' }, [
            startStoppedBtn,
            el('a', { href: '#/issues', class: 'button ghost' }, 'Go to Issues'),
            el('a', { href: '#/organization', class: 'button ghost' }, 'Manage Organization Secrets & Config'),
          ]),
        ]
      );

      clear(view).append(head, multiSandboxPanel, statusPanel, notLoadedPage);
      return;
    }

    // ── 3. True Interactive xterm.js Terminal + Direct Shell Execution ──────
    const cwdBadge = el(
      'code',
      {
        id: 'openshell-cwd-badge',
        style: 'font-size: 12px; color: #58a6ff; background: #0d1117; padding: 3px 8px; border-radius: 4px; border: 1px solid #30363d;',
      },
      `${session.user}@${sbName}:${session.cwd}$`
    );

    const termContainer = el('div', {
      id: 'terminal-container',
      style:
        'background: #0d1117; padding: 10px; height: 400px; border-radius: 6px; border: 1px solid #30363d; margin-bottom: 10px; font-family: monospace; overflow: hidden;',
    });

    let xterm = null;
    let fitAddon = null;
    let inputBuffer = '';
    let cursorPos = 0;
    let isExecuting = false;

    function formatPrompt() {
      return `\x1b[1;32m${session.user || 'sandbox'}@${sbName}\x1b[0m:\x1b[1;34m${session.cwd || '/workspace'}\x1b[0m$ `;
    }

    function updatePromptBadge() {
      cwdBadge.textContent = `${session.user || 'sandbox'}@${sbName}:${session.cwd || '/workspace'}$`;
    }

    function redrawInputLine(newBuffer, newCursorPos = newBuffer.length) {
      if (!xterm) return;
      inputBuffer = newBuffer;
      cursorPos = Math.max(0, Math.min(newCursorPos, inputBuffer.length));
      // Clear current line, write prompt + buffer, and position cursor
      xterm.write('\r\x1b[K' + formatPrompt() + inputBuffer);
      const backCount = inputBuffer.length - cursorPos;
      if (backCount > 0) {
        xterm.write(`\x1b[${backCount}D`);
      }
    }

    async function runInteractiveCommand(rawCommand, { echoCommand = false } = {}) {
      const cmd = String(rawCommand ?? '').trim();
      if (!cmd) {
        if (xterm) xterm.write(formatPrompt());
        return;
      }

      if (cmd === 'clear' || cmd === 'cls') {
        session.transcript = [];
        if (xterm) {
          xterm.clear();
          xterm.write(formatPrompt());
        }
        return;
      }

      if (session.history[session.history.length - 1] !== cmd) {
        session.history.push(cmd);
      }
      session.historyIndex = session.history.length;

      if (echoCommand && xterm) {
        xterm.write('\r\x1b[K' + formatPrompt() + cmd + '\r\n');
      }
      session.transcript.push(`${session.user}@${sbName}:${session.cwd}$ ${cmd}`);

      isExecuting = true;
      try {
        const execRes = await api.execInSandbox({
          projectId,
          projectName,
          sandboxName: sbName,
          workspace: activeWorkspace,
          image: currentImage,
          command: cmd,
          cwd: session.cwd,
          interactive: true,
        });

        if (execRes?.cwd) session.cwd = execRes.cwd;
        if (execRes?.user) session.user = execRes.user;
        if (execRes?.hostname) session.hostname = execRes.hostname;
        updatePromptBadge();

        const out = String(execRes?.stdout || '');
        const errOut = String(execRes?.stderr || '');

        if (out) {
          const normalized = normalizeCrLf(out.replace(/\r?\n$/, ''));
          session.transcript.push(normalized);
          if (xterm) xterm.writeln(normalized);
        }
        if (errOut) {
          const normalizedErr = `\x1b[31m${normalizeCrLf(errOut.replace(/\r?\n$/, ''))}\x1b[0m`;
          session.transcript.push(normalizedErr);
          if (xterm) xterm.writeln(normalizedErr);
        }
        if (!out && !errOut && typeof execRes?.exitCode === 'number' && execRes.exitCode !== 0) {
          const codeMsg = `\x1b[33m[exit ${execRes.exitCode}]\x1b[0m`;
          session.transcript.push(codeMsg);
          if (xterm) xterm.writeln(codeMsg);
        }
      } catch (err) {
        const errMsg = `\x1b[31mError: ${err.message || String(err)}\x1b[0m`;
        session.transcript.push(errMsg);
        if (xterm) xterm.writeln(errMsg);
      } finally {
        isExecuting = false;
        inputBuffer = '';
        cursorPos = 0;
        if (xterm) {
          xterm.write(formatPrompt());
        }
      }
    }

    async function handleTabCompletion() {
      if (!xterm || isExecuting) return;
      const beforeCursor = inputBuffer.slice(0, cursorPos);
      const tokenMatch = beforeCursor.match(/(\S+)$/);
      const prefix = tokenMatch ? tokenMatch[1] : '';
      try {
        const res = await api.execInSandbox({
          projectId,
          projectName,
          sandboxName: sbName,
          workspace: activeWorkspace,
          cwd: session.cwd,
          prefix,
          autocomplete: true,
        });
        const matches = Array.isArray(res?.matches) ? res.matches : [];
        if (matches.length === 1) {
          const completion = matches[0];
          const replaced =
            beforeCursor.slice(0, beforeCursor.length - prefix.length) +
            completion +
            inputBuffer.slice(cursorPos);
          const nextCursor = beforeCursor.length - prefix.length + completion.length;
          redrawInputLine(replaced, nextCursor);
        } else if (matches.length > 1) {
          xterm.write('\r\n' + matches.join('  ') + '\r\n');
          redrawInputLine(inputBuffer, cursorPos);
        }
      } catch (_) {
        // Ignore autocomplete errors
      }
    }

    function initXterm() {
      if (typeof window.Terminal !== 'function') {
        termContainer.append(
          el(
            'div',
            { style: 'color: #c9d1d9; padding: 10px; font-size: 13px;' },
            [
              el('div', { style: 'color: #58a6ff; margin-bottom: 6px;' }, `Interactive OpenShell Session — ${sbName} (${currentImage})`),
              el('div', { style: 'color: #8b949e;' }, 'Use the interactive command input below or quick-action buttons to execute commands in the live container.'),
            ]
          )
        );
        return;
      }

      xterm = new window.Terminal({
        cursorBlink: true,
        convertEol: true,
        scrollback: 5000,
        fontFamily: 'Menlo, Monaco, "Courier New", monospace',
        fontSize: 13,
        theme: {
          background: '#0d1117',
          foreground: '#e6edf3',
          cursor: '#58a6ff',
          selectionBackground: '#1f6feb66',
        },
      });

      if (window.FitAddon?.FitAddon) {
        fitAddon = new window.FitAddon.FitAddon();
        xterm.loadAddon(fitAddon);
      }

      xterm.open(termContainer);
      if (fitAddon) {
        setTimeout(() => {
          try {
            fitAddon.fit();
          } catch (_) {}
        }, 80);
      }

      xterm.writeln(
        `\x1b[38;5;244mNVIDIA OpenShell Interactive Shell — Pod: ${sbName} · Image: ${currentImage} · Namespace: ${activeWorkspace}\x1b[0m`
      );
      xterm.writeln(
        `\x1b[38;5;244mStateful bash/sh session (supports cd, export, Tab completion, Up/Down history, Ctrl+C, Ctrl+L, and opencode CLI).\x1b[0m`
      );
      xterm.writeln(
        `\x1b[38;5;82m[CONNECTED] ${gatewayUrl} — ${sbName} (${phase}) in ${session.cwd}\x1b[0m\r\n`
      );

      // Replay recent transcript lines for this sandbox if switching back
      for (const line of session.transcript.slice(-40)) {
        xterm.writeln(normalizeCrLf(line));
      }

      xterm.write(formatPrompt());
      xterm.focus();

      xterm.onData(async (data) => {
        if (isExecuting) {
          if (data === '\x03') {
            xterm.write('^C\r\n');
            isExecuting = false;
            inputBuffer = '';
            cursorPos = 0;
            xterm.write(formatPrompt());
          }
          return;
        }

        // Escape sequences (Arrow keys, Home, End, Delete)
        if (data === '\x1b[A') {
          // Up arrow — previous command in history
          if (session.history.length > 0 && session.historyIndex > 0) {
            session.historyIndex -= 1;
            redrawInputLine(session.history[session.historyIndex]);
          }
          return;
        }
        if (data === '\x1b[B') {
          // Down arrow — next command in history
          if (session.historyIndex < session.history.length - 1) {
            session.historyIndex += 1;
            redrawInputLine(session.history[session.historyIndex]);
          } else {
            session.historyIndex = session.history.length;
            redrawInputLine('');
          }
          return;
        }
        if (data === '\x1b[D') {
          // Left arrow
          if (cursorPos > 0) {
            cursorPos -= 1;
            xterm.write('\x1b[D');
          }
          return;
        }
        if (data === '\x1b[C') {
          // Right arrow
          if (cursorPos < inputBuffer.length) {
            cursorPos += 1;
            xterm.write('\x1b[C');
          }
          return;
        }
        if (data === '\x1b[H' || data === '\x01') {
          // Home or Ctrl+A
          redrawInputLine(inputBuffer, 0);
          return;
        }
        if (data === '\x1b[F' || data === '\x05') {
          // End or Ctrl+E
          redrawInputLine(inputBuffer, inputBuffer.length);
          return;
        }
        if (data === '\x1b[3~') {
          // Delete key
          if (cursorPos < inputBuffer.length) {
            const nextBuf = inputBuffer.slice(0, cursorPos) + inputBuffer.slice(cursorPos + 1);
            redrawInputLine(nextBuf, cursorPos);
          }
          return;
        }

        const code = data.charCodeAt(0);
        if (code === 13) {
          // Enter key
          xterm.write('\r\n');
          const cmd = inputBuffer;
          inputBuffer = '';
          cursorPos = 0;
          await runInteractiveCommand(cmd, { echoCommand: false });
        } else if (code === 127 || code === 8) {
          // Backspace
          if (cursorPos > 0) {
            const nextBuf = inputBuffer.slice(0, cursorPos - 1) + inputBuffer.slice(cursorPos);
            redrawInputLine(nextBuf, cursorPos - 1);
          }
        } else if (code === 9) {
          // Tab completion
          await handleTabCompletion();
        } else if (code === 3) {
          // Ctrl+C
          xterm.write('^C\r\n');
          inputBuffer = '';
          cursorPos = 0;
          xterm.write(formatPrompt());
        } else if (code === 12) {
          // Ctrl+L (clear screen)
          xterm.clear();
          redrawInputLine(inputBuffer, cursorPos);
        } else if (code >= 32) {
          // Printable character(s) or multi-line paste
          const cleanChunk = data.replace(/\r?\n/g, ' ');
          const nextBuf =
            inputBuffer.slice(0, cursorPos) + cleanChunk + inputBuffer.slice(cursorPos);
          redrawInputLine(nextBuf, cursorPos + cleanChunk.length);
        }
      });
    }

    setTimeout(() => initXterm(), 40);

    // Direct interactive command input bar (works alongside xterm.js keyboard input)
    const directCommandInput = el('input', {
      type: 'text',
      id: 'openshell-command-input',
      placeholder: `Run interactive command in ${sbName} (${session.cwd}) — e.g. cd /workspace && ls -la, opencode status, python3 -V…`,
      style:
        'flex: 1; padding: 8px 12px; font-family: monospace; font-size: 13px; background: #0d1117; border: 1px solid #30363d; color: #e6edf3; border-radius: 4px;',
    });

    const btnRunCommand = el(
      'button',
      {
        type: 'button',
        class: 'primary',
        id: 'openshell-run-cmd-btn',
        style: 'font-size: 12px; padding: 8px 16px;',
      },
      'Run Command'
    );

    const triggerBarCommand = async () => {
      const cmd = directCommandInput.value.trim();
      if (!cmd) return;
      directCommandInput.value = '';
      await runInteractiveCommand(cmd, { echoCommand: true });
    };

    btnRunCommand.addEventListener('click', () => {
      void triggerBarCommand();
    });
    directCommandInput.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        void triggerBarCommand();
      }
    });

    const commandBar = el(
      'div',
      { style: 'display: flex; gap: 8px; align-items: center; margin-top: 8px;' },
      [cwdBadge, directCommandInput, btnRunCommand]
    );

    const quickCommands = [
      { label: 'pwd && ls -la', cmd: 'pwd && ls -la' },
      { label: 'opencode status', cmd: 'opencode status' },
      { label: 'opencode models', cmd: 'opencode models' },
      { label: 'Pod OS & UID (uname -a && id)', cmd: 'uname -a && id' },
      {
        label: 'Check Container Image',
        cmd: 'echo "IMAGE=${AIFLEET_SANDBOX_IMAGE:-ubuntu:24.04}" && (cat /etc/os-release 2>/dev/null | head -n 4 || uname -a)',
      },
      { label: 'Clear Terminal', cmd: 'clear' },
    ];

    const quickBar = el(
      'div',
      { style: 'display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 10px;' },
      quickCommands.map((q) => {
        const b = el(
          'button',
          {
            class: 'ghost',
            type: 'button',
            style: 'font-size: 12px; padding: 4px 10px;',
          },
          q.label
        );
        b.addEventListener('click', () => void runInteractiveCommand(q.cmd, { echoCommand: true }));
        return b;
      })
    );

    const terminalSection = el(
      'div',
      { class: 'panel', style: 'margin-bottom: 20px; padding: 16px;' },
      [
        el(
          'div',
          {
            style:
              'display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; flex-wrap: wrap; gap: 8px;',
          },
          [
            el(
              'h3',
              { style: 'margin: 0;' },
              `Interactive Sandbox Shell — ${sbName} (${currentImage})`
            ),
            el(
              'span',
              { style: 'font-size: 12px; color: var(--muted);' },
              'Click inside terminal to type directly (Tab autocomplete, ↑/↓ history, cd state preserved)'
            ),
          ]
        ),
        quickBar,
        termContainer,
        commandBar,
      ]
    );

    // ── 4. Security & Network Policy Validation Section ─────────────────────
    const securityChecksHost = el('div', { style: 'margin-top: 12px;' });
    const renderSecurityChecks = (res) => {
      securityChecksHost.replaceChildren();
      const checks = res?.report?.checks || res?.checks;
      if (!Array.isArray(checks)) return;
      const list = el(
        'div',
        { style: 'display: grid; gap: 6px; margin-top: 8px;' },
        checks.map((c) =>
          el(
            'div',
            {
              style:
                'display: flex; justify-content: space-between; align-items: center; padding: 8px 12px; background: var(--bg); border: 1px solid var(--border); border-radius: 4px; font-size: 12px;',
            },
            [
              el('div', {}, [
                el(
                  'strong',
                  { style: c.passed ? 'color: var(--green);' : 'color: #f85149;' },
                  c.passed ? '✓ PASS ' : '✗ FAIL '
                ),
                el('span', {}, c.title || c.name),
              ]),
              el('code', { style: 'color: var(--muted);' }, c.detail || ''),
            ]
          )
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
          projectName,
          sandboxName: sbName,
          workspace: activeWorkspace,
        });
        renderSecurityChecks(securityResult);
        const passed = securityResult?.report?.passed ?? securityResult?.passed;
        toast(
          passed
            ? `All sandbox security checks passed for ${sbName}!`
            : 'Security checks completed with warnings.',
          'ok'
        );
      } catch (err) {
        toast(err.message || 'Security check failed.');
      } finally {
        runSecBtn.disabled = false;
        runSecBtn.textContent = 'Run Live Pod Security Checks';
      }
    });

    const policyYaml =
      policyData?.yaml ||
      `apiVersion: networking.k8s.io/v1
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

    const applyPolicyBtn = el(
      'button',
      { class: 'primary', type: 'button' },
      'Save & Validate NetworkPolicy'
    );
    const policyStatusMsg = el(
      'span',
      { style: 'font-size: 12px; color: var(--muted);' },
      'Active in namespace ' + activeWorkspace
    );

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
      el(
        'div',
        {
          style:
            'display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px;',
        },
        [
          el('div', {}, [
            el('h3', { style: 'margin: 0;' }, 'Tenant NetworkPolicy & Live Security Verification'),
            el(
              'p',
              { class: 'muted', style: 'font-size: 13px; margin: 4px 0 0 0;' },
              'Validates non-root UID execution, mTLS/Envoy isolation, RFC1918/metadata SSRF egress block, and OpenRouter HTTPS egress.'
            ),
          ]),
          el('div', { style: 'display: flex; gap: 8px; align-items: center;' }, [
            runSecBtn,
            applyPolicyBtn,
          ]),
        ]
      ),
      el('div', { style: 'margin-top: 8px;' }, [policyStatusMsg]),
      securityChecksHost,
      el(
        'pre',
        {
          style:
            'background: var(--bg); padding: 12px; border-radius: 6px; font-size: 12px; overflow-x: auto; border: 1px solid var(--border); margin-top: 12px;',
        },
        policyYaml
      ),
    ]);

    clear(view).append(head, multiSandboxPanel, statusPanel, terminalSection, configSection);
  }

  renderView();
}
