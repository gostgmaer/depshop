# Web push notifications

**What it does:** browser/phone push for price drops and finished searches, for users who
install or allow notifications from the web app. Optional; e-mail and in-app work without it.

**What we use:** standard Web Push with **VAPID** keys (no third-party account needed). The
worker sends pushes directly to the browsers' push services.

## Settings

| Variable            | Services    | Value                                                  |
| ------------------- | ----------- | ------------------------------------------------------ |
| `VAPID_PUBLIC_KEY`  | api, worker | Public key (the browser receives it)                   |
| `VAPID_PRIVATE_KEY` | worker      | **Private** key; secret                                |
| `VAPID_SUBJECT`     | worker      | `mailto:ops@<your-domain>` (contact for push services) |

## Turn it on

1. Generate the key pair **once** per environment:
   ```
   pnpm notifications:vapid
   ```
2. Put the three values in `.env` / `.env.production`.
3. Recreate api and worker.
4. **Verify:** in the app (HTTPS, or `localhost`), Settings → notifications → enable push,
   accept the browser prompt, then trigger a test notification (e.g. a search finishing) and
   confirm it arrives. Admin → Jobs shows no failed push jobs.

## Important

- **Don't rotate casually:** a new key pair invalidates every existing push subscription;
  users must enable push again.
- Staging and production need **different** key pairs.
- Guests never receive push.

More: [`../web-push-notifications.md`](../web-push-notifications.md).
