# Vendored Firebase JS SDK

Firebase JS SDK 10.14.1 compat (UMD) builds, downloaded from
`https://www.gstatic.com/firebasejs/10.14.1/`:

- `firebase-app-compat.js`
- `firebase-firestore-compat.js`
- `firebase-auth-compat.js`

Vendored (not CDN) to match `public/vendor/firebase/` and to keep the page's
CSP at `script-src 'self'`. `firebase-auth-compat.js` is optional at runtime —
sign-in is only offered when the gateway's `/api/auth/config` says Google is
enabled.

Refresh with:

```bash
for f in firebase-app-compat firebase-firestore-compat firebase-auth-compat; do
  curl -fsSL -o secrets/vendor/$f.js https://www.gstatic.com/firebasejs/10.14.1/$f.js
done
```
