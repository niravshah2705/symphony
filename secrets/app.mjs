// secrets.archagentix.com — browser glue. Encrypts in-page, stores only the
// ciphertext in Firestore, and carries the key material in the URL fragment
// (fragments are never sent to the hosting server and never logged).

import {
  randomBytes,
  shareId,
  bytesToB64url,
  b64urlToBytes,
  importAesKey,
  deriveAesKey,
  encryptShare,
  openKey,
  decryptShare,
  MAX_SECRET_BYTES,
} from './crypto.mjs';
import {
  EXPIRY_OPTIONS,
  DEFAULT_EXPIRY,
  expiryMs,
  expiresAtDate,
} from './expiry.mjs';

var cfg = window.__SECRETS_CONFIG__ || {};
var COLLECTION = 'secret_shares';
var db = null;
var auth = null;

function $(id) { return document.getElementById(id); }

function show(id) {
  ['view-create', 'view-read', 'view-error'].forEach(function (v) {
    $(v).hidden = v !== id;
  });
}

function fail(message) {
  $('error-message').textContent = message;
  show('view-error');
}

function boot() {
  if (!cfg.apiBase) {
    fail('This deployment has no gateway origin configured yet (secrets/config.js).');
    return;
  }
  // The same PUBLIC firebase web config the platform SPA uses, from
  // services/gateway/src/auth.js publicAuthConfig(). Nothing secret crosses
  // this call — the share key lives only in the URL fragment.
  fetch(cfg.apiBase + '/api/auth/config', { cache: 'no-store' })
    .then(function (r) {
      if (!r.ok) throw new Error('gateway returned ' + r.status);
      return r.json();
    })
    .then(function (c) {
      var f = c && c.firebase;
      if (!f || !f.apiKey || !f.projectId) throw new Error('no firebase config on this gateway');
      authConfig = f;
      firebase.initializeApp({ apiKey: f.apiKey, authDomain: f.authDomain, projectId: f.projectId });
      db = firebase.firestore();
      auth = firebase.auth();
      wireForm();
      wireAuth();
      route();
      window.addEventListener('hashchange', route);
    })
    .catch(function (err) {
      fail('Could not reach the ArchAgentix gateway: ' + err.message);
    });
}

var authConfig = null;

// ---------- routing: "/" is create, "#<id>|<key>" is read ----------

function route() {
  var m = location.hash.slice(1).match(/^([A-Za-z0-9_-]{20,64})\|([A-Za-z0-9_-]+)$/);
  if (!m) {
    show('view-create');
    return;
  }
  openShare(m[1], m[2]);
}

// ---------- create ----------

function wireForm() {
  var select = $('expiry');
  EXPIRY_OPTIONS.forEach(function (o) {
    var opt = document.createElement('option');
    opt.value = o.id;
    opt.textContent = 'Expires after ' + o.label.toLowerCase();
    if (o.id === DEFAULT_EXPIRY) opt.selected = true;
    select.appendChild(opt);
  });
  $('create-form').addEventListener('submit', createShare);
  $('passphrase-open').addEventListener('click', function () {
    if (pending) reveal(pending, $('passphrase-input').value);
  });
}

async function createShare(event) {
  event.preventDefault();
  var button = $('create-submit');
  button.disabled = true;
  try {
    var plaintext = $('secret').value;
    if (!plaintext) return fail('Nothing to share — type or paste a secret first.');
    if (new TextEncoder().encode(plaintext).length > MAX_SECRET_BYTES) {
      return fail('Secret is too large — the limit is 1 KB (' + MAX_SECRET_BYTES + ' bytes).');
    }

    var passphrase = $('passphrase').value;
    var expiryId = $('expiry').value;
    var oneTime = $('one-time').checked;

    var keyMaterial = randomBytes(32);
    var salt = passphrase ? randomBytes(16) : null;
    var key = passphrase
      ? await deriveAesKey(keyMaterial, passphrase, salt)
      : await importAesKey(keyMaterial);
    var payload = await encryptShare(plaintext, key, passphrase ? 'pbkdf2' : 'raw', salt);

    var id = shareId();
    var record = Object.assign({}, payload, {
      expiresAt: expiresAtDate(expiryId),
      oneTime: oneTime,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      ownerUid: (auth.currentUser && auth.currentUser.uid) || null,
    });
    await db.collection(COLLECTION).doc(id).set(record);

    var link = location.origin + location.pathname + '#' + id + '|' + bytesToB64url(keyMaterial);
    $('share-link').value = link;
    $('passphrase-note').hidden = !passphrase;
    $('expiry-note').textContent = 'Expires after ' + expiryMs(expiryId) / 3600000 + ' h — after that Firestore rules refuse every read.';
    $('result').hidden = false;
    $('create-form').reset();
    wireExpirySelectAgain();
  } catch (err) {
    fail('Could not create the share: ' + err.message);
  } finally {
    button.disabled = false;
  }
}

function wireExpirySelectAgain() {
  // reset() restores markup order, not the default — re-select 24h.
  $('expiry').value = DEFAULT_EXPIRY;
}

// ---------- read ----------

var pending = null;

async function openShare(id, keyB64url) {
  show('view-read');
  $('read-status').textContent = 'Loading…';
  $('reveal').hidden = true;
  $('passphrase-prompt').hidden = true;
  var snapshot;
  try {
    snapshot = await db.collection(COLLECTION).doc(id).get();
  } catch (err) {
    // Expired docs read as permission-denied; show the same face as a miss so
    // the store leaks nothing about which shares existed.
    return reportUnreadable();
  }
  if (!snapshot.exists) return reportUnreadable();

  var doc = snapshot.data();
  pending = { id: id, doc: doc, keyMaterial: b64urlToBytes(keyB64url) };
  renderCountdown(doc);
  if (doc.kdf === 'pbkdf2') {
    $('passphrase-prompt').hidden = false;
    $('read-status').textContent = 'This secret is passphrase-protected.';
  } else {
    reveal(pending, null);
  }
}

function reportUnreadable() {
  $('read-status').textContent = 'This link is dead: the secret expired, was already burned, or never existed.';
}

async function reveal(state, passphrase) {
  var key;
  try {
    key = await openKey(state.keyMaterial, passphrase, state.doc.kdf, state.doc.salt);
  } catch (err) {
    return showReadError(err.message);
  }
  var plaintext;
  try {
    plaintext = await decryptShare(state.doc, key);
  } catch (err) {
    return showReadError('Wrong passphrase — the encrypted check block did not verify.');
  }
  $('secret-out').textContent = plaintext;
  $('reveal').hidden = false;
  $('passphrase-prompt').hidden = true;
  $('read-status').textContent = state.doc.oneTime
    ? 'Burning this share now — it will not open again.'
    : 'Decrypted locally. The key never left this browser’s URL fragment.';
  if (state.doc.oneTime) {
    db.collection(COLLECTION).doc(state.id).delete().catch(function () {});
  }
}

function showReadError(message) {
  $('read-status').textContent = message;
}

function renderCountdown(doc) {
  var out = $('countdown');
  function tick() {
    var ms = doc.expiresAt ? doc.expiresAt.toMillis() - Date.now() : 0;
    if (ms <= 0) {
      out.textContent = 'expired';
      return;
    }
    var h = Math.floor(ms / 3600000);
    var m = Math.floor((ms % 3600000) / 60000);
    out.textContent = 'expires in ' + h + 'h ' + m + 'm';
    setTimeout(tick, 30000);
  }
  tick();
}

// ---------- ArchAgentix sign-in (optional, same Identity Platform) ----------

function wireAuth() {
  auth.onAuthStateChanged(function (user) {
    $('sign-in').hidden = !!user || !authConfig || authConfig.googleEnabled === false;
    $('signed-in').hidden = !user;
    if (user) {
      $('user-email').textContent = user.email || '(signed in)';
      listShares(user);
    } else {
      $('my-shares').hidden = true;
    }
  });
  $('google-signin').addEventListener('click', function () {
    var provider = new firebase.auth.GoogleAuthProvider();
    if (authConfig && authConfig.hostedDomain) provider.setCustomParameters({ hd: authConfig.hostedDomain });
    auth.signInWithPopup(provider).catch(function (err) {
      showReadError('Sign-in failed: ' + err.message);
    });
  });
  $('sign-out').addEventListener('click', function () { auth.signOut(); });
}

async function listShares(user) {
  // The expiresAt filter is required by the read rule (a list may only match
  // docs the rule can prove readable), and it also hides dead shares.
  var snapshot = await db.collection(COLLECTION)
    .where('ownerUid', '==', user.uid)
    .where('expiresAt', '>', new Date())
    .limit(50)
    .get();
  var list = $('share-list');
  list.textContent = '';
  snapshot.forEach(function (doc) {
    var row = document.createElement('li');
    var label = document.createElement('span');
    var d = doc.data();
    label.textContent = (d.oneTime ? 'one-time ' : '') + 'share · expires ' +
      (d.expiresAt ? new Date(d.expiresAt.toMillis()).toLocaleString() : 'unknown');
    var cancel = document.createElement('button');
    cancel.textContent = 'Cancel now';
    cancel.addEventListener('click', function () {
      doc.ref.delete().then(function () { row.remove(); });
    });
    row.appendChild(label);
    row.appendChild(cancel);
    list.appendChild(row);
  });
  $('my-shares').hidden = snapshot.empty;
}

// ---------- misc ----------

$('copy-link').addEventListener('click', function () {
  $('share-link').select();
  document.execCommand('copy');
  $('copy-link').textContent = 'Copied';
});

document.addEventListener('DOMContentLoaded', boot);
