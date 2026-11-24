import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { STEP_META, type Org, type States, type StepState } from '../types';

const STATUS_LABEL: Record<string, string> = {
  pending: 'Pending',
  running: 'Running',
  done: 'Done',
  failed: 'Failed',
};

export function OnboardingWizard({ org }: { org: Org }) {
  const [states, setStates] = useState<States>({});
  const [running, setRunning] = useState(false);
  const [complete, setComplete] = useState(false);
  const [error, setError] = useState('');
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getOnboard(org.id)
      .then(({ states }) => {
        if (!cancelled) {
          setStates(states);
          setComplete(STEP_META.every((s) => states[s.id]?.status === 'done'));
        }
      })
      .catch((err) => !cancelled && setError(String(err)));
    return () => {
      cancelled = true;
      abort.current?.abort();
    };
  }, [org.id]);

  async function run() {
    setRunning(true);
    setError('');
    const controller = new AbortController();
    abort.current = controller;
    try {
      await api.runOnboard(
        org.id,
        (event, data) => {
          if (event === 'step') {
            const s = JSON.parse(data) as StepState;
            setStates((prev) => ({ ...prev, [s.step]: s }));
          } else if (event === 'done') {
            const payload = JSON.parse(data) as { complete: boolean; states: States };
            setStates(payload.states);
            setComplete(payload.complete);
          } else if (event === 'error') {
            setError((JSON.parse(data) as { message: string }).message);
          }
        },
        controller.signal,
      );
    } catch (err) {
      if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }

  const doneCount = STEP_META.filter((s) => states[s.id]?.status === 'done').length;
  const anyFailed = STEP_META.some((s) => states[s.id]?.status === 'failed');

  return (
    <section>
      <div className="row">
        <h2>Onboarding — {org.name}</h2>
        <div className="spacer" />
        <span className="muted small">
          {doneCount}/{STEP_META.length} steps
        </span>
        <button className="primary" disabled={running} onClick={() => void run()}>
          {running ? 'Running…' : complete ? 'Re-run (idempotent)' : anyFailed ? 'Retry' : 'Run onboarding'}
        </button>
      </div>
      {complete ? <p className="ok">Onboarding complete. The agent is attached and ready to chat.</p> : null}
      {error ? <p className="error">{error}</p> : null}
      <ol className="steps">
        {STEP_META.map((meta) => {
          const s = states[meta.id];
          const status = s?.status ?? 'pending';
          return (
            <li key={meta.id} className={`step status-${status}`}>
              <span className="diagram">#{meta.diagram}</span>
              <span className="step-label">{meta.label}</span>
              <span className={`badge badge-${status}`}>{STATUS_LABEL[status]}</span>
              {s && s.attempt > 1 ? <span className="muted small">attempt {s.attempt}</span> : null}
              {s?.error ? <span className="error small">{s.error}</span> : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}