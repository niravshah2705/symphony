import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from './api';
import type { Org, User } from './types';
import { Login } from './components/Login';
import { Shell } from './components/Shell';

type AuthState =
  | { status: 'loading' }
  | { status: 'login'; error?: string }
  | { status: 'ready'; user: User; orgs: Org[] };

export function App() {
  const [state, setState] = useState<AuthState>({ status: 'loading' });

  const load = useCallback(async () => {
    try {
      const { user, orgs } = await api.me();
      setState({ status: 'ready', user, orgs });
    } catch (err) {
      // 401 is the normal unauthenticated path; anything else (BFF down, network)
      // is surfaced so local dev without the edge is diagnosable.
      const error = err instanceof ApiError && err.status === 401 ? undefined : String(err);
      setState({ status: 'login', error });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (state.status === 'loading') {
    return <div className="center muted">Loading…</div>;
  }

  if (state.status === 'login') {
    return (
      <Login
        error={state.error}
        onSignIn={() => {
          const rd = encodeURIComponent(window.location.pathname + window.location.search);
          window.location.assign(`/oauth2/start?rd=${rd}`);
        }}
      />
    );
  }

  return (
    <Shell
      user={state.user}
      orgs={state.orgs}
      onRefresh={load}
      onLogout={async () => {
        await api.logout().catch(() => undefined);
        const rd = encodeURIComponent(`${window.location.origin}/`);
        window.location.assign(`/oauth2/sign_out?rd=${rd}`);
      }}
    />
  );
}