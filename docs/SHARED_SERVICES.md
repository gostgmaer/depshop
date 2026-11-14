# Shared EasyDev services

DealMind does not run its own identity provider, email sender or file store.
It uses the shared EasyDev platform services from `C:\Users\kisho\WorkSpace\Backend`:

| Capability                                                          | Service (repo)                                          | Local endpoint                     | In Docker (`core-network`)            | DealMind integration                                             |
| ------------------------------------------------------------------- | ------------------------------------------------------- | ---------------------------------- | ------------------------------------- | ---------------------------------------------------------------- |
| Identity (sign-up, sign-in, verification, password reset, sessions) | `multi-tannet-auth-services` (container `auth-service`) | `http://127.0.0.1:3304/api/v1/iam` | `http://auth-service:3000/api/v1/iam` | `apps/api/src/modules/iam/*`: REST client + RS256/JWKS verifier  |
| Email / SMS                                                         | `notification-service`                                  | `http://127.0.0.1:4004`            | `http://notification-service:4000`    | `NotificationGateway` over `@easydev_org/notification-sdk@1.0.3` |
| File storage                                                        | `file-upload-service`                                   | `http://127.0.0.1:4005`            | `http://file-upload-service:3000`     | `FileGateway` over `@easydev_org/file-upload-sdk@1.0.4`          |

These services are multi-tenant (`x-tenant-id`). **DealMind is not**: the
tenant value is a configuration constant used only when calling them
(`IAM_TENANT`, `NOTIFICATION_TENANT_ID`, `FILE_SERVICE_TENANT_ID`). It never
appears in DealMind's schema, middleware or API.

Port 4001 on this machine belongs to `ai-email-assistant`'s own file service,
not the shared one.

## How identity works (BFF)

```
Browser ──cookie──► DealMind API ──► IAM  (/auth/login, /auth/refresh, ...)
        (dm_session)   │  verifies IAM access tokens via JWKS (RS256)
                       └► UserSession: encrypted IAM access + refresh tokens
```

- Users register and sign in with DealMind's own pages; the DealMind API calls
  the IAM. The browser only ever holds DealMind's HttpOnly session cookie, and
  IAM tokens never leave the server (AES-256-GCM at rest, `TOKEN_ENCRYPTION_KEY`).
- DealMind keeps a local `User` mirror keyed by `iamUserId` (the IAM `sub`)
  so its own data can use foreign keys, plus the DealMind-specific `role`
  (USER/ADMIN) and `status`. Name and email are synced from the IAM at sign-in.
- IAM refresh tokens are single-use, so refreshes are serialized per session
  (in-process promise map plus `SELECT … FOR UPDATE`).
- IAM-side revocation (password reset, sign-out elsewhere) ends the DealMind
  session at its next IAM revalidation. That happens when the cached IAM
  access token expires, at most about 15 minutes later.
- If the IAM is down, sign-in returns `503 DEPENDENCY_UNAVAILABLE`; already
  signed-in users keep working until their cached IAM token needs refreshing,
  and are **not** logged out because of an outage.
- Identity emails (verification, reset, security notices) are sent **by the
  IAM** through the notification service. DealMind sends no email itself.

## IAM contract (observed on the running service, 2026-11-14)

| Endpoint                                             | Behaviour DealMind depends on                                                                                                                    |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /auth/register`                                | `201 {userId}`; `409 Account already exists` (DealMind hides it: same 202 either way)                                                            |
| `POST /auth/login`                                   | `200 {accessToken, refreshToken, accessExpiresIn: 900, refreshExpiresIn: 604800, user}`; generic `401 Invalid credentials`; `429` when throttled |
| Access token                                         | RS256, `iss=iam-service`, `aud=easydev`, claims `sub, email, sessionId, isEmailVerified, type=access`                                            |
| `/.well-known/jwks.json`                             | Keys wrapped in the response envelope (`data.keys`), not a bare JWK Set                                                                          |
| `POST /auth/refresh`                                 | Rotates the refresh token; a reused old token gets `401` and makes the session non-refreshable                                                   |
| `GET /auth/me`                                       | `401` after logout                                                                                                                               |
| `POST /auth/password/forgot`                         | Same `200` for known and unknown emails                                                                                                          |
| `POST /auth/register/verify`, `/auth/password/reset` | `400` for invalid tokens                                                                                                                         |
| Password policy                                      | ≥8 chars with lowercase, uppercase, digit and one of `@$!%*?&` (DealMind enforces the same, ≥10)                                                 |

`pnpm --filter @dealmind/api test:contract` re-checks this contract against
the running IAM (creates one `@example.com` user and deletes it when
`IAM_CONTRACT_ADMIN_EMAIL`/`_PASSWORD` are set).

## Changes made to the shared services

Made through the IAM's admin API with the local bootstrap super-admin, with
your approval. No source code in those repositories was changed.

| When (UTC)        | Change                                                                                                       | Previous state        | How to revert                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------ | --------------------- | --------------------------------------------------------------------- |
| 2026-11-14 ~10:52 | Created tenant `dealmind` ("DealMind"), not default                                                          | did not exist         | `DELETE /api/v1/iam/tenants/<id>` (admin)                             |
| 2026-11-14 ~10:52 | `auth.registration.enabled` → `true` (**platform-wide**: every EasyDev product now allows self-registration) | `false` (invite-only) | `PUT /api/v1/iam/settings/auth.registration.enabled {"value": false}` |
| 2026-11-14        | Throwaway accounts at `@example.com` created to observe the contract                                         | n/a                   | Removed afterwards (see "Test accounts")                              |

Copied into DealMind's git-ignored `.env` (never printed or committed): the
notification service's shared `API_KEY` (as `NOTIFICATION_API_KEY`) and the
file service's `GATEWAY_INTERNAL_SECRET` (as `FILE_SERVICE_HMAC_SECRET`).

**Not done, by decision:**

- New users are **not** added to the `dealmind` tenant. The IAM puts every
  self-registered user in its default tenant (`TENANT=easydev`) and ignores
  `x-tenant-id` at registration. Adding them to `dealmind` would need DealMind
  to hold a credential with `tenant:user_add`, which (see issue 2) could grant
  any role in any tenant. DealMind therefore sends `x-tenant-id: easydev`.
  The `dealmind` tenant exists for future use.
- No DealMind application/client was registered in the IAM: DealMind needs no
  SSO launch or machine-to-machine token yet.

## IAM issues found (reported, not fixed: no source changes were authorised)

| #   | Issue                                                                                                        | Impact                                                                                                                 | Effect on DealMind                                                                                                   |
| --- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 1   | `POST /auth/login` returns the user's `passwordHash` and `twoFactorSecret`                                   | Every IAM client receives password hashes                                                                              | None: `IamClient` picks only the fields it needs, and response schemas strip unknown fields (both verified by tests) |
| 2   | `POST /tenants/:id/users` checks `tenant:user_add` but not the caller's own tenant, and accepts any `roleId` | Any holder can add anyone to any tenant with any role (privilege escalation)                                           | DealMind holds no such credential (membership step skipped)                                                          |
| 3   | Verification/reset email links use one global `FRONTEND_URL` (`http://localhost:3000`)                       | All products' users get links to the same frontend                                                                     | **DealMind users' emails link to EasyDev's frontend, not DealMind.** Open issue (see below)                          |
| 4   | Refresh-reuse detection marks the session inactive in the DB but does not clear its Redis cache              | After detected theft, the rotated **access** token keeps working for up to 15 min                                      | Limited: DealMind revalidates by refreshing, which does fail                                                         |
| 5   | Refresh tokens have second-resolution `iat` and no `jti`                                                     | Two refreshes within one second yield identical tokens, so rotation and reuse detection don't apply inside that window | None: DealMind never refreshes concurrently                                                                          |
| 6   | JWKS served inside the response envelope instead of a standard JWK Set                                       | Standard JWKS clients (e.g. jose `createRemoteJWKSet`) can't consume it                                                | Handled by DealMind's own JWKS fetcher                                                                               |
| 7   | Self-registration ignores `x-tenant-id` (always the env default tenant)                                      | Products can't have their own self-service tenant                                                                      | Users live in `easydev`                                                                                              |
| 8   | The IAM takes the client IP from the first `X-Forwarded-For` entry without a trusted-proxy check             | Callers can spoof IPs to the IAM's throttler                                                                           | DealMind forwards the real client IP; it can't stop others spoofing                                                  |

Recommended IAM fixes, in priority order: strip secrets from all user
payloads (1); scope tenant membership changes to the caller's tenant and
role level (2); clear the session cache on reuse revocation (4); per-tenant
`frontendUrl` and self-registration (3, 7); add `jti` to refresh tokens (5);
serve a bare JWK Set (6); trusted-proxy handling (8).

### Open issue: email links point to the wrong app

Until issue 3 is fixed in the IAM (or `FRONTEND_URL` is changed, which would
affect every product), DealMind's verification and reset emails link to
`http://localhost:3000/verify-email?token=…` and `/reset-password?token=…`.
The **paths** match DealMind's pages, so serving DealMind's web app at the
IAM's `FRONTEND_URL` would make them work. The links themselves can't be
changed from DealMind.

## Test accounts

Contract and probe runs create `dealmind-*@example.com` users (example.com is
a reserved domain that never receives mail). The contract suite deletes its
user when `IAM_CONTRACT_ADMIN_EMAIL`/`_PASSWORD` are set. After this work every
such account was deleted, and a scan of the IAM user list confirmed **0
remaining** (2026-11-14).

Gotcha: in `GET /users` list items, `id` is **not** the user UUID. Use
`internalId` for `GET`/`DELETE /users/:id`.
