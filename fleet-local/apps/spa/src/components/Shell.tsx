import { useState, type FormEvent } from 'react';
import { api } from '../api';
import type { Org, User } from '../types';
import { OnboardingWizard } from './OnboardingWizard';
import { Thread } from '../assistant-ui/Thread';
import { Costs } from './Costs';

type Tab = 'onboard' | 'chat' | 'costs';

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

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">Fleet</div>
        {orgs.length > 0 ? (
          <select
            className="org-select"
            value={activeOrg?.id ?? ''}
            onChange={(e) => setActiveOrgId(e.target.value)}
          >
            {orgs.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name} ({o.slug})
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
          <nav className="tabs">
            {(['onboard', 'chat', 'costs'] as Tab[]).map((t) => (
              <button key={t} className={tab === t ? 'tab active' : 'tab'} onClick={() => setTab(t)}>
                {t === 'onboard' ? 'Onboarding' : t === 'chat' ? 'Chat' : 'Costs'}
              </button>
            ))}
          </nav>
          <main className="content">
            {tab === 'onboard' ? <OnboardingWizard key={activeOrg.id} org={activeOrg} /> : null}
            {tab === 'chat' ? <Thread key={activeOrg.id} org={activeOrg} /> : null}
            {tab === 'costs' ? <Costs key={activeOrg.id} org={activeOrg} /> : null}
          </main>
        </>
      )}
    </div>
  );
}