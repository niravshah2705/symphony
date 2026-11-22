import { useEffect, useState } from 'react';
import { api } from '../api';
import type { LangfuseTrace, Org, Project, ReconciledCosts } from '../types';

const usd = (n: number) => `$${n.toFixed(4)}`;
const num = (n: number) => n.toLocaleString();
const LANGFUSE_UI = 'http://localhost:3000';

export function Costs({ org }: { org: Org }) {
  const [days, setDays] = useState(30);
  const [costs, setCosts] = useState<ReconciledCosts | null>(null);
  const [traces, setTraces] = useState<LangfuseTrace[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    Promise.all([api.getCosts(org.id, days), api.getTraces(org.id), api.listProjects(org.id)])
      .then(([c, t, p]) => {
        if (cancelled) return;
        setCosts(c);
        setTraces(t.traces);
        setProjects(p.projects);
      })
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : String(err)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [org.id, days]);

  const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? `${id.slice(0, 8)}…`;
  const t = costs?.flexprice.totals;

  return (
    <section>
      <div className="row">
        <h2>Costs — {org.name}</h2>
        <div className="spacer" />
        <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
        </select>
      </div>
      {error ? <p className="error">{error}</p> : null}
      {loading ? <p className="muted">Loading…</p> : null}

      {t ? (
        <div className="cards">
          <div className="card stat">
            <div className="stat-value">{usd(t.usd)}</div>
            <div className="muted small">LLM spend (Flexprice)</div>
          </div>
          <div className="card stat">
            <div className="stat-value">{num(t.totalTokens)}</div>
            <div className="muted small">Total tokens</div>
          </div>
          <div className="card stat">
            <div className="stat-value">
              {num(t.inputTokens)} / {num(t.outputTokens)}
            </div>
            <div className="muted small">Input / output tokens</div>
          </div>
          <div className="card stat">
            <div className="stat-value">{num(Math.round(t.actorSeconds))}s</div>
            <div className="muted small">Actor compute</div>
          </div>
          <div className="card stat">
            <div className="stat-value">
              {costs?.walletBalance != null ? JSON.stringify(costs.walletBalance) : '—'}
            </div>
            <div className="muted small">Wallet balance</div>
          </div>
        </div>
      ) : null}

      {costs ? (
        <>
          <h3>By project</h3>
          <table>
            <thead>
              <tr>
                <th>Project</th>
                <th>Input</th>
                <th>Output</th>
                <th>Total</th>
                <th>USD (Flexprice)</th>
                <th>USD (LiteLLM)</th>
                <th>Actor s</th>
              </tr>
            </thead>
            <tbody>
              {costs.flexprice.rows.map((r) => (
                <tr key={r.projectId}>
                  <td>{projectName(r.projectId ?? '')}</td>
                  <td>{num(r.inputTokens)}</td>
                  <td>{num(r.outputTokens)}</td>
                  <td>{num(r.totalTokens)}</td>
                  <td>{usd(r.usd)}</td>
                  <td>{r.projectId ? usd(costs.litellm.teamSpend[r.projectId] ?? 0) : '—'}</td>
                  <td>{num(Math.round(r.actorSeconds))}</td>
                </tr>
              ))}
              {costs.flexprice.rows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="muted">
                    No usage in this window.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>

          <h3>By user</h3>
          <table>
            <thead>
              <tr>
                <th>User</th>
                <th>Total tokens</th>
                <th>USD</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(costs.flexprice.byUser).map(([user, b]) => (
                <tr key={user}>
                  <td>{user}</td>
                  <td>{num(b.totalTokens)}</td>
                  <td>{usd(b.usd)}</td>
                </tr>
              ))}
              {Object.keys(costs.flexprice.byUser).length === 0 ? (
                <tr>
                  <td colSpan={3} className="muted">
                    No per-user usage yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>

          <h3>Prometheus actor seconds</h3>
          {costs.prometheus.length === 0 ? (
            <p className="muted small">No fleet-labelled series yet (sweeper emits on session close).</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>project</th>
                  <th>user</th>
                  <th>agent</th>
                  <th>tier</th>
                  <th>seconds</th>
                </tr>
              </thead>
              <tbody>
                {costs.prometheus.map((s, i) => (
                  <tr key={i}>
                    <td>{projectName(s.metric.project_id ?? '')}</td>
                    <td>{s.metric.user_id ?? '—'}</td>
                    <td>{s.metric.agent_id ?? '—'}</td>
                    <td>{s.metric.tier ?? '—'}</td>
                    <td>{num(Math.round(s.value))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      ) : null}

      <div className="row">
        <h3>Traces (Langfuse)</h3>
        <div className="spacer" />
        <a className="ghost button" href={LANGFUSE_UI} target="_blank" rel="noreferrer">
          Open Langfuse UI
        </a>
      </div>
      <p className="muted small">
        Langfuse is unexposed; run scripts/port-forwards.sh and open {LANGFUSE_UI}.
      </p>
      {traces.length === 0 ? (
        <p className="muted small">No traces yet.</p>
      ) : (
        <ul className="trace-list">
          {traces.map((tr) => (
            <li key={tr.id}>
              <code>{tr.id.slice(0, 12)}</code>
              <span className="muted small">{tr.userId ?? '—'}</span>
              <span className="muted small">{tr.sessionId ?? '—'}</span>
              <span className="muted small">{tr.totalCost != null ? usd(tr.totalCost) : '—'}</span>
            </li>
          ))}
        </ul>
      )}

      <h3>Quality evals</h3>
      <div className="cards">
        <div className="card stat stub">
          <div className="stat-value">—</div>
          <div className="muted small">Hallucination rate (eval hook, future)</div>
        </div>
        <div className="card stat stub">
          <div className="stat-value">—</div>
          <div className="muted small">Accuracy (eval hook, future)</div>
        </div>
        <div className="card stat stub">
          <div className="stat-value">—</div>
          <div className="muted small">Time / tokens per task (eval hook, future)</div>
        </div>
      </div>
    </section>
  );
}