import type { StepMeta, StepState } from '../types';

const STATUS_LABEL: Record<string, string> = {
  pending: 'Pending',
  running: 'Running',
  done: 'Done',
  failed: 'Failed',
};

// The step list both wizards render. Generic over the step id because onboarding
// and offboarding are different DAGs that share one table of results.
export function StepList<S extends string>({
  meta,
  states,
}: {
  meta: StepMeta<S>[];
  states: Partial<Record<S, StepState<S>>>;
}) {
  return (
    <ol className="steps">
      {meta.map((m) => {
        const s = states[m.id];
        const status = s?.status ?? 'pending';
        // A step that was best-effort finished without doing the thing, and says so.
        // Rendering it as plain "Done" would hide the one resource left behind.
        const skipped = s?.result?.skipped;
        const reason = typeof s?.result?.error === 'string' ? s.result.error : s?.error;
        return (
          <li key={m.id} className={`step status-${status}`}>
            <span className="diagram">#{m.diagram}</span>
            <span className="step-label">{m.label}</span>
            <span className={`badge badge-${status}`}>{STATUS_LABEL[status]}</span>
            {skipped ? <span className="badge badge-state">{`Skipped (${skipped})`}</span> : null}
            {s && s.attempt > 1 ? <span className="muted small">attempt {s.attempt}</span> : null}
            {reason ? <span className="error small">{reason}</span> : null}
          </li>
        );
      })}
    </ol>
  );
}
