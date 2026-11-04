// Client-side crypto for secrets.archagentix.com.
//
// The plaintext never leaves this module: a random 256-bit key material is
// generated per share and travels ONLY in the URL fragment (never sent to the
// server). With a passphrase the AES key is PBKDF2(keyMaterial, salt, pass) —
// the fragment alone is then worthless, the passphrase goes out-of-band.
// Import as ESM so node --test suites can exercise the same code browsers run.

var subtle = (typeof crypto !== 'undefined' && crypto.subtle) ? crypto.subtle : null;

export var MAX_SECRET_BYTES = 1024;
export var KDF_ITERATIONS = 200000;
export var KEY_CHECK = 'archagentix-send-v1';

var ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

var B64U = new Map();
(function () {
  for (var i = 0; i < ALPHA.length; i += 1) B64U.set(ALPHA[i], i);
})();

export function bytesToB64url(bytes) {
  var out = '';
  var i;
  for (i = 0; i < bytes.length; i += 3) {
    var b0 = bytes[i];
    var b1 = bytes[i + 1];
    var b2 = bytes[i + 2];
    var n = (b0 << 16) | ((b1 === undefined ? 0 : b1) << 8) | (b2 === undefined ? 0 : b2);
    out += ALPHA[(n >> 18) & 63] + ALPHA[(n >> 12) & 63];
    if (b1 !== undefined) out += ALPHA[(n >> 6) & 63];
    if (b2 !== undefined) out += ALPHA[n & 63];
  }
  return out;
}

export function b64urlToBytes(str) {
  var bytes = [];
  var buffer = 0;
  var bits = 0;
  for (var i = 0; i < str.length; i += 1) {
    var v = B64U.get(str[i]);
    if (v === undefined) throw new Error('bad base64url character');
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}

export function randomBytes(n) {
  var b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

// 32 url-safe random bytes -> a document id no one can enumerate by guessing.
export function shareId() {
  return bytesToB64url(randomBytes(24));
}

export function importAesKey(rawKeyBytes) {
  return subtle.importKey('raw', rawKeyBytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

// With a passphrase, the derived AES key needs BOTH factors: the passphrase
// is the PBKDF2 password and the fragment key material seeds the salt — so a
// leaked link without the passphrase (or vice versa) cannot decrypt.
export function deriveAesKey(rawKeyBytes, passphrase, saltBytes) {
  if (!passphrase) throw new Error('this secret requires a passphrase');
  var salt = new Uint8Array(rawKeyBytes.length + saltBytes.length);
  salt.set(rawKeyBytes, 0);
  salt.set(saltBytes, rawKeyBytes.length);
  return subtle
    .importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey'])
    .then(function (base) {
      return subtle.deriveKey(
        { name: 'PBKDF2', salt: salt, iterations: KDF_ITERATIONS, hash: 'SHA-256' },
        base,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
      );
    });
}

function gcm(ivBytes) {
  return { name: 'AES-GCM', iv: ivBytes };
}

// Encrypt one block under key. Returns base64url strings ready for Firestore.
export function encryptBlock(plaintext, key, ivBytes) {
  var data = new TextEncoder().encode(plaintext);
  return subtle.encrypt(gcm(ivBytes), key, data).then(function (buf) {
    return bytesToB64url(new Uint8Array(buf));
  });
}

export async function decryptBlock(b64url, key, ivBytes) {
  var buf = await subtle.decrypt(gcm(ivBytes), key, b64urlToBytes(b64url));
  return new TextDecoder().decode(buf);
}

// Full share payload: iv per block, keyCheck sentinel re-encrypted with the
// same iv so a wrong key/passphrase fails GCM authentication loudly.
export async function encryptShare(plaintext, key, kdf, saltBytes) {
  var iv = randomBytes(12);
  if (new TextEncoder().encode(plaintext).length > MAX_SECRET_BYTES) {
    throw new Error('secret is larger than ' + MAX_SECRET_BYTES + ' bytes');
  }
  var results = await Promise.all([
    encryptBlock(plaintext, key, iv),
    encryptBlock(KEY_CHECK, key, iv),
  ]);
  return {
    ciphertext: results[0],
    keyCheck: results[1],
    iv: bytesToB64url(iv),
    kdf: kdf,
    salt: saltBytes ? bytesToB64url(saltBytes) : null,
  };
}

// Resolve the AES key from fragment material + optional passphrase.
export function openKey(keyMaterialBytes, passphrase, kdf, saltB64url) {
  if (kdf === 'pbkdf2') {
    if (!passphrase) throw new Error('this secret requires a passphrase');
    return deriveAesKey(keyMaterialBytes, passphrase, b64urlToBytes(saltB64url));
  }
  return importAesKey(keyMaterialBytes);
}

export function decryptShare(doc, key) {
  var iv = b64urlToBytes(doc.iv);
  return decryptBlock(doc.keyCheck, key, iv)
    .then(function (check) {
      if (check !== KEY_CHECK) throw new Error('key check mismatch');
      return decryptBlock(doc.ciphertext, key, iv);
    });
}
