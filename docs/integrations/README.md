# Integrations: setup guides

One guide per external service DealMind depends on. Each answers the same questions:
**what it does · what we use today · where the credentials come from · where they go ·
how to check it works · how to switch it off**. Variable details (required, rotation)
are in [`../SECRETS.md`](../SECRETS.md).

| Integration                                | Guide                                                    | Needed to run?                       | Status on the local stack                             |
| ------------------------------------------ | -------------------------------------------------------- | ------------------------------------ | ----------------------------------------------------- |
| AI model (search understanding, summaries) | [ai-models.md](ai-models.md)                             | Production: yes. Local: no (`rules`) | `rules` / `keyword-rules-v1` (no AI calls)            |
| Sign-in (shared EasyDev IAM)               | [identity-iam.md](identity-iam.md)                       | Yes                                  | Connected (host port 3304)                            |
| E-mail (shared notification service)       | [email-notifications.md](email-notifications.md)         | For launch                           | Connected (host port 4004)                            |
| Web push                                   | [web-push.md](web-push.md)                               | No                                   | Off unless VAPID keys are set                         |
| Payments (shared payment service)          | [payments.md](payments.md)                               | No (free launch)                     | Off: `LAUNCH_FREE_PLAN=PRO`, sandbox billing          |
| Marketplaces and affiliate programs        | [marketplaces-affiliates.md](marketplaces-affiliates.md) | No                                   | Not connected; mock stores only (labelled)            |
| File uploads (shared file service)         | [file-uploads.md](file-uploads.md)                       | No (no feature uses it yet)          | Not configured (`files: fail` in readiness, optional) |

## Where to look first

- **Admin → System health** (`/admin/system`): one row per integration (IAM, IAM signing
  keys, notifications, files, payments, connectors) with its current state.
- **`GET /health/ready`** on the API: required checks (`database`, `redis`, `iam`, `iamJwks`)
  and optional ones (`notifications`, `files`). Required failures make the API not ready.
  ```
  curl -s http://127.0.0.1:4000/health/ready
  ```
- **Container logs:** each service logs which provider it started with, never the secret.

## The rule for every integration

1. Credentials go in the environment (`.env` locally, `.env.production` on the server),
   never in the database, the admin console, a ticket or chat.
2. Recreate only the containers that read the variable (each guide says which).
3. Verify with the guide's check before announcing it as working.
