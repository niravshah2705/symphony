export function Login({ error, onSignIn }: { error?: string; onSignIn: () => void }) {
  return (
    <div className="center">
      <div className="card login">
        <h1>Fleet</h1>
        <p className="muted">Authenticated KAgent fleet with end-to-end cost visibility.</p>
        <button className="primary" onClick={onSignIn}>
          Sign in with Google
        </button>
        {error ? <p className="error">Control plane unreachable: {error}</p> : null}
        <p className="muted small">
          Sign-in runs through oauth2-proxy at the edge. Local dev without the edge proxy cannot
          complete Google login.
        </p>
      </div>
    </div>
  );
}