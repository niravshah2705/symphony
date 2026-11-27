import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import {
  BUNDLE_META,
  type BundleBaseOption,
  type BundleBuild,
  type BundleCatalog,
  type BundleStates,
  type BundleStepId,
  type Org,
  type StepState,
} from '../types';
import { StepList } from './StepList';

// The bundle wizard: pick a harness runtime and the plugin packs to install onto
// its image, and watch the nine steps that build it and write it into the tenant.
//
// It is deliberately not part of the onboarding panel. Onboarding is a one-time
// machine whose steps are the tenant's identity; a bundle is re-runnable per runtime,
// and a re-run must never be able to re-enter the onboarding DAG of a live tenant.
const AVAILABILITY_LABEL: Record<string, string> = {
  offerable: 'supported',
  'unblocks-here': 'unblocked by this build',
  'blocked-elsewhere': 'blocked',
  'no-column': 'not graded',
  'not-listed': 'not graded',
};

export function BundleWizard({ org }: { org: Org }) {
  const [catalog, setCatalog] = useState<BundleCatalog | null>(null);
  const [runtime, setRuntime] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [states, setStates] = useState<BundleStates>({});
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const abort = useRef<AbortController | null>(null);

  function reload() {
    return api
      .getBundles(org.id)
      .then((c) => {
        setCatalog(c);
        setRuntime((prev) => prev || c.bases.find((b) => b.selectable.length > 0)?.runtime || c.bases[0]?.runtime || '');
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }

  useEffect(() => {
    let cancelled = false;
    api
      .getBundles(org.id)
      .then((c) => {
        if (cancelled) return;
        setCatalog(c);
        setRuntime(c.bases.find((b) => b.selectable.length > 0)?.runtime ?? c.bases[0]?.runtime ?? '');
        const last = c.runs[0];
        if (last) setStates(last.states);
      })
      .catch((err) => !cancelled && setError(String(err)));
    return () => {
      cancelled = true;
      abort.current?.abort();
    };
    // org.id only: a mount-time read. A re-render must never restart a build.
  }, [org.id]);

  const base: BundleBaseOption | undefined = useMemo(
    () => catalog?.bases.find((b) => b.runtime === runtime),
    [catalog, runtime],
  );

  // A different runtime is a different plugin set, so carrying the old one over would
  // build something the owner did not choose.
  function pickRuntime(next: string) {
    setRuntime(next);
    setSelected([]);
    setStates({});
  }

  function toggle(id: string) {
    setSelected((prev) => (prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]));
  }

  async function build() {
    if (!base) return;
    setRunning(true);
    setError('');
    setStates({});
    const controller = new AbortController();
    abort.current = controller;
    try {
      await api.runBundle(
        org.id,
        { runtime: base.runtime, plugins: selected },
        (event, data) => {
          if (event === 'step') {
            const s = JSON.parse(data) as StepState<BundleStepId>;
            setStates((prev) => ({ ...prev, [s.step]: s }));
          } else if (event === 'done') {
            const payload = JSON.parse(data) as { complete: boolean; states: BundleStates; builds: BundleBuild[] };
            setStates(payload.states);
            setCatalog((c) => (c ? { ...c, builds: payload.builds } : c));
            if (!payload.complete) {
              setError('The build stopped before the Harness was written. Re-run the same selection to resume at the first step that did not finish.');
            }
          } else if (event === 'error') {
            setError((JSON.parse(data) as { message: string }).message);
          }
        },
        controller.signal,
      );
      await reload();
    } catch (err) {
      if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }

  if (error && !catalog) return <p className="error">{error}</p>;
  if (!catalog) return <p className="muted">Loading bundle catalog…</p>;

  if (!catalog.enabled) {
    return (
      <section>
        <h2>Bundles — {org.name}</h2>
        <p className="muted">
          Bundle builds are off for this deployment. Enabling them means the control plane holds a
          Google Cloud service account that can spend Cloud Build seconds and write an Artifact
          Registry repository: set <code>BUNDLE_ENABLED=true</code> with <code>GCP_PROJECT_ID</code>,{' '}
          <code>GCP_REGION</code> and <code>BUNDLE_REPO</code>, and mount the key — fleet-local/docs/SETUP-ENVIRONMENT.md
          has the grant list.
        </p>
      </section>
    );
  }

  const doneCount = BUNDLE_META.filter((s) => states[s.id]?.status === 'done').length;

  return (
    <section>
      <div className="row">
        <h2>Bundles — {org.name}</h2>
        <div className="spacer" />
        <span className="muted small">{doneCount}/{BUNDLE_META.length} steps</span>
        <button
          className="primary"
          disabled={running || !base || selected.length === 0}
          onClick={() => void build()}
        >
          {running ? 'Building…' : doneCount === BUNDLE_META.length ? 'Rebuild' : 'Build bundle'}
        </button>
      </div>
      <p className="muted small">
        A bundle installs plugin requirements onto a harness runtime image, builds it in Cloud
        Build, and adds it to this tenant as a new harness plus an agent named{' '}
        <code>bundle-{runtime || '…'}-worker</code>. The existing harnesses are not touched.
      </p>

      <div className="row">
        <label className="muted small" htmlFor="bundle-runtime">
          Harness runtime
        </label>
        <select id="bundle-runtime" value={runtime} disabled={running} onChange={(e) => pickRuntime(e.target.value)}>
          {catalog.bases.map((b) => (
            <option key={b.runtime} value={b.runtime}>
              {b.label} — {b.family} base{b.dispatchable ? '' : ' (buildable, not dispatchable yet)'}
            </option>
          ))}
        </select>
        {base ? <span className="muted small">{base.image}</span> : null}
      </div>

      {base && !base.dispatchable ? (
        <p className="error small">
          kagent has no dispatch path for {base.label} yet, so a chat turn will not run on the image
          this builds. It is offered because the build itself is useful: it produces the runtime
          image other work needs.
        </p>
      ) : null}

      {base && base.selectable.length === 0 ? (
        <p className="muted small">
          No plugin pack is graded against {base.label}, so there is nothing this build could add to
          it. Choose a runtime whose matrix column exists.
        </p>
      ) : null}

      <ul className="pack-list">
        {catalog.packs.map((pack) => {
          const verdict = base?.packs[pack.id];
          const availability = verdict?.availability ?? 'not-listed';
          const offerable = availability === 'offerable' || availability === 'unblocks-here';
          return (
            <li key={pack.id} className={`pack ${offerable ? '' : 'muted'}`}>
              <label>
                <input
                  type="checkbox"
                  checked={selected.includes(pack.id)}
                  disabled={!offerable || running}
                  onChange={() => toggle(pack.id)}
                />
                <strong>{pack.label}</strong> <span className="muted small">{pack.kind} · v{pack.version}</span>
              </label>
              <span className={`badge badge-state`}>{AVAILABILITY_LABEL[availability]}</span>
              {verdict?.reason ? <span className="muted small">{verdict.reason}</span> : null}
            </li>
          );
        })}
      </ul>

      {error ? <p className="error">{error}</p> : null}
      <StepList meta={BUNDLE_META} states={states} />

      {catalog.builds.length > 0 ? (
        <>
          <h3>Current bundle images</h3>
          <table>
            <thead>
              <tr>
                <th>Runtime</th>
                <th>Image</th>
                <th>Plugins</th>
              </tr>
            </thead>
            <tbody>
              {catalog.builds.map((b) => (
                <tr key={b.runtime}>
                  <td>bundle-{b.runtime}</td>
                  <td className="small">{b.image}</td>
                  <td className="small">{b.plugins.map((p) => `${p.id}@${p.version}`).join(', ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}
    </section>
  );
}
