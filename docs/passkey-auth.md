# Phone fingerprint authentication

The backend uses WebAuthn/passkeys for phone biometrics. A phone verifies a
fingerprint or face locally through its operating system. The browser sends a
signed WebAuthn response to this API; the API stores only a public key and
never receives or stores the biometric itself.

This implementation is currently an authenticated biometric registration and
verification flow. The user must already be signed in before registering or
verifying a passkey. The verified result can then be used by the attendance
flow as a second factor.

## Configuration

Copy `.env.example` to `.env` and set:

```env
WEBAUTHN_RP_ID=localhost
WEBAUTHN_RP_NAME=Smart Attendance
WEBAUTHN_ORIGIN=http://localhost:5173
```

For production, `WEBAUTHN_ORIGIN` must be the exact HTTPS origin served to the
browser, and `WEBAUTHN_RP_ID` must be that hostname or a registrable parent
domain:

```env
WEBAUTHN_RP_ID=attendance.example.com
WEBAUTHN_RP_NAME=Smart Attendance
WEBAUTHN_ORIGIN=https://attendance.example.com
```

Apply the database migration before starting the API:

```bash
npm run db:migrate
npm run dev
```

The migration creates `webauthn_credentials` and `webauthn_challenges`.

## Endpoints

All endpoints below require the normal authenticated session cookie or bearer
token. They accept both lecturers and students.

### Register a phone passkey

1. Request creation options:

```http
POST /api/v1/auth/passkeys/registration/options
```

2. Pass the response to the browser:

```ts
const options = await api.post('/api/v1/auth/passkeys/registration/options');
const credential = await navigator.credentials.create({
  publicKey: options.data,
});
```

3. Serialize the returned `PublicKeyCredential` and verify it:

```http
POST /api/v1/auth/passkeys/registration/verify
Content-Type: application/json
```

```json
{
  "id": "base64url-credential-id",
  "rawId": "base64url-raw-id",
  "type": "public-key",
  "response": {
    "clientDataJSON": "base64url-data",
    "attestationObject": "base64url-data"
  },
  "clientExtensionResults": {}
}
```

The exact serialization should preserve the browser's WebAuthn response
fields and encode `ArrayBuffer` values as base64url strings.

### Verify a phone passkey

1. Request an authentication challenge:

```http
POST /api/v1/auth/passkeys/authentication/options
```

2. Pass the response to the browser:

```ts
const options = await api.post('/api/v1/auth/passkeys/authentication/options');
const assertion = await navigator.credentials.get({
  publicKey: options.data,
});
```

3. Serialize the `PublicKeyCredential` and submit it:

```http
POST /api/v1/auth/passkeys/authentication/verify
Content-Type: application/json
```

```json
{
  "credential": {
    "id": "base64url-credential-id",
    "rawId": "base64url-raw-id",
    "type": "public-key",
    "response": {
      "clientDataJSON": "base64url-data",
      "authenticatorData": "base64url-data",
      "signature": "base64url-signature",
      "userHandle": "base64url-user-handle"
    },
    "clientExtensionResults": {}
  }
}
```

Successful verification returns:

```json
{
  "data": {
    "verified": true
  }
}
```

## Attendance integration

For fingerprint-confirmed attendance:

1. The student signs in normally.
2. The student calls `POST /api/v1/auth/passkeys/authentication/options`.
3. The phone completes local fingerprint verification.
4. The student calls `POST /api/v1/auth/passkeys/authentication/verify`.
5. After `{ "verified": true }`, the client submits the existing attendance
   session payload to `POST /api/v1/sessions/scan` or
   `POST /api/v1/attendance/check-in`.

The current passkey verification endpoint confirms the biometric but does not
itself create an attendance record. This keeps authentication and attendance
rules separate and allows the attendance endpoint to continue enforcing
session expiry, enrollment, geofence, and rate limits.

## Security notes

- Never send a raw fingerprint image or biometric template to this API.
- Do not accept a student ID from the browser; derive identity from the
  authenticated session.
- Use HTTPS in production. Browsers permit WebAuthn on `localhost` for local
  development, but not on arbitrary insecure domains.
- Challenges expire after five minutes and are consumed after verification.
- The credential counter is checked and updated to detect authenticator
  cloning or replay.
