# Authentication & authorization

Individual user accounts on a shared, multi-user platform. Roles: `USER`,
`ADMIN`. There are no tenants, organizations, memberships or workspaces in
DealMind.

**Identity is owned by the shared EasyDev IAM** (see
[SHARED_SERVICES.md](SHARED_SERVICES.md)). The DealMind API is a
backend-for-frontend (BFF) in front of it.

## Architecture

```
Browser ──► Next.js (web origin) ──/api/* proxy──► DealMind API ──► EasyDev IAM
  │  HttpOnly dm_session cookie (first-party)         │  UserSession: cookie hash +
  │  readable CSRF cookie → x-csrf-token header       │  AES-GCM-encrypted IAM tokens
  └─ no tokens in JS or localStorage                  └─► PostgreSQL (User mirror,
                                                          role, status, sessions)
```

| Concern                                                                        | Owner                                            |
| ------------------------------------------------------------------------------ | ------------------------------------------------ |
| Passwords, hashing, password policy                                            | IAM                                              |
| Sign-up, email verification, password reset/change, identity emails            | IAM (emails via the shared notification service) |
| IAM sessions, refresh-token rotation                                           | IAM                                              |
| Browser session cookie, CSRF, session listing/revocation, idle/absolute expiry | DealMind                                         |
| DealMind role (USER/ADMIN) and suspension                                      | DealMind                                         |
| Enumeration-safe responses, per-account login lockout                          | DealMind (on top of the IAM)                     |

## Session lifecycle

1. **Login:** DealMind calls IAM `/auth/login`, verifies the returned access
   token against the IAM's JWKS (RS256, `iss`, `aud`), creates or updates the
   local `User` mirror (keyed by `iamUserId`), and creates a `UserSession`
   holding both IAM tokens encrypted. The browser gets only an opaque
   `HttpOnly; SameSite=Lax` cookie (`Secure` + `__Host-` over HTTPS).
2. **Each request:** the cookie is resolved against `UserSession` (absolute 30 d
   and idle 7 d expiry, user must be ACTIVE). When the cached IAM access token
   expires (15 min), DealMind refreshes it, which re-validates the IAM session.
   Refreshes are single-flight per session (in-process + row lock), because IAM
   refresh tokens are single-use.
3. **IAM revocation** (reset elsewhere, theft detection, sign-out of the IAM
   session) ends the DealMind session at the next revalidation (≤ ~15 min).
4. **Logout / revoke a session:** DealMind revokes its session and the matching
   IAM session.
5. **Rotation:** new DealMind session id on login (any presented session is
   revoked: session-fixation defence) and on password change. A role change
   revokes the user's DealMind sessions. Replaying a rotated-away cookie
   revokes its whole family.
6. **IAM outage:** sign-in → `503 DEPENDENCY_UNAVAILABLE`; signed-in users keep
   working until a refresh is needed, then get `503` (never a logout).

## Security controls

| Requirement      | Implementation                                                                                                                                                       |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Password hashing | Delegated to the IAM. DealMind never stores passwords                                                                                                                |
| Password policy  | Shared Zod schema mirrors the IAM policy (lower/upper/digit/`@$!%*?&`), min 10                                                                                       |
| Cookies          | HttpOnly session cookie, `SameSite=Lax`, `Secure` + `__Host-` over HTTPS                                                                                             |
| CSRF             | Signed double-submit token on every POST/PATCH/PUT/DELETE (incl. login) + `Origin` allow-list + `Sec-Fetch-Site` check                                               |
| Token handling   | IAM tokens AES-256-GCM encrypted at rest; never sent to browsers; IAM payloads mapped field-by-field and response schemas strip anything else                        |
| Brute force      | Per-IP route limits (credentials 10/min, email 5/15 min), per-account lockout (5 failures / 15 min), plus the IAM's own throttling                                   |
| Enumeration      | Register and forgot-password always return the same 202; login has one generic 401                                                                                   |
| Identity source  | `request.auth` comes only from the verified DealMind session. Inputs are `.strict()`: `userId`/`role` in bodies are rejected. A raw IAM bearer token is not accepted |
| Ownership        | Sessions, profile and preferences are scoped by the authenticated `userId`; foreign records → 404                                                                    |

## Middleware

```ts
app.get("/x", { preHandler: app.requireAuth }, handler);      // any signed-in ACTIVE user
app.get("/y", { preHandler: app.requireRole("ADMIN") }, ...); // specific role
app.addHook("preHandler", app.requireAdmin);                  // whole plugin: admins only
const { userId, role, sessionId } = getAuth(request);         // inside handlers
```

Roles come from DealMind's database on every request; IAM roles are not used
for DealMind authorization.

## Endpoints (`/api/v1`)

| Method & path                                              | Auth    | Backed by                                       |
| ---------------------------------------------------------- | ------- | ----------------------------------------------- |
| `GET /auth/csrf`                                           | –       | DealMind                                        |
| `POST /auth/register`                                      | –       | IAM `/auth/register` (always `202`, same body)  |
| `POST /auth/login`                                         | –       | IAM `/auth/login` → DealMind session cookie     |
| `POST /auth/logout`                                        | session | DealMind + IAM `/auth/logout`                   |
| `GET /auth/me`                                             | session | DealMind mirror                                 |
| `POST /auth/verify-email`                                  | –       | IAM `/auth/register/verify`                     |
| `POST /auth/resend-verification`                           | session | IAM `/auth/register/send-verification`          |
| `POST /auth/forgot-password`                               | –       | IAM `/auth/password/forgot` (always `202`)      |
| `POST /auth/reset-password`                                | –       | IAM `/auth/password/reset`                      |
| `POST /auth/change-password`                               | session | IAM `/auth/password/change` + DealMind rotation |
| `GET /auth/sessions`                                       | session | DealMind sessions                               |
| `DELETE /auth/sessions/:id`                                | session | DealMind + IAM `DELETE /sessions/:id`           |
| `PATCH /users/me`                                          | session | IAM `PATCH /profile`, then mirror               |
| `GET/PATCH /users/me/preferences`                          | session | DealMind (shopping preferences)                 |
| `GET /admin/users`, `PATCH /admin/users/:id/{status,role}` | ADMIN   | DealMind (audit-logged)                         |

## Configuration

API (`.env`):

| Variable                                                  | Purpose                                                                       |
| --------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `IAM_BASE_URL`                                            | e.g. `http://127.0.0.1:3304/api/v1/iam`                                       |
| `IAM_TENANT`                                              | `x-tenant-id` sent to the IAM (default `easydev`; config only)                |
| `IAM_JWT_ISSUER` / `IAM_JWT_AUDIENCE`                     | `iam-service` / `easydev`                                                     |
| `IAM_JWKS_URL`                                            | default `<IAM_BASE_URL>/.well-known/jwks.json`                                |
| `IAM_TIMEOUT_MS`                                          | default 8000                                                                  |
| `TOKEN_ENCRYPTION_KEY`                                    | 32-byte base64 AES key for stored IAM tokens (rotating it signs everyone out) |
| `SESSION_SECRET`                                          | HMAC key for CSRF tokens (≥32 chars)                                          |
| `SESSION_TTL_DAYS` / `SESSION_IDLE_TIMEOUT_DAYS`          | 30 / 7                                                                        |
| `COOKIE_SECURE`, `APP_URL`, `CORS_ORIGINS`, `TRUST_PROXY` | Cookie flags, Origin allow-list, proxy trust                                  |
| `NOTIFICATION_*`, `FILE_SERVICE_*`                        | Shared services (optional until used); see SHARED_SERVICES.md                 |

Web: `API_INTERNAL_URL`, `TRUSTED_PROXY_COUNT`, `PORT` (unchanged; see README).

## Known limitations

- **Email links:** the IAM builds verification/reset links from its global
  `FRONTEND_URL` (EasyDev's frontend), so DealMind users' links point there.
  See SHARED_SERVICES.md, "Open issue".
- IAM-side revocation reaches DealMind within ~15 minutes, not instantly.
- IAM 2FA challenges are not supported by DealMind's login yet (responds 403).
- Accounts are shared with other EasyDev products: a DealMind suspension
  blocks DealMind only, not the IAM account.

## Tests

- `apps/api/src/test/auth.db.test.ts` (44 tests): the real app and PostgreSQL
  against a **fake IAM** reproducing the observed contract. Covers the 12
  required scenarios plus token encryption, IAM payload non-leakage, single
  refresh under concurrency, IAM-side revocation, outage resilience, CSRF and
  rate limits. Mutation-checked.
- `apps/api/src/test/iam.contract.test.ts` (`test:contract`, opt-in): the same
  client and verifier against the **real** IAM, to keep the fake honest.
- Unit: token cipher, IAM client/verifier, CSRF, cookies, throttle, config.
