import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import {
  OFFBOARD_META,
  type OffboardStates,
  type OffboardingStepId,
  type Org,
  type OrgStatus,
  type StepState,
} from '../types';
import { StepList } from './StepList';

// The teardown panel: the same SSE machinery as onboarding, pointed at the
// offboarding table. A run that does not finish leaves the organisation gated and
// this list showing what is still owed, so the retry resumes rather than restarts.
export function OffboardWizard({
  org,
  autoStart,
  onFinished,
}: {
  org: Org;
  /** True only straight after the owner typed the slug: opening this tab later must
   *  not start a teardown by itself. */
  autoStart: boolean;
  onFinished: () => void;
}) {
  const [states, setStates] = useState<OffboardStates>({});
  const [status, setStatus] = useState<OrgStatus>(org.status);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const abort = useRef<AbortController | null>(null);

  async function run() {
    setRunning(true);
    setError('');
    const controller = new AbortController();
    abort.current = controller;
    try {
      await api.runOffboard(
        org.id,
        (event, data) => {
          if (event === 'step') {
            const s = JSON.parse(data) as StepState<OffboardingStepId>;
            setStates((prev) => ({ ...prev, [s.step]: s }));
          } else if (event === 'done') {
            const payload = JSON.parse(data) as { complete: boolean; states: OffboardStates };
            setStates(payload.states);
            if (payload.complete) {
              setStatus('deleted');
              onFinished();
            }
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

  useEffect(() => {
    let cancelled = false;
    api
      .getOffboard(org.id)
      .then(({ status, states }) => {
        if (cancelled) return;
        setStatus(status);
        setStates(states);
        if (autoStart && status !== 'deleted') void run();
      })
      .catch((err) => !cancelled && setError(String(err)));
    return () => {
      cancelled = true;
      abort.current?.abort();
    };
    // org.id only: the reload is a mount-time read, and autoStart is the mount's
    // business — a later re-render must never start a teardown.
  }, [org.id]);

  const doneCount = OFFBOARD_META.filter((s) => states[s.id]?.status === 'done').length;
  const remaining = OFFBOARD_META.length - doneCount;
  const deleted = status === 'deleted';

  return (
    <section>
      <div className="row">
        <h2>Offboarding — {org.name}</h2>
        <div className="spacer" />
        <span className="muted small">
          {doneCount}/{OFFBOARD_META.length} steps
        </span>
        <button className="danger" disabled={running || deleted} onClick={() => void run()}>
          {running ? 'Removing…' : deleted ? 'Removed' : status === 'offboarding' ? 'Resume removal' : 'Remove organisation'}
        </button>
      </div>
      {deleted ? (
        <p className="ok">
          Organisation removed. Its infrastructure, virtual key and LiteLLM team are gone and you no
          longer belong to it; the projects, sessions and cost history are retained for audit.
        </p>
      ) : status === 'offboarding' && remaining > 0 ? (
        <p className="error">
          {remaining} step{remaining === 1 ? '' : 's'} still owed — agent calls stay refused until the
          removal finishes. Retry to resume at the first step that did not complete.
        </p>
      ) : null}
      {error ? <p className="error">{error}</p> : null}
      <StepList meta={OFFBOARD_META} states={states} />
    </section>
  );
}
