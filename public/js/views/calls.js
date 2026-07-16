import { api } from '../api.js';
import { clear, el, toast } from '../dom.js';

const VIDEO_MIME_TYPES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
  'video/mp4;codecs=h264,aac',
  'video/mp4',
];

const DEFAULT_ENRICHMENT_PROMPT =
  'Turn these rough call notes into a concise summary, clear goals, constraints, open questions, and practical next steps.';
const MAX_RECORDING_SECONDS = 60 * 60;
const MAX_RECORDING_BYTES = 512 * 1024 * 1024;

let activeSession = null;

/**
 * Render the agentic call-recording scenario.
 *
 * Recording media never leaves the browser: the local enrichment endpoint only
 * receives the notes the user typed plus small, non-media recording metadata.
 */
export async function renderCalls(view) {
  if (activeSession) activeSession.dispose();
  const session = createCallSession(view);
  activeSession = session;
  session.render();
}

function createCallSession(view) {
  const state = {
    phase: 'idle',
    captureMode: null,
    captureStream: null,
    sourceStreams: [],
    recorder: null,
    chunks: [],
    startedAt: 0,
    durationSeconds: 0,
    timerId: null,
    recordingBlob: null,
    recordingUrl: null,
    recordedAt: null,
    audioContext: null,
    audioNodes: [],
    stopPromise: null,
    stopResolve: null,
    stopFallbackId: null,
    capturedBytes: 0,
    restoreFocusAfterStop: false,
    finalized: false,
    enriching: false,
    disposed: false,
    latestEnrichment: null,
  };

  const ui = {};

  function render() {
    const titleBlock = el('div', { class: 'scenario-title' }, [
      el('p', { class: 'scenario-eyebrow muted' }, 'Agentic call recording'),
      el('h1', {}, 'Capture the call. Keep the follow-up moving.'),
      el(
        'p',
        { class: 'muted scenario-subtitle' },
        'Record a shared screen or camera with your microphone, then let your local assistant organize the notes you provide.'
      ),
    ]);

    const header = el('div', { class: 'page-head scenario-page-head' }, [
      titleBlock,
      el('span', { class: 'badge state-completed scenario-local-badge' }, '● Local notes assistant'),
    ]);

    const recorderCard = buildRecorderCard();
    const notesCard = buildNotesCard();
    const chatCard = buildChatCard();
    const layout = el('div', { class: 'immersive-layout scenario-layout call-scenario-layout' }, [
      el('section', { class: 'immersive-main scenario-main call-scenario-main' }, [
        el('div', { class: 'immersive-content immersive-content-wide call-scenario-content' }, [
          header,
          recorderCard,
          notesCard,
        ]),
      ]),
      el('aside', { class: 'evidence-rail scenario-side call-scenario-side' }, [
        el('div', { class: 'rail-content call-rail-content' }, chatCard),
      ]),
    ]);

    layout.classList.add('scenario-view', 'call-scenario');
    clear(view).append(layout);
    appendAssistantMessage(
      'I’ll stay out of the way while you record. When the call ends, add rough notes and I’ll turn them into a useful follow-up.'
    );
    updateControls();
  }

  function buildRecorderCard() {
    ui.preview = el('video', {
      class: 'call-preview',
      playsinline: '',
      muted: '',
      'aria-label': 'Call recording preview',
    });
    ui.preview.muted = true;
    ui.preview.hidden = true;

    ui.previewPlaceholder = el('div', { class: 'call-preview-placeholder' }, [
      el('span', { class: 'call-preview-icon', 'aria-hidden': 'true' }, '◉'),
      el('strong', {}, 'Your preview will appear here'),
      el('span', { class: 'muted' }, 'Choose screen or camera when everyone is ready.'),
    ]);

    ui.statusDot = el('span', { class: 'call-status-dot', 'aria-hidden': 'true' });
    ui.statusText = el('span', {}, 'Ready to record');
    ui.status = el('div', { class: 'call-status', role: 'status', 'aria-live': 'polite' }, [
      ui.statusDot,
      ui.statusText,
    ]);
    ui.timer = el('time', { class: 'call-timer', datetime: 'PT0S' }, '00:00');

    ui.screenButton = el(
      'button',
      { class: 'primary call-source-button', type: 'button', onclick: () => startRecording('screen') },
      'Share screen + mic'
    );
    ui.cameraButton = el(
      'button',
      { class: 'call-source-button', type: 'button', onclick: () => startRecording('camera') },
      'Use camera + mic'
    );
    ui.stopButton = el(
      'button',
      { class: 'danger call-stop-button', type: 'button', onclick: () => void stopRecording('You ended the recording.') },
      'Stop & review'
    );
    ui.recordAgainButton = el(
      'button',
      { class: 'call-record-again-button', type: 'button', onclick: resetRecording },
      'Record again'
    );
    ui.downloadLink = el(
      'a',
      { class: 'btn primary call-download-link', href: '#', download: 'agentic-call.webm' },
      'Download recording'
    );

    ui.consent = el('input', { id: 'call-recording-consent', type: 'checkbox' });
    ui.consent.addEventListener('change', updateControls);

    return el('article', { class: 'card call-recorder-card' }, [
      el('div', { class: 'row call-recorder-head' }, [
        el('div', {}, [
          el('h2', {}, 'New call recording'),
          el('p', { class: 'muted' }, 'The recording stays in this browser until you download it.'),
        ]),
        el('span', { class: 'spacer' }),
        ui.status,
        ui.timer,
      ]),
      el('div', { class: 'call-stage' }, [ui.preview, ui.previewPlaceholder]),
      el('label', { class: 'call-consent' }, [
        ui.consent,
        el('span', {}, 'Everyone on this call knows it is being recorded.'),
      ]),
      el('div', { class: 'call-controls' }, [
        el('div', { class: 'call-source-actions' }, [ui.screenButton, ui.cameraButton]),
        el('div', { class: 'call-review-actions' }, [ui.stopButton, ui.recordAgainButton, ui.downloadLink]),
      ]),
      el('div', { class: 'scenario-detail-links call-detail-links' }, [
        detail(
          'Recording & privacy',
          'Your browser asks for screen, camera, and microphone access. Stop at any time. The media is not uploaded by this page. To protect tab memory, recording stops at 60 minutes or 512 MB.'
        ),
        detail(
          'What the assistant sees',
          'Only the notes you type and basic details such as duration and capture mode. It cannot watch or listen to this recording.'
        ),
      ]),
    ]);
  }

  function buildNotesCard() {
    ui.titleInput = el('input', {
      id: 'call-title',
      type: 'text',
      maxlength: '120',
      placeholder: 'e.g. Product discovery with Acme',
      autocomplete: 'off',
    });
    ui.notesInput = el('textarea', {
      id: 'call-notes',
      class: 'call-notes-input',
      rows: '7',
      maxlength: '6000',
      placeholder: 'Jot down names, decisions, concerns, promises, and anything that needs a follow-up…',
    });
    ui.notesHint = el(
      'p',
      { class: 'muted call-notes-hint' },
      'Rough notes are enough. The local assistant will organize them after the recording.'
    );

    return el('article', { class: 'card call-notes-card' }, [
      el('div', { class: 'call-section-heading' }, [
        el('h2', {}, 'Call notes'),
        el('p', { class: 'muted' }, 'Capture context while it is fresh.'),
      ]),
      el('label', { for: 'call-title' }, 'Call title'),
      ui.titleInput,
      el('label', { for: 'call-notes', class: 'call-notes-label' }, 'What did you hear?'),
      ui.notesInput,
      ui.notesHint,
    ]);
  }

  function buildChatCard() {
    ui.messages = el('div', {
      class: 'scenario-chat-messages call-chat-messages',
      role: 'log',
      'aria-live': 'polite',
      'aria-label': 'Local assistant conversation',
    });

    const prompts = [
      'Summarize what mattered',
      'Pull out decisions and owners',
      'Draft the follow-up actions',
    ].map((prompt) =>
      el(
        'button',
        {
          class: 'scenario-prompt call-prompt',
          type: 'button',
          onclick: () => void enrichNotes(prompt),
        },
        prompt
      )
    );
    ui.promptButtons = prompts;

    ui.chatInput = el('textarea', {
      class: 'scenario-composer-input call-chat-input',
      rows: '2',
      maxlength: '500',
      placeholder: 'Ask for a summary, decisions, or next steps…',
      'aria-label': 'Ask the local assistant about your notes',
    });
    ui.chatInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        ui.chatForm.requestSubmit();
      }
    });
    ui.sendButton = el('button', { class: 'primary', type: 'submit' }, 'Ask');
    ui.chatForm = el(
      'form',
      {
        class: 'scenario-composer call-chat-composer',
        onsubmit: (event) => {
          event.preventDefault();
          const prompt = ui.chatInput.value.trim();
          if (!prompt) return;
          ui.chatInput.value = '';
          void enrichNotes(prompt);
        },
      },
      [ui.chatInput, ui.sendButton]
    );

    return el('article', { class: 'card scenario-chat call-chat-card' }, [
      el('div', { class: 'scenario-chat-head call-chat-head' }, [
        el('span', { class: 'scenario-chat-avatar', 'aria-hidden': 'true' }, '✦'),
        el('div', {}, [
          el('h2', {}, 'Call companion'),
          el('p', { class: 'muted' }, 'Organizes your notes with the local model selected in Settings.'),
        ]),
      ]),
      ui.messages,
      el('div', { class: 'scenario-prompts call-prompts', 'aria-label': 'Suggested requests' }, prompts),
      ui.chatForm,
      el(
        'p',
        { class: 'muted scenario-chat-disclaimer call-chat-disclaimer' },
        'The assistant works from your notes, so review names, dates, and commitments before sharing.'
      ),
    ]);
  }

  async function startRecording(mode) {
    if (state.phase === 'recording' || state.phase === 'requesting') return;
    if (!ui.consent.checked) {
      toast('Confirm that everyone knows the call is being recorded.', 'err');
      ui.consent.focus();
      return;
    }
    const supportError = recordingSupportError(mode);
    if (supportError) {
      setError(supportError);
      return;
    }

    clearRecordedMedia();
    releaseMedia();
    state.phase = 'requesting';
    state.captureMode = mode;
    state.chunks = [];
    state.capturedBytes = 0;
    state.finalized = false;
    state.durationSeconds = 0;
    setStatus('Waiting for permission…', 'requesting');
    updateControls();

    try {
      const capture = mode === 'screen' ? await captureScreenAndMic() : await captureCameraAndMic();
      if (state.disposed) {
        capture.sourceStreams.forEach(stopStream);
        stopStream(capture.stream);
        if (capture.audioContext) void capture.audioContext.close().catch(() => {});
        return;
      }

      state.captureStream = capture.stream;
      state.sourceStreams = capture.sourceStreams;
      state.audioContext = capture.audioContext || null;
      state.audioNodes = capture.audioNodes || [];

      const videoTrack = state.captureStream.getVideoTracks()[0];
      if (!videoTrack) throw new Error('The selected source did not provide a video track.');
      videoTrack.addEventListener(
        'ended',
        () => {
          if (state.phase === 'recording') void stopRecording('Screen or camera sharing ended.');
        },
        { once: true }
      );

      const mimeType = chooseRecordingMimeType();
      state.recorder = mimeType
        ? new MediaRecorder(state.captureStream, { mimeType })
        : new MediaRecorder(state.captureStream);
      state.recorder.addEventListener('dataavailable', onRecordedData);
      state.recorder.addEventListener('stop', finalizeRecording, { once: true });
      state.recorder.addEventListener('error', onRecorderError, { once: true });

      ui.preview.pause();
      ui.preview.removeAttribute('src');
      ui.preview.srcObject = state.captureStream;
      ui.preview.controls = false;
      ui.preview.muted = true;
      ui.preview.hidden = false;
      ui.previewPlaceholder.hidden = true;
      await ui.preview.play().catch(() => {});

      state.recorder.start(1000);
      state.phase = 'recording';
      state.startedAt = Date.now();
      state.recordedAt = new Date().toISOString();
      state.timerId = setInterval(updateTimer, 500);
      updateTimer();
      setStatus(mode === 'screen' ? 'Recording shared screen' : 'Recording camera', 'recording');
      updateControls();
      appendAssistantMessage(
        mode === 'screen'
          ? 'Screen and microphone recording started. You can return here whenever you are ready to stop.'
          : 'Camera and microphone recording started. I’ll be ready to organize your notes when you finish.'
      );
    } catch (error) {
      releaseMedia();
      if (state.disposed) return;
      resetLivePreview();
      state.phase = 'idle';
      setError(permissionMessage(error, mode));
      updateControls();
    }
  }

  async function captureScreenAndMic() {
    let displayStream;
    let microphoneStream;
    try {
      displayStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      // Register the first permission result immediately so navigation cleanup
      // can stop screen sharing while the microphone prompt is still open.
      state.sourceStreams = [displayStream];
      if (state.disposed) throw new DOMException('Recording setup was cancelled.', 'AbortError');
      microphoneStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
      state.sourceStreams = [displayStream, microphoneStream];
      if (state.disposed) throw new DOMException('Recording setup was cancelled.', 'AbortError');
      return await combineScreenAndMicrophone(displayStream, microphoneStream);
    } catch (error) {
      stopStream(displayStream);
      stopStream(microphoneStream);
      state.sourceStreams = [];
      throw error;
    }
  }

  async function captureCameraAndMic() {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 24, max: 30 },
        facingMode: 'user',
      },
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    return { stream, sourceStreams: [stream], audioContext: null, audioNodes: [] };
  }

  async function combineScreenAndMicrophone(displayStream, microphoneStream) {
    const combined = new MediaStream();
    displayStream.getVideoTracks().forEach((track) => combined.addTrack(track));

    const audioTracks = [...displayStream.getAudioTracks(), ...microphoneStream.getAudioTracks()];
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (audioTracks.length > 1 && AudioContextClass) {
      let audioContext;
      try {
        audioContext = new AudioContextClass();
        if (audioContext.state === 'suspended') await audioContext.resume();
        const destination = audioContext.createMediaStreamDestination();
        const nodes = audioTracks.map((track) => {
          const source = audioContext.createMediaStreamSource(new MediaStream([track]));
          source.connect(destination);
          return source;
        });
        destination.stream.getAudioTracks().forEach((track) => combined.addTrack(track));
        return {
          stream: combined,
          sourceStreams: [displayStream, microphoneStream],
          audioContext,
          audioNodes: [...nodes, destination],
        };
      } catch (_) {
        if (audioContext) void audioContext.close().catch(() => {});
      }
    }

    // A single microphone track needs no mixing. The multi-track fallback is
    // useful on browsers without Web Audio support, though support varies.
    audioTracks.forEach((track) => combined.addTrack(track));
    return {
      stream: combined,
      sourceStreams: [displayStream, microphoneStream],
      audioContext: null,
      audioNodes: [],
    };
  }

  function stopRecording(reason) {
    if (state.phase === 'stopping') return state.stopPromise || Promise.resolve();
    if (state.phase !== 'recording' || !state.recorder) return Promise.resolve();

    state.phase = 'stopping';
    state.restoreFocusAfterStop = document.activeElement === ui.stopButton;
    clearInterval(state.timerId);
    state.timerId = null;
    updateTimer();
    setStatus('Finishing recording…', 'stopping');
    updateControls();
    if (reason) appendAssistantMessage(reason);

    state.stopPromise = new Promise((resolve) => {
      state.stopResolve = resolve;
    });
    if (state.recorder.state !== 'inactive') {
      state.recorder.stop();
    } else {
      // Some browsers report inactive just before dispatching their final
      // dataavailable/stop tasks. Let those run, then use a guarded fallback.
      state.stopFallbackId = setTimeout(finalizeRecording, 250);
    }
    return state.stopPromise;
  }

  function onRecordedData(event) {
    if (!event.data || event.data.size <= 0) return;
    state.chunks.push(event.data);
    state.capturedBytes += event.data.size;
    if (state.phase === 'recording' && state.capturedBytes >= MAX_RECORDING_BYTES) {
      void stopRecording('The recording reached the 512 MB browser-memory limit and was stopped safely.');
    }
  }

  function finalizeRecording() {
    clearTimeout(state.stopFallbackId);
    state.stopFallbackId = null;
    if (state.finalized) {
      state.stopResolve?.();
      state.stopResolve = null;
      return;
    }
    state.finalized = true;
    clearInterval(state.timerId);
    state.timerId = null;
    state.durationSeconds = Math.max(
      state.durationSeconds,
      state.startedAt ? Math.round((Date.now() - state.startedAt) / 1000) : 0
    );

    const mimeType = state.recorder?.mimeType || state.chunks[0]?.type || 'video/webm';
    const blob = new Blob(state.chunks, { type: mimeType });
    state.chunks = [];
    releaseMedia();

    if (state.disposed) {
      state.stopResolve?.();
      state.stopResolve = null;
      return;
    }
    if (!blob.size) {
      state.phase = 'idle';
      resetLivePreview();
      setError('The browser did not capture any media. Try again or choose the other recording option.');
      updateControls();
      if (state.restoreFocusAfterStop) window.requestAnimationFrame(() => ui.screenButton?.focus());
      state.restoreFocusAfterStop = false;
      state.stopResolve?.();
      state.stopResolve = null;
      return;
    }

    state.recordingBlob = blob;
    state.recordingUrl = URL.createObjectURL(blob);
    state.phase = 'review';

    ui.preview.pause();
    ui.preview.srcObject = null;
    ui.preview.src = state.recordingUrl;
    ui.preview.controls = true;
    ui.preview.muted = false;
    ui.preview.hidden = false;
    ui.previewPlaceholder.hidden = true;
    ui.downloadLink.href = state.recordingUrl;
    ui.downloadLink.download = recordingFilename(mimeType);
    setStatus('Ready to review', 'review');
    updateControls();
    if (state.restoreFocusAfterStop) {
      window.requestAnimationFrame(() => ui.downloadLink?.focus());
    }
    state.restoreFocusAfterStop = false;
    appendAssistantMessage(
      'Your recording is ready. Add any rough notes you have, then choose a prompt or ask me for the follow-up you need.'
    );

    // Notes may have been typed during the call. Enrich them immediately; when
    // they are empty, enrichNotes simply leaves a friendly prompt to add some.
    void enrichNotes(DEFAULT_ENRICHMENT_PROMPT, { automatic: true });
    state.stopResolve?.();
    state.stopResolve = null;
  }

  function onRecorderError(event) {
    const message = event?.error?.message || 'The browser could not continue recording.';
    clearInterval(state.timerId);
    state.timerId = null;
    releaseMedia();
    resetLivePreview();
    state.finalized = true;
    state.chunks = [];
    clearTimeout(state.stopFallbackId);
    state.stopFallbackId = null;
    state.phase = 'idle';
    setError(message);
    updateControls();
    if (state.restoreFocusAfterStop) window.requestAnimationFrame(() => ui.screenButton?.focus());
    state.restoreFocusAfterStop = false;
    state.stopResolve?.();
    state.stopResolve = null;
  }

  async function enrichNotes(instruction, options = {}) {
    const automatic = Boolean(options.automatic);
    if (state.phase !== 'review' || !state.recordingBlob) {
      if (!automatic) toast('Finish a recording before asking the call companion.', 'err');
      return;
    }
    const notes = ui.notesInput.value.trim();
    if (!notes) {
      if (automatic) {
        appendAssistantMessage(
          'I can’t listen to the recording itself. Add a few rough notes—fragments are fine—and I’ll organize them with the configured local-model service.'
        );
      } else {
        toast('Add a few call notes first.', 'err');
        ui.notesInput.focus();
      }
      return;
    }
    if (state.enriching) return;

    const request = String(instruction || DEFAULT_ENRICHMENT_PROMPT).trim();
    if (!automatic) appendUserMessage(request);
    const thinking = appendAssistantMessage('Organizing your notes with the configured local model…', 'Ollama / LM Studio route');
    state.enriching = true;
    updateControls();

    try {
      const response = await api.enrichInput({
        scenario: 'call-recording',
        input: buildEnrichmentInput(notes, request),
        metadata: {
          title: callTitle(),
          captureMode: state.captureMode || 'unknown',
          durationSeconds: state.durationSeconds,
          mimeType: state.recordingBlob.type || 'video/webm',
          sizeBytes: state.recordingBlob.size,
          recordedAt: state.recordedAt || new Date().toISOString(),
        },
      });
      thinking.remove();
      if (state.disposed || state.phase !== 'review') return;
      state.latestEnrichment = response?.enrichment || response;
      appendEnrichment(state.latestEnrichment);
    } catch (error) {
      thinking.remove();
      if (state.disposed) return;
      appendAssistantMessage(
        `I couldn’t organize those notes yet: ${error?.message || 'the local assistant is unavailable.'}`,
        'Notes kept in this browser'
      );
      toast('Local note enrichment failed. Your recording and notes are still here.', 'err');
    } finally {
      state.enriching = false;
      if (!state.disposed) updateControls();
    }
  }

  function buildEnrichmentInput(notes, instruction) {
    return [
      `Call title: ${callTitle()}`,
      `Request: ${instruction}`,
      '',
      '<user_notes>',
      notes,
      '</user_notes>',
    ].join('\n');
  }

  function appendEnrichment(enrichment) {
    if (!enrichment || typeof enrichment !== 'object') {
      appendAssistantMessage(String(enrichment || 'The local assistant returned no note enrichment.'));
      return;
    }

    const body = el('div', { class: 'scenario-chat-bubble call-enrichment-bubble' });
    if (enrichment.summary) body.append(el('p', { class: 'call-enrichment-summary' }, enrichment.summary));
    if (enrichment.clarifiedBrief && enrichment.clarifiedBrief !== enrichment.summary) {
      body.append(enrichmentSection('Clean brief', [enrichment.clarifiedBrief]));
    }
    appendListSection(body, 'Goals', enrichment.goals);
    appendListSection(body, 'Constraints', enrichment.constraints);
    appendListSection(body, 'Assumptions to check', enrichment.assumptions);
    appendListSection(body, 'Still missing', enrichment.missingInformation);
    appendListSection(body, 'Suggested next steps', enrichment.suggestedNextSteps);
    appendListSection(body, 'Heads up', enrichment.warnings);

    const provenance = enrichment.provenance || {};
    const detailText = [provenance.provider, provenance.model].filter(Boolean).join(' · ') || 'Local model';
    body.append(
      detail(
        'Model details',
        `${detailText}${provenance.usedFallback ? ' · lightweight fallback used' : ''}. The model received notes and metadata, not the recording.`
      )
    );

    const useButton = el(
      'button',
      {
        class: 'scenario-use-result call-use-result',
        type: 'button',
        onclick: () => useEnrichmentAsNotes(enrichment),
      },
      'Use as cleaned notes'
    );
    body.append(useButton);
    ui.messages.append(
      el('div', { class: 'scenario-chat-message is-assistant call-chat-message' }, [
        el('span', { class: 'scenario-chat-avatar', 'aria-hidden': 'true' }, '✦'),
        body,
      ])
    );
    scrollMessages();
  }

  function appendListSection(container, heading, values) {
    const items = Array.isArray(values) ? values.map(String).map((value) => value.trim()).filter(Boolean) : [];
    if (items.length) container.append(enrichmentSection(heading, items));
  }

  function enrichmentSection(heading, items) {
    return el('section', { class: 'call-enrichment-section' }, [
      el('h3', {}, heading),
      items.length === 1
        ? el('p', {}, items[0])
        : el('ul', {}, items.map((item) => el('li', {}, item))),
    ]);
  }

  function useEnrichmentAsNotes(enrichment) {
    const lines = [];
    if (enrichment.clarifiedBrief || enrichment.summary) {
      lines.push(enrichment.clarifiedBrief || enrichment.summary);
    }
    const add = (heading, values) => {
      const items = Array.isArray(values) ? values.filter(Boolean) : [];
      if (items.length) lines.push(`${heading}:\n${items.map((item) => `- ${item}`).join('\n')}`);
    };
    add('Goals', enrichment.goals);
    add('Constraints', enrichment.constraints);
    add('Open questions', enrichment.missingInformation);
    add('Next steps', enrichment.suggestedNextSteps);
    ui.notesInput.value = lines.join('\n\n').slice(0, 6000);
    ui.notesInput.focus();
    toast('Cleaned notes are ready to review.', 'ok');
  }

  function appendAssistantMessage(text, meta = '') {
    const message = chatMessage('assistant', text, meta);
    ui.messages.append(message);
    scrollMessages();
    return message;
  }

  function appendUserMessage(text) {
    const message = chatMessage('user', text);
    ui.messages.append(message);
    scrollMessages();
    return message;
  }

  function chatMessage(role, text, meta = '') {
    const bubble = el('div', { class: 'scenario-chat-bubble' }, [
      el('p', role === 'user' ? { dataset: { userContent: 'true' } } : {}, text),
    ]);
    if (meta) bubble.append(el('span', { class: 'scenario-chat-meta muted' }, meta));
    const children = role === 'assistant'
      ? [el('span', { class: 'scenario-chat-avatar', 'aria-hidden': 'true' }, '✦'), bubble]
      : [bubble];
    return el(
      'div',
      { class: `scenario-chat-message is-${role} call-chat-message` },
      children
    );
  }

  function scrollMessages() {
    ui.messages.scrollTop = ui.messages.scrollHeight;
  }

  function callTitle() {
    return String(ui.titleInput?.value || '').trim() || 'Untitled call';
  }

  function resetRecording() {
    if (state.phase === 'recording' || state.phase === 'stopping') return;
    clearRecordedMedia();
    state.phase = 'idle';
    state.captureMode = null;
    state.durationSeconds = 0;
    state.startedAt = 0;
    state.recordedAt = null;
    state.latestEnrichment = null;
    state.finalized = false;
    state.capturedBytes = 0;
    resetLivePreview();
    ui.timer.textContent = '00:00';
    ui.timer.setAttribute('datetime', 'PT0S');
    setStatus('Ready to record', 'idle');
    updateControls();
    window.requestAnimationFrame(() => ui.screenButton?.focus());
  }

  function updateControls() {
    const busy = state.phase === 'requesting' || state.phase === 'recording' || state.phase === 'stopping';
    const canStart = !busy && state.phase !== 'review' && Boolean(ui.consent?.checked);
    ui.screenButton.disabled = !canStart;
    ui.cameraButton.disabled = !canStart;
    ui.stopButton.hidden = state.phase !== 'recording';
    ui.stopButton.disabled = state.phase !== 'recording';
    ui.recordAgainButton.hidden = state.phase !== 'review';
    ui.recordAgainButton.disabled = state.enriching;
    ui.downloadLink.hidden = state.phase !== 'review';
    ui.consent.disabled = busy || state.phase === 'review';

    const canEnrich = state.phase === 'review' && !state.enriching;
    ui.promptButtons.forEach((button) => {
      button.disabled = !canEnrich;
    });
    ui.chatInput.disabled = !canEnrich;
    ui.sendButton.disabled = !canEnrich;
    ui.notesHint.textContent = state.phase === 'recording'
      ? 'Keep jotting down anything the assistant should organize later.'
      : state.phase === 'review'
      ? 'Your notes stay editable. Ask the companion when you are ready.'
      : 'Rough notes are enough. The local assistant will organize them after the recording.';
  }

  function updateTimer() {
    if (state.startedAt && (state.phase === 'recording' || state.phase === 'stopping')) {
      state.durationSeconds = Math.max(0, Math.floor((Date.now() - state.startedAt) / 1000));
    }
    ui.timer.textContent = formatDuration(state.durationSeconds);
    ui.timer.setAttribute('datetime', `PT${state.durationSeconds}S`);
    if (state.phase === 'recording' && state.durationSeconds >= MAX_RECORDING_SECONDS) {
      void stopRecording('The 60-minute recording limit was reached and the recording was stopped safely.');
    }
  }

  function setStatus(text, kind) {
    ui.statusText.textContent = text;
    ui.status.className = `call-status is-${kind || 'idle'}`;
  }

  function setError(message) {
    setStatus('Recording unavailable', 'error');
    appendAssistantMessage(message, 'Nothing was recorded');
    toast(message, 'err');
  }

  function releaseMedia() {
    stopStream(state.captureStream);
    state.sourceStreams.forEach(stopStream);
    state.captureStream = null;
    state.sourceStreams = [];
    state.audioNodes = [];
    if (state.audioContext) void state.audioContext.close().catch(() => {});
    state.audioContext = null;
  }

  function resetLivePreview() {
    if (!ui.preview) return;
    ui.preview.pause();
    ui.preview.srcObject = null;
    ui.preview.removeAttribute('src');
    ui.preview.load();
    ui.preview.controls = false;
    ui.preview.muted = true;
    ui.preview.hidden = true;
    if (ui.previewPlaceholder) ui.previewPlaceholder.hidden = false;
  }

  function clearRecordedMedia() {
    if (state.recordingUrl) URL.revokeObjectURL(state.recordingUrl);
    state.recordingUrl = null;
    state.recordingBlob = null;
    state.chunks = [];
  }

  function dispose() {
    state.disposed = true;
    clearInterval(state.timerId);
    state.timerId = null;
    clearTimeout(state.stopFallbackId);
    state.stopFallbackId = null;
    if (state.recorder && state.recorder.state !== 'inactive') {
      try {
        state.recorder.stop();
      } catch (_) {
        // The tracks are stopped below even if the recorder is already closing.
      }
    }
    releaseMedia();
    clearRecordedMedia();
    if (ui.preview) {
      ui.preview.pause();
      ui.preview.srcObject = null;
      ui.preview.removeAttribute('src');
    }
    if (activeSession?.dispose === dispose) activeSession = null;
  }

  return { render, dispose };
}

function detail(label, text) {
  return el('details', { class: 'scenario-detail call-detail' }, [
    el('summary', {}, label),
    el('p', { class: 'muted' }, text),
  ]);
}

function recordingSupportError(mode) {
  if (!window.isSecureContext) {
    return 'Recording needs a secure page. Open the app on HTTPS or on localhost and try again.';
  }
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    return 'This browser cannot record calls here. Try a current version of Chrome, Edge, Firefox, or Safari.';
  }
  if (mode === 'screen' && !navigator.mediaDevices.getDisplayMedia) {
    return 'Screen recording is not available in this browser. You can still use camera recording.';
  }
  return '';
}

function permissionMessage(error, mode) {
  const name = error?.name || '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return mode === 'screen'
      ? 'Screen or microphone access was not granted. Check the browser permission prompt and try again.'
      : 'Camera or microphone access was not granted. Check browser permissions and try again.';
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return 'No camera or microphone was found. Connect a device or choose a different recording option.';
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return 'Another app may be using the camera or microphone. Close it, then try again.';
  }
  if (name === 'OverconstrainedError' || name === 'ConstraintNotSatisfiedError') {
    return 'The selected device could not use the requested quality. Try another camera or browser.';
  }
  if (name === 'AbortError') return 'Recording setup was cancelled before it finished.';
  return `The recording could not start: ${error?.message || 'unknown browser error'}`;
}

function chooseRecordingMimeType() {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') return '';
  return VIDEO_MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type)) || '';
}

function stopStream(stream) {
  stream?.getTracks?.().forEach((track) => track.stop());
}

function formatDuration(totalSeconds) {
  const seconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return hours
    ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
}

function recordingFilename(mimeType) {
  const extension = String(mimeType).includes('mp4') ? 'mp4' : 'webm';
  const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
  return `agentic-call-${stamp}.${extension}`;
}

window.addEventListener('hashchange', () => {
  const onCallsRoute = location.hash === '#/calls' || location.hash.startsWith('#/calls/');
  if (activeSession && !onCallsRoute) activeSession.dispose();
});
