/** Prints a new VAPID key pair for .env (`pnpm notifications:vapid`). Never commit the private key. */
import { generateVapidKeys } from "../channels/push.js";

const { publicKey, privateKey } = generateVapidKeys();
process.stdout.write(
  `VAPID_PUBLIC_KEY=${publicKey}\nVAPID_PRIVATE_KEY=${privateKey}\nVAPID_SUBJECT=mailto:you@example.com\n`,
);
