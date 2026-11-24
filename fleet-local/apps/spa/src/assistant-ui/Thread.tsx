import { useCallback, useEffect, useRef, useState } from 'react';
import { AssistantRuntimeProvider, useAuiState } from '@assistant-ui/react';
import { api } from '../api';
import type { ModelOption, Org, Project, Session, SessionOutcome } from '../types';
import { newThreadId, useFleetAgUi } from '../agui/useFleetAgUi';
import { TaskStatusBar } from './TaskStatusBar';
import { ThreadView } from './ui/ThreadView';

// The outcome badge reuses the wizard's tones: a run the platform broke must not
// look the same as one that answered.
const OUTCOME_TONE: Record<SessionOutcome, string> = {
  completed: 'done',
  awaiting_input: 'state',
  failed: 'failed',
  upstream_error: 'failed',
  no_events: 'failed',
  rejected: 'failed',
  cancelled: '',
  client_abort: '',
};

interface ChatSurfaceProps {
  orgId: string;
  projectId: string;
  projects: Project[];
  onProject: (projectId: string) => void;
  models: ModelOption[];
  model: string;
  onModel: (model: string) => void;
  /** THIS conversation's AG-UI thread handle. See Thread: it never repeats. */
  threadId: string;
  ready: boolean;
  sessions: Session[];
  active: Session | undefined;
  /** A run has begun on this thread, so its agent is chosen and fixed. */
  started: boolean;
  onNewChat: () => void;
  onResume: (session: Session) => void;
  onRunEnd: () => void;
  onRunStart: () => void;
}

// Mounted only when a project is selected, and remounted on every change of
// project or thread: the runtime holds the transcript, so a new conversation is
// a new subtree rather than a reset of this one.
function ChatSurface(props: ChatSurfaceProps) {
  const { orgId, projectId, projects, models, model, ready, sessions, active, threadId, started } = props;
  const [runError, setRunError] = useState('');
  const runtime = useFleetAgUi({
    orgId,
    projectId,
    threadId,
    model,
    onError: (err) => setRunError(err.message),
  });
  // The facade keeps a conversation on the agent its first turn picked, so the
  // model only selects the agent for a conversation that has not begun.
  const locked = started || Boolean(active);

  async function endSession() {
    if (!active) return;
    await api.closeSession(orgId, active.id).catch((err) => setRunError(String(err)));
    props.onRunEnd();
  }

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <section className="chat">
        <div className="chat-main">
          <div className="row">
            <select value={projectId} onChange={(e) => props.onProject(e.target.value)}>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} {p.agent_name ? '' : '(no agent)'}
                </option>
              ))}
            </select>
            {/* The model selects the agent for a conversation that has not begun,
                so it lives with the conversation controls, not the composer. */}
            <select
              value={model}
              onChange={(e) => props.onModel(e.target.value)}
              disabled={locked || models.length === 0}
              title={locked ? 'Locked: this conversation runs on one model' : 'Model for the next new conversation'}
            >
              {models.length === 0 ? <option value={model}>mock-gpt</option> : null}
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
            <button className="ghost" onClick={props.onNewChat}>
              New chat
            </button>
            {active ? (
              <button className="ghost" onClick={() => void endSession()}>
                End session
              </button>
            ) : null}
            <div className="spacer" />
            {runError ? <span className="error small">{runError}</span> : null}
            <TaskStatusBar />
          </div>

          {!ready ? <p className="error">This project has no agent attached yet — finish onboarding first.</p> : null}
          <ThreadView
            welcome="Ask the agent to start working."
            placeholder={ready ? 'Message the agent…' : 'Onboarding incomplete'}
            sendDisabled={!ready}
            run={{ closeReason: active?.close_reason, transportError: runError }}
            onAnswerError={(message) => setRunError(message)}
          />
        </div>

        <aside className="chat-side">
          <h3>Sessions</h3>
          {sessions.length === 0 ? <p className="muted small">No sessions yet.</p> : null}
          <ul className="session-list">
            {sessions.map((s) => (
              <li key={s.id} className={s.thread_id === threadId ? 'active' : ''}>
                <button
                  className="link"
                  disabled={!s.thread_id}
                  title={s.thread_id ? 'Continue this conversation' : 'Started outside this browser — no thread to resume'}
                  onClick={() => props.onResume(s)}
                >
                  {(s.thread_id ?? s.id).slice(0, 8)} · {s.status}
                  {s.model ? ` · ${models.find((m) => m.id === s.model)?.label ?? s.model}` : ''}
                </button>
                <span className="muted small" title={s.close_reason ?? undefined}>
                  {s.outcome ? (
                    <span className={`badge${OUTCOME_TONE[s.outcome] ? ` badge-${OUTCOME_TONE[s.outcome]}` : ''}`}>
                      {s.outcome}
                    </span>
                  ) : null}{' '}
                  {s.duration_seconds != null ? `${Math.round(s.duration_seconds)}s` : 'running'}
                </span>
              </li>
            ))}
          </ul>
        </aside>
      </section>

      <RunWatcher onRunStart={props.onRunStart} onRunEnd={props.onRunEnd} />
    </AssistantRuntimeProvider>
  );
}

// The bridge from protocol state back to app state. There is no conversation id
// to learn from the stream any more — the thread handle is the app's own — so
// what comes back is the two edges of a run: the first one fixes the agent, and
// the last one is when the session row becomes worth re-reading.
function RunWatcher({ onRunStart, onRunEnd }: { onRunStart: () => void; onRunEnd: () => void }) {
  const isRunning = useAuiState((s) => s.thread.isRunning);

  const wasRunning = useRef(false);
  useEffect(() => {
    if (isRunning && !wasRunning.current) onRunStart();
    if (wasRunning.current && !isRunning) onRunEnd();
    wasRunning.current = isRunning;
  }, [isRunning, onRunStart, onRunEnd]);

  return null;
}

export function Thread({ org }: { org: Org }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState('');
  const [models, setModels] = useState<ModelOption[]>([]);
  const [model, setModel] = useState('');
  const [sessions, setSessions] = useState<Session[]>([]);
  // On this wire the conversation is named by the client, so a new chat is a new
  // thread id rather than a reset of the old one: the BFF keys the session row on
  // it, and reusing a value would resume the conversation it belongs to.
  const [threadId, setThreadId] = useState(newThreadId);
  const [started, setStarted] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .listProjects(org.id)
      .then(({ projects }) => {
        setProjects(projects);
        const ready = projects.find((p) => p.agent_name);
        setProjectId(ready?.id ?? projects[0]?.id ?? '');
      })
      .catch((err) => setError(String(err)));
  }, [org.id]);

  const refreshSessions = useCallback(() => {
    if (!projectId) return;
    api
      .listSessions(org.id, projectId)
      .then(({ sessions }) => setSessions(sessions))
      .catch(() => undefined);
  }, [org.id, projectId]);

  useEffect(() => {
    if (!projectId) return;
    api
      .models(org.id, projectId)
      .then(({ models }) => {
        setModels(models);
        setModel((models.find((m) => m.default) ?? models[0])?.id ?? '');
      })
      .catch(() => setModels([]));
    refreshSessions();
  }, [org.id, projectId, refreshSessions]);

  function newChat() {
    setThreadId(newThreadId());
    setStarted(false);
  }

  function changeProject(next: string) {
    setProjectId(next);
    newChat();
  }

  function resume(session: Session) {
    if (!session.thread_id) return;
    setThreadId(session.thread_id);
    setStarted(true);
    setModel(session.model ?? model);
  }

  const noteRunStart = useCallback(() => setStarted(true), []);

  const project = projects.find((p) => p.id === projectId);
  const active = sessions.find((s) => s.thread_id === threadId);

  return (
    <>
      {error ? <p className="error">{error}</p> : null}
      {projectId ? (
        <ChatSurface
          key={`${projectId}:${threadId}`}
          orgId={org.id}
          projectId={projectId}
          projects={projects}
          onProject={changeProject}
          models={models}
          model={model}
          onModel={setModel}
          threadId={threadId}
          ready={Boolean(project?.agent_name)}
          sessions={sessions}
          active={active}
          started={started}
          onNewChat={newChat}
          onResume={resume}
          onRunStart={noteRunStart}
          onRunEnd={refreshSessions}
        />
      ) : null}
    </>
  );
}
