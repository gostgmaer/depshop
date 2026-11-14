import { hash, verify } from "@node-rs/argon2";

// OWASP-recommended Argon2id parameters (algorithm defaults to Argon2id).
const OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | undefined;

/**
 * Burns comparable CPU time when a login targets an unknown email, so response
 * timing does not reveal which emails are registered.
 */
export async function verifyAgainstDummy(password: string): Promise<void> {
  dummyHash ??= hashPassword("dummy-password-for-timing-1");
  await verifyPassword(await dummyHash, password);
}
