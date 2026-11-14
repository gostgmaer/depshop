import { hash, verify } from "@node-rs/argon2";

/**
 * Argon2id with OWASP-recommended parameters (19 MiB, t=2, p=1).
 * `algorithm: 2` is `Algorithm.Argon2id`; the library exports Algorithm as a
 * `const enum`, which cannot be imported under `isolatedModules`.
 * password.test.ts asserts the produced hash really is `$argon2id$`.
 */
const OPTIONS = { algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

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
 * Spends comparable CPU time when a login targets an unknown email, so
 * response timing does not reveal which emails are registered.
 */
export async function verifyAgainstDummy(password: string): Promise<void> {
  dummyHash ??= hashPassword("dummy-password-for-timing-1");
  await verifyPassword(await dummyHash, password);
}
