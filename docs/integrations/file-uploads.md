# File uploads: shared file service

**What it does:** the connection to the shared EasyDev `file-upload-service` is built and
health-checked, but **no DealMind feature uploads files yet**. Configure it only when a
feature that needs it ships. DealMind runs fully without it.

**What we use today:** not configured. Readiness shows `"optional":{"files":"fail"}`; that's
expected and doesn't block the API.

| Where        | URL                                                                            |
| ------------ | ------------------------------------------------------------------------------ |
| Local (host) | `http://127.0.0.1:4005` (port 4001 is another project's service, not this one) |
| Production   | From the platform team                                                         |

## Settings (api only)

| Variable                   | Value                                              |
| -------------------------- | -------------------------------------------------- |
| `FILE_SERVICE_URL`         | The URL above                                      |
| `FILE_SERVICE_HMAC_SECRET` | Shared HMAC secret issued by the file-service team |
| `FILE_SERVICE_TENANT_ID`   | `dealmind` (the service's own header)              |

## Turn it on

1. Get the URL and HMAC secret from the file-service team.
2. Put them in `.env` / `.env.production`; recreate the api.
3. **Verify:** `curl -s http://127.0.0.1:4000/health/ready` → `"files":"ok"`, and Admin →
   System health → **Shared file-upload service** is OK.

## Turn it off

Empty `FILE_SERVICE_URL` and recreate the api.

More: [`../SHARED_SERVICES.md`](../SHARED_SERVICES.md).
