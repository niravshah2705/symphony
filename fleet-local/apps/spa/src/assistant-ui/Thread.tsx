import { useCallback, useEffect, useRef, useState } from 'react';
import { AssistantRuntimeProvider, useAuiState } from '@assistant-ui/react';
import { useA2ATask } from '@assistant-ui/react-a2a';
import { api } from '../api';
import type { ModelOption, Org, Project, Session, SessionOutcome } from '../types';
import { useFleetA2A } from '../a2a/useFleetA2A';
import { TaskStatusBar } from './TaskStatusBar';
import { ThoughtPanel } from './ThoughtPanel';
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
  conversationKey: string;
  contextId?: string;
  ready: boolean;
  sessions: Session[];
  active: Session | undefined;
  wireContext?: string;
  onNewChat: () => void;
  onResume: (session: Session) => void;
  onRunEnd: () => void;
  onContext: (contextId: string) => void;
}

// Mounted only when a project is selected: the runtime starts agent-card
// discovery as soon as it exists, and there is nothing to discover without one.
function ChatSurface(props: ChatSurfaceProps) {
  const { orgId, projectId, projects, models, model, ready, sessions, active, wireContext } = props;
  const [runError, setRunError] = useState('');
  const runtime = useFleetA2A({
    orgId,
    projectId,
    conversationKey: props.conversationKey,
    contextId: props.contextId,
    model,
    onError: (err) => setRunError(err.message),
  });
  // The facade keeps a conversation on the agent it started with, so the model
  // only selects the agent for a conversation that has not begun.
  const locked = Boolean(wireContext);

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
          <ThoughtPanel />
          <ThreadView
            welcome="Ask the agent to start working."
            placeholder={ready ? 'Message the agent…' : 'Onboarding incomplete'}
            sendDisabled={!ready}
            run={{ closeReason: active?.close_reason, transportError: runError }}
          />
        </div>

        <aside className="chat-side">
          <h3>Sessions</h3>
          {sessions.length === 0 ? <p className="muted small">No sessions yet.</p> : null}
          <ul className="session-list">
            {sessions.map((s) => (
              <li key={s.id} className={s.kagent_session_id === wireContext ? 'active' : ''}>
                <button
                  className="link"
                  disabled={!s.kagent_session_id}
                  title={s.kagent_session_id ? 'Continue this conversation' : 'No conversation id to resume'}
                  onClick={() => props.onResume(s)}
                >
                  {(s.kagent_session_id ?? s.id).slice(0, 8)} · {s.status}
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

      <RunWatcher onContext={props.onContext} onRunEnd={props.onRunEnd} />
    </AssistantRuntimeProvider>
  );
}

// The bridge from protocol state back to app state: the conversation id the
// server assigned (there is no A2A response header for it) and the end of a run,
// which is when the session row becomes interesting.
function RunWatcher({ onContext, onRunEnd }: { onContext: (contextId: string) => void; onRunEnd: () => void }) {
  const isRunning = useAuiState((s) => s.thread.isRunning);
  const task = useA2ATask();
  const contextId = task?.contextId;

  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !isRunning) onRunEnd();
    wasRunning.current = isRunning;
  }, [isRunning, onRunEnd]);

  useEffect(() => {
    if (contextId) onContext(contextId);
  }, [contextId, onContext]);

  return null;
}

export function Thread({ org }: { org: Org }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState('');
  const [models, setModels] = useState<ModelOption[]>([]);
  const [model, setModel] = useState('');
  const [sessions, setSessions] = useState<Session[]>([]);
  // A new conversation is identified by a nonce, not by an id: it has no context
  // id until the stream gives one, and the runtime must be rebuilt when the user
  // asks for a different conversation.
  const [nonce, setNonce] = useState(0);
  const [resumed, setResumed] = useState<string | undefined>(undefined);
  const [wireContext, setWireContext] = useState<string | undefined>(undefined);
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
    setResumed(undefined);
    setWireContext(undefined);
    setNonce((n) => n + 1);
  }

  function changeProject(next: string) {
    setProjectId(next);
    newChat();
  }

  function resume(session: Session) {
    const contextId = session.kagent_session_id;
    if (!contextId) return;
    setResumed(contextId);
    setWireContext(contextId);
    setModel(session.model ?? model);
  }

  const noteContext = useCallback((contextId: string) => setWireContext(contextId), []);

  const project = projects.find((p) => p.id === projectId);
  const active = wireContext ? sessions.find((s) => s.kagent_session_id === wireContext) : undefined;

  return (
    <>
      {error ? <p className="error">{error}</p> : null}
      {projectId ? (
        <ChatSurface
          orgId={org.id}
          projectId={projectId}
          projects={projects}
          onProject={changeProject}
          models={models}
          model={model}
          onModel={setModel}
          conversationKey={resumed ? `ctx:${resumed}` : `new:${nonce}`}
          contextId={resumed}
          ready={Boolean(project?.agent_name)}
          sessions={sessions}
          active={active}
          wireContext={wireContext}
          onNewChat={newChat}
          onResume={resume}
          onRunEnd={refreshSessions}
          onContext={noteContext}
        />
      ) : null}
    </>
  );
}
