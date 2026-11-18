# Web push notifications

Web Push with VAPID, part of the existing notification system ([NOTIFICATIONS.md](NOTIFICATIONS.md)). Push is one of three channels; in-app and e-mail work without it.

## Lifecycle

| Step                     | Implementation                                                                                                                                                                                                 | Status                                                                                        |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Explain, then ask        | Settings → Notifications → "Turn on for this browser". `Notification.requestPermission()` runs **only** from that click, never on page load (`lib/push.ts`)                                                    | Implemented earlier; unit-tested                                                              |
| Subscribe and store      | Browser subscription → `POST /api/v1/push/subscribe` (removal: `DELETE /api/v1/push/subscribe`), owned by the user; at most 10 browsers per user                                                               | Implemented, DB-tested                                                                        |
| Renewal and replacement  | Subscribing again with the same endpoint updates it (upsert by endpoint); a different user subscribing on the same browser takes ownership                                                                     | Implemented                                                                                   |
| Removal                  | "Turn off for this browser": server revoke (owner-scoped; someone else's endpoint is 404), then browser unsubscribe                                                                                            | Implemented, tested                                                                           |
| **Sign-out**             | **New (Prompt 26):** sign-out turns push off on that browser _before_ the session ends, so a shared phone stops showing the previous user's alerts. A failure here never blocks sign-out. Settings explains it | Implemented; unit-tested (order, failure tolerance). Real push delivery not testable headless |
| Expired endpoints        | The push service answers 404/410 → the subscription is marked expired and no longer used                                                                                                                       | Implemented, tested                                                                           |
| Retries and duplicates   | Delivery jobs retry with backoff; the job id is the delivery id; one notification per event per user                                                                                                           | Implemented, tested                                                                           |
| Delivery tracking        | `NotificationDelivery` per channel (`SENT`/`FAILED`/`SKIPPED`), admin view and metrics                                                                                                                         | Implemented                                                                                   |
| Quiet hours, preferences | Per category (price alerts, search, account, billing) and per alert channel; consent re-checked at send time. Security notices aren't delayed by quiet hours                                                   | Implemented                                                                                   |

## Events that push

Target price reached and verified price drops (`PRICE_ALERTS`), searches finished or failed, account security (new sign-in, password changed), billing events. **No promotional push exists**; a marketing category would be separate and opt-in ([lifecycle-communications.md](lifecycle-communications.md)).

## Platform notes

See [browser-compatibility.md](browser-compatibility.md). Briefly:

- Chromium and Firefox support Web Push in the browser.
- **On iPhone and iPad, Web Push works only for a site added to the Home Screen** (iOS 16.4 or later) and only after the user allows it there.

Where push is unavailable, the Settings card says so, and in-app and e-mail continue.

## Not verified

Real delivery to a device. It needs VAPID keys, a deployed HTTPS origin and a real browser (BLOCKED).
