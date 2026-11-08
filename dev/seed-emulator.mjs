// Seeds one approved test account into the LOCAL emulators (project demo-tessera only).
const P = 'demo-tessera';
const AUTH = 'http://127.0.0.1:9099';
const FS = `http://127.0.0.1:8080/v1/projects/${P}/databases/(default)/documents`;
const email = 'e2e@example.com';
const password = 'Passw0rd!e2e';

async function j(url, opts) {
  const r = await fetch(url, opts);
  const t = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${url}: ${t}`);
  return t ? JSON.parse(t) : {};
}
const owner = { 'content-type': 'application/json', authorization: 'Bearer owner' };

const su = await j(`${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email, password, returnSecureToken: true }),
});
const uid = su.localId;
await j(`${AUTH}/identitytoolkit.googleapis.com/v1/projects/${P}/accounts:update`, {
  method: 'POST', headers: owner,
  body: JSON.stringify({ localId: uid, emailVerified: true, customAttributes: JSON.stringify({ phoneVerified: true }) }),
});
const now = Date.now();
await j(`${FS}/users/${uid}`, {
  method: 'PATCH', headers: owner,
  body: JSON.stringify({ fields: {
    accessStatus: { stringValue: 'approved' },
    accountStatus: { stringValue: 'active' },
    phoneVerified: { booleanValue: true },
    phoneNumber: { stringValue: '+233200000000' },
    consent: { mapValue: { fields: {
      termsVersion: { stringValue: '1.2' }, privacyVersion: { stringValue: '1.2' },
      acceptedAt: { integerValue: String(now) }, method: { stringValue: 'checkbox' },
    } } },
  } }),
});
console.log(JSON.stringify({ uid, email, password }));
