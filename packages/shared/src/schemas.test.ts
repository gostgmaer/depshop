import { describe, expect, it } from "vitest";
import {
  changePasswordInput,
  registerInput,
  updatePreferencesInput,
  updateProfileInput,
} from "./schemas.js";

describe("auth schemas", () => {
  it("normalises email and enforces the password policy", () => {
    const ok = registerInput.parse({
      email: " Asha@Example.COM ",
      password: "Abcdefgh1!x",
      name: "Asha",
    });
    expect(ok.email).toBe("asha@example.com");
    expect(
      registerInput.safeParse({ email: "a@b.co", password: "short1", name: "A" }).success,
    ).toBe(false);
    expect(
      registerInput.safeParse({ email: "a@b.co", password: "noDigitsHere", name: "A" }).success,
    ).toBe(false);
  });

  it("matches the shared IAM password policy", () => {
    const ok = (password: string) =>
      registerInput.safeParse({ email: "a@b.co", password, name: "A" }).success;
    expect(ok("Correct-horse-42!")).toBe(true);
    expect(ok("correct-horse-42!")).toBe(false); // no uppercase
    expect(ok("CORRECT-HORSE-42!")).toBe(false); // no lowercase
    expect(ok("Correct-horse-xx!")).toBe(false); // no digit
    expect(ok("Correct-horse-42-")).toBe(false); // "-" is not in the IAM special set
  });

  it("rejects client-supplied identity or privilege fields", () => {
    const sneaky = { email: "a@b.co", password: "Abcdefgh1!x", name: "A", role: "ADMIN" };
    expect(registerInput.safeParse(sneaky).success).toBe(false);
    expect(updateProfileInput.safeParse({ name: "A", userId: "x" }).success).toBe(false);
    expect(updatePreferencesInput.safeParse({ notifyEmail: false, userId: "x" }).success).toBe(
      false,
    );
  });

  it("requires a different new password and at least one preference", () => {
    expect(
      changePasswordInput.safeParse({ currentPassword: "Abcdefgh1!x", newPassword: "Abcdefgh1!x" })
        .success,
    ).toBe(false);
    expect(updatePreferencesInput.safeParse({}).success).toBe(false);
  });
});
