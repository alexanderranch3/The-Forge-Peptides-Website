// ─────────────────────────────────────────────────────────────────────────────
// _webauthn.js — verifying a Face ID login, on node:crypto alone.
//
// Frank: "log in to the app using my Face ID. So I don't have to enter the
// password every time I click into the app." iOS holds the private key in the
// Secure Enclave and only signs after Face ID, so the phone proves possession
// and no password crosses the wire.
//
// 🔑 NO CBOR DECODER ANYWHERE, and that is deliberate. The usual pain of
// WebAuthn is parsing the CBOR attestationObject to dig out a COSE public key.
// Safari 16+/iOS 16+ expose `getPublicKey()` on the registration response,
// which hands over SPKI DER directly — so registration stores that and every
// later login is an ordinary `crypto.verify`. Same reasoning as _push.js: this
// repo has no dependencies and adding one for a key parser is not warranted.
//
// 🚨 WHAT THE CLIENT SENDS IS NEVER TRUSTED ON LOGIN. The public key is taken
// on trust exactly once, at registration, which already requires a valid admin
// token. From then on the SERVER checks: the challenge is one it issued and has
// not seen before, the origin and RP ID match this site, the user really was
// verified (Face ID, not just presence), and the signature is valid over the
// exact bytes. Anything short of all four is a rejection.
// ─────────────────────────────────────────────────────────────────────────────

const crypto = require('crypto');

// Set from the deployed host so a preview deploy cannot mint credentials that
// work on production, and vice versa.
const RP_ID   = process.env.WEBAUTHN_RP_ID  || 'theforgepeptides.com';
const ORIGIN  = process.env.WEBAUTHN_ORIGIN || `https://${RP_ID}`;
const RP_NAME = 'Forge Admin';

const b64url   = (b) => Buffer.from(b).toString('base64url');
const unb64url = (s) => Buffer.from(String(s), 'base64url');

// WebAuthn flag bits in authenticatorData[32].
const FLAG_UP = 0x01; // user present  — someone touched the device
const FLAG_UV = 0x04; // user verified — Face ID / Touch ID / passcode actually passed

/**
 * authenticatorData is a fixed binary layout, not CBOR:
 *   rpIdHash[32] || flags[1] || signCount[4] || (attested data…)
 */
function parseAuthenticatorData(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 37) throw new Error('authenticatorData is too short');
  return {
    rpIdHash: buf.subarray(0, 32),
    flags: buf.readUInt8(32),
    signCount: buf.readUInt32BE(33),
  };
}

/**
 * The checks every WebAuthn response must pass, registration or login alike.
 * Returns the parsed authenticator data; throws with a plain-English reason.
 */
function verifyCommon({ clientDataJSON, authenticatorData, expectedChallenge, expectedType }) {
  let clientData;
  try { clientData = JSON.parse(Buffer.from(clientDataJSON, 'base64url').toString('utf8')); }
  catch { throw new Error('clientDataJSON is not valid JSON'); }

  if (clientData.type !== expectedType) {
    // 🚨 Stops an assertion gathered for one ceremony being replayed into the
    // other — a registration signature must not log anybody in.
    throw new Error(`wrong ceremony type: ${clientData.type}`);
  }

  // Timing-safe, and length-checked first because timingSafeEqual throws on a
  // length mismatch rather than returning false.
  const got = Buffer.from(String(clientData.challenge));
  const want = Buffer.from(String(expectedChallenge));
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) {
    throw new Error('challenge does not match');
  }

  if (clientData.origin !== ORIGIN) throw new Error(`unexpected origin: ${clientData.origin}`);

  const authData = parseAuthenticatorData(unb64url(authenticatorData));

  // The authenticator hashes the RP ID it believes it is signing for. If that
  // is not this site, the credential belongs somewhere else.
  const expectedRpIdHash = crypto.createHash('sha256').update(RP_ID).digest();
  if (!crypto.timingSafeEqual(authData.rpIdHash, expectedRpIdHash)) {
    throw new Error('this credential is for a different site');
  }

  if (!(authData.flags & FLAG_UP)) throw new Error('user presence flag not set');
  // 🚨 UV, not just UP. Without this a passkey could satisfy the login with a
  // mere tap and Face ID would be decorative — which is the entire feature.
  if (!(authData.flags & FLAG_UV)) throw new Error('Face ID / passcode was not verified');

  return authData;
}

/**
 * Verify a login assertion against the stored public key.
 *
 * The signed bytes are authenticatorData || SHA-256(clientDataJSON) — the raw
 * concatenation, hashed once by the verifier.
 */
function verifyAssertion({ credential, clientDataJSON, authenticatorData, signature, expectedChallenge }) {
  const authData = verifyCommon({
    clientDataJSON, authenticatorData, expectedChallenge, expectedType: 'webauthn.get',
  });

  const signedBytes = Buffer.concat([
    unb64url(authenticatorData),
    crypto.createHash('sha256').update(Buffer.from(clientDataJSON, 'base64url')).digest(),
  ]);

  const keyObject = crypto.createPublicKey({
    key: unb64url(credential.public_key),
    format: 'der',
    type: 'spki',
  });

  // ES256 signatures arrive DER-encoded from WebAuthn (unlike VAPID's raw
  // r||s), so the default dsaEncoding is correct here — the opposite of
  // _push.js, which is worth stating because the two sit side by side.
  const alg = Number(credential.algorithm);
  const okSig = alg === -257
    ? crypto.verify('sha256', signedBytes, {
        key: keyObject, padding: crypto.constants.RSA_PKCS1_PADDING,
      }, unb64url(signature))
    : crypto.verify('sha256', signedBytes, keyObject, unb64url(signature));

  if (!okSig) throw new Error('signature did not verify');
  return { signCount: authData.signCount };
}

/** The registration ceremony's own checks. The public key itself is taken from
 *  getPublicKey() client-side — see the file header for why that is sound. */
function verifyRegistration({ clientDataJSON, authenticatorData, expectedChallenge }) {
  return verifyCommon({
    clientDataJSON, authenticatorData, expectedChallenge, expectedType: 'webauthn.create',
  });
}

const newChallenge = () => b64url(crypto.randomBytes(32));

module.exports = {
  RP_ID, ORIGIN, RP_NAME,
  b64url, unb64url,
  parseAuthenticatorData, verifyCommon, verifyAssertion, verifyRegistration, newChallenge,
  FLAG_UP, FLAG_UV,
};
