import { useState, type FormEvent } from 'react';
import { api } from '../api';
import type { Org, OrgStatus, User } from '../types';
import { OnboardingWizard } from './OnboardingWizard';
import { OffboardWizard } from './OffboardWizard';
import { Thread } from '../assistant-ui/Thread';
import { Costs } from './Costs';

type Tab = 'onboard' | 'chat' | 'costs' | 'offboard';

const TAB_LABEL: Record<Tab, string> = {
  onboard: 'Onboarding',
  chat: 'Chat',
  costs: 'Costs',
  offboard: 'Offboarding',
};

// A suspended org has to stay selectable: its owner is the only one who can undo it.
const STATUS_SUFFIX: Record<OrgStatus, string> = {
  active: '',
  disabled: ' — disabled',
  offboarding: ' — removing',
  deleted: ' — removed',
};

export function Shell({
  user,
  orgs,
  onRefresh,
  onLogout,
}: {
  user: User;
  orgs: Org[];
  onRefresh: () => Promise<void>;
  onLogout: () => Promise<void>;
}) {
  const [activeOrgId, setActiveOrgId] = useState(orgs[0]?.id ?? '');
  const [tab, setTab] = useState<Tab>('onboard');
  const [creating, setCreating] = useState(false);
  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmSlug, setConfirmSlug] = useState('');
  const [offboardStart, setOffboardStart] = useState(false);
  const [busy, setBusy] = useState(false);

  const activeOrg = orgs.find((o) => o.id === activeOrgId) ?? orgs[0];

  async function createOrg(e: FormEvent) {
    e.preventDefault();
    setError('');
    try {
      const { org } = await api.createOrg(slug.trim(), name.trim());
      setCreating(false);
      setSlug('');
      setName('');
      await onRefresh();
      setActiveOrgId(org.id);
      setTab('onboard');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function openTab(next: Tab) {
    setTab(next);
    // Only the confirmation below may start a teardown, never a tab click.
    setOffboardStart(false);
  }

  async function setStatus(next: Exclude<OrgStatus, 'offboarding' | 'deleted'>) {
    if (!activeOrg) return;
    if (next === 'disabled' && !window.confirm(`Disable ${activeOrg.name}? Every agent call for this organisation is refused until it is enabled again.`)) {
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api.setOrgStatus(activeOrg.id, next);
      await onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function startDelete() {
    if (!activeOrg) return;
    setConfirmDelete(false);
    setConfirmSlug('');
    setOffboardStart(true);
    setTab('offboard');
  }

  const tabs: Tab[] = ['onboard', 'chat', 'costs'];
  const owner = activeOrg?.role === 'owner';
  if (owner || activeOrg?.status === 'offboarding') tabs.push('offboard');

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">Fleet</div>
        {orgs.length > 0 ? (
          <select
            className="org-select"
            value={activeOrg?.id ?? ''}
            onChange={(e) => {
              setActiveOrgId(e.target.value);
              setConfirmDelete(false);
              setError('');
            }}
          >
            {orgs.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name} ({o.slug}){STATUS_SUFFIX[o.status]}
              </option>
            ))}
          </select>
        ) : null}
        <button className="ghost" onClick={() => setCreating((v) => !v)}>
          + New org
        </button>
        <div className="spacer" />
        <span className="muted small">{user.email}</span>
        <button className="ghost" onClick={() => void onLogout()}>
          Sign out
        </button>
      </header>

      {creating ? (
        <form className="card inline-form" onSubmit={createOrg}>
          <input
            placeholder="slug (rfc1123, e.g. demo)"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            required
          />
          <input placeholder="Organisation name" value={name} onChange={(e) => setName(e.target.value)} required />
          <button className="primary" type="submit">
            Create
          </button>
          {error ? <span className="error">{error}</span> : null}
        </form>
      ) : null}

      {!activeOrg ? (
        <div className="center muted">Create an organisation to begin onboarding.</div>
      ) : (
        <>
          {owner && activeOrg.status !== 'offboarding' ? (
            <div className="row">
              {activeOrg.status === 'active' ? (
                <button className="ghost" disabled={busy} onClick={() => void setStatus('disabled')}>
                  Disable organisation
                </button>
              ) : (
                <button className="primary" disabled={busy} onClick={() => void setStatus('active')}>
                  Enable organisation
                </button>
              )}
              <button className="ghost danger" disabled={busy} onClick={() => setConfirmDelete((v) => !v)}>
                Delete organisation…
              </button>
              {activeOrg.status === 'disabled' ? (
                <span className="muted small">Disabled: agent calls are refused, infrastructure is untouched.</span>
              ) : null}
            </div>
          ) : null}

          {confirmDelete && activeOrg.status !== 'offboarding' ? (
            <form
              className="card inline-form"
              onSubmit={(e) => {
                e.preventDefault();
                startDelete();
              }}
            >
              <span className="error small">
                Delete {activeOrg.name}: the namespace, worker pool, agents, LiteLLM team and key are
                torn down and the subscription is cancelled. You and every other member lose access.
                Projects, sessions and cost history are kept. This cannot be undone.
              </span>
              <input
                placeholder={`type "${activeOrg.slug}" to confirm`}
                value={confirmSlug}
                onChange={(e) => setConfirmSlug(e.target.value)}
                aria-label="organisation slug"
              />
              <button className="danger" type="submit" disabled={confirmSlug.trim() !== activeOrg.slug}>
                Delete permanently
              </button>
              <button className="ghost" type="button" onClick={() => setConfirmDelete(false)}>
                Cancel
              </button>
            </form>
          ) : null}

          <nav className="tabs">
            {tabs.map((t) => (
              <button key={t} className={tab === t ? 'tab active' : 'tab'} onClick={() => openTab(t)}>
                {TAB_LABEL[t]}
              </button>
            ))}
          </nav>
          <main className="content">
            {tab === 'onboard' ? <OnboardingWizard key={activeOrg.id} org={activeOrg} /> : null}
            {tab === 'chat' ? <Thread key={activeOrg.id} org={activeOrg} /> : null}
            {tab === 'costs' ? <Costs key={activeOrg.id} org={activeOrg} /> : null}
            {tab === 'offboard' ? (
              <OffboardWizard
                key={activeOrg.id}
                org={activeOrg}
                autoStart={offboardStart}
                onFinished={() => {
                  setOffboardStart(false);
                  setTab('onboard');
                  setActiveOrgId('');
                  void onRefresh();
                }}
              />
            ) : null}
          </main>
        </>
      )}
    </div>
  );
}
