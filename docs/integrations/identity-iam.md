# Sign-in: shared EasyDev IAM

**What it does:** sign-up, sign-in, e-mail verification, password reset. DealMind has no
password store of its own: the API calls the IAM and keeps the IAM tokens encrypted on the
server. The browser only ever gets DealMind's own HttpOnly session cookie.

**What we use:** the shared `auth-service` (repo `multi-tannet-auth-services`).

| Where              | IAM URL                                                                  |
| ------------------ | ------------------------------------------------------------------------ |
| Local (host)       | `http://127.0.0.1:3304/api/v1/iam`                                       |
| Local Docker stack | `http://host.docker.internal:3304/api/v1/iam` (set by the local compose) |
| Production         | `https://<iam-host>/api/v1/iam` from the platform team                   |

## Settings (api only)

| Variable                                 | Value                                                                                     |
| ---------------------------------------- | ----------------------------------------------------------------------------------------- |
| `IAM_BASE_URL`                           | Required. The URL above                                                                   |
| `IAM_TENANT`                             | `easydev`: the IAM's own tenant header. DealMind itself has no tenants                    |
| `IAM_JWT_ISSUER` / `IAM_JWT_AUDIENCE`    | `iam-service` / `easydev` (must match the IAM's tokens)                                   |
| `IAM_JWKS_URL`                           | Only if the IAM's public keys aren't at the default path                                  |
| `IAM_TIMEOUT_MS`                         | Default 8000                                                                              |
| `SESSION_SECRET`, `TOKEN_ENCRYPTION_KEY` | DealMind's own session secrets (see `../SECRETS.md`); rotating the key signs everyone out |

No IAM secret is needed: DealMind verifies the IAM's tokens with its public keys (JWKS).

## Check it works

```
curl -s http://127.0.0.1:4000/health/ready     # "iam":"ok","iamJwks":"ok"
```

Admin → System health shows **Shared EasyDev IAM** and **IAM signing keys**. If either fails,
the API reports not-ready and sign-in returns an error; nobody can sign in.

Then sign up a test account at `/register`, verify it, and sign in.

## The first administrator

Accounts start as normal users. The first admin is created once at `/setup` with a one-time
token from the API log; see [`../ADMIN.md`](../ADMIN.md).

## Common problems

- **"Invalid email or password" for an account you just created:** the e-mail may already
  have existed in the shared IAM (used by other EasyDev apps); its old password applies.
- **IAM down:** sign-in fails, already signed-in users keep working until their session
  needs a token refresh.

More: [`../AUTH.md`](../AUTH.md), [`../SHARED_SERVICES.md`](../SHARED_SERVICES.md).
