import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from '../api';
import type { ModelOption, Org, Project, Session } from '../types';

const TERMINAL = new Set([
  'TASK_STATE_COMPLETED',
  'TASK_STATE_FAILED',
  'TASK_STATE_CANCELLED',
  'TASK_STATE_REJECTED',
]);

interface Turn {
  role: 'user' | 'agent';
  text: string;
}

interface A2AEnvelope {
  result?: {
    task?: { id?: string; contextId?: string; status?: { state?: string }; artifacts?: { artifactId?: string; parts?: { text?: string }[] }[] };
    statusUpdate?: { taskId?: string; contextId?: string; status?: { state?: string } };
    artifactUpdate?: { taskId?: string; contextId?: string; lastChunk?: boolean; artifact?: { artifactId?: string; parts?: { text?: string }[] } };
  };
  error?: unknown;
}

const artifactText = (arts?: { parts?: { text?: string }[] }[]) =>
  (arts ?? []).map((a) => (a.parts ?? []).map((p) => p.text ?? '').join('')).join('\n');

export function Chat({ org }: { org: Org }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState('');
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionId, setSessionId] = useState<string | undefined>(undefined);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [liveAgent, setLiveAgent] = useState('');
  const [taskState, setTaskState] = useState('');
  const [input, setInput] = useState('');
  const [models, setModels] = useState<ModelOption[]>([]);
  const [model, setModel] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const agentBuf = useRef('');
  const sessionRef = useRef<string | undefined>(undefined);
  const abort = useRef<AbortController | null>(null);
  const bottom = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    api
      .listProjects(org.id)
      .then(({ projects }) => {
        setProjects(projects);
        const ready = projects.find((p) => p.agent_name);
        setProjectId(ready?.id ?? projects[0]?.id ?? '');
      })
      .catch((err) => setError(String(err)));
    return () => abort.current?.abort();
  }, [org.id]);

  useEffect(() => {
    if (!projectId) return;
    api
      .models(org.id, projectId)
      .then(({ models }) => {
        setModels(models);
        setModel((models.find((m) => m.default) ?? models[0])?.id ?? '');
      })
      .catch(() => setModels([]));
    api
      .listSessions(org.id, projectId)
      .then(({ sessions }) => setSessions(sessions))
      .catch(() => undefined);
  }, [org.id, projectId, sending]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth' });
  }, [turns, liveAgent]);

  const project = projects.find((p) => p.id === projectId);
  const ready = Boolean(project?.agent_name);

  function reset() {
    abort.current?.abort();
    setSessionId(undefined);
    sessionRef.current = undefined;
    setTurns([]);
    setLiveAgent('');
    agentBuf.current = '';
    setTaskState('');
    setError('');
  }

  async function send(e: FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || !projectId || sending) return;
    setInput('');
    setError('');
    setTurns((t) => [...t, { role: 'user', text }]);
    agentBuf.current = '';
    setLiveAgent('');
    setTaskState('TASK_STATE_SUBMITTED');
    setSending(true);
    const controller = new AbortController();
    abort.current = controller;

    const commit = () => {
      const reply = agentBuf.current || '(no output)';
      setTurns((t) => [...t, { role: 'agent', text: reply }]);
      agentBuf.current = '';
      setLiveAgent('');
      setSending(false);
    };

    try {
      await api.chat(
        org.id,
        projectId,
        text,
        sessionRef.current,
        sessionRef.current ? undefined : model || undefined,
        (event, data) => {
          if (event === 'session') {
            const { sessionId, model: bound } = JSON.parse(data) as { sessionId: string; model?: string };
            sessionRef.current = sessionId;
            setSessionId(sessionId);
            if (bound) setModel(bound);
            return;
          }
          if (event !== 'message') return;
          let env: A2AEnvelope;
          try {
            env = JSON.parse(data) as A2AEnvelope;
          } catch {
            return;
          }
          if (env.error) {
            setError(JSON.stringify(env.error));
            return;
          }
          const r = env.result;
          if (!r) return;
          if (r.artifactUpdate?.artifact) {
            const chunk = artifactText([r.artifactUpdate.artifact]);
            agentBuf.current += chunk;
            setLiveAgent(agentBuf.current);
          }
          if (r.task?.artifacts) {
            agentBuf.current = artifactText(r.task.artifacts);
            setLiveAgent(agentBuf.current);
          }
          const state = r.task?.status?.state ?? r.statusUpdate?.status?.state;
          if (state) {
            setTaskState(state);
            if (TERMINAL.has(state)) commit();
          }
        },
        controller.signal,
      );
      // Stream ended without an explicit terminal event: commit whatever arrived.
      if (agentBuf.current) commit();
      else setSending(false);
    } catch (err) {
      if (!controller.signal.aborted) {
        setError(err instanceof Error ? err.message : String(err));
        setSending(false);
      }
    }
  }

  async function endSession() {
    if (!sessionId) return;
    await api.closeSession(org.id, sessionId).catch((err) => setError(String(err)));
    setSessions((s) => s.map((x) => (x.id === sessionId ? { ...x, status: 'closed' } : x)));
  }

  return (
    <section className="chat">
      <div className="chat-main">
        <div className="row">
          <select value={projectId} onChange={(e) => { setProjectId(e.target.value); reset(); }}>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} {p.agent_name ? '' : '(no agent)'}
              </option>
            ))}
          </select>
          <button className="ghost" onClick={reset}>
            New chat
          </button>
          {sessionId ? (
            <button className="ghost" onClick={() => void endSession()}>
              End session
            </button>
          ) : null}
          <div className="spacer" />
          {taskState ? <span className="badge badge-state">{taskState.replace('TASK_STATE_', '')}</span> : null}
        </div>

        {!ready ? (
          <p className="error">This project has no agent attached yet — finish onboarding first.</p>
        ) : null}
        {error ? <p className="error">{error}</p> : null}

        <div className="messages">
          {turns.map((t, i) => (
            <div key={i} className={`bubble ${t.role}`}>
              <pre>{t.text}</pre>
            </div>
          ))}
          {sending ? (
            <div className="bubble agent">
              <pre>{liveAgent || '…'}</pre>
            </div>
          ) : null}
          <div ref={bottom} />
        </div>

        <form className="composer" onSubmit={send}>
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            disabled={Boolean(sessionId) || models.length === 0}
            title={sessionId ? 'Locked: each session runs on one model/agent' : 'Model for the next new session'}
          >
            {models.length === 0 ? <option value={model}>mock-gpt</option> : null}
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={ready ? 'Message the agent…' : 'Onboarding incomplete'}
            disabled={!ready || sending}
          />
          <button className="primary" type="submit" disabled={!ready || sending || !input.trim()}>
            {sending ? 'Streaming…' : 'Send'}
          </button>
        </form>
      </div>

      <aside className="chat-side">
        <h3>Sessions</h3>
        {sessions.length === 0 ? <p className="muted small">No sessions yet.</p> : null}
        <ul className="session-list">
          {sessions.map((s) => (
            <li key={s.id} className={s.id === sessionId ? 'active' : ''}>
              <button
                className="link"
                onClick={() => {
                  sessionRef.current = s.id;
                  setSessionId(s.id);
                  setTurns([]);
                  agentBuf.current = '';
                  setLiveAgent('');
                }}
              >
                {s.id.slice(0, 8)} · {s.status}
                {s.model ? ` · ${models.find((m) => m.id === s.model)?.label ?? s.model}` : ''}
              </button>
              <span className="muted small">
                {s.duration_seconds != null ? `${Math.round(s.duration_seconds)}s` : 'running'}
              </span>
            </li>
          ))}
        </ul>
      </aside>
    </section>
  );
}