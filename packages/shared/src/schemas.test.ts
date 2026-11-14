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
      password: "abcdefghi1",
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

  it("rejects client-supplied identity or privilege fields", () => {
    const sneaky = { email: "a@b.co", password: "abcdefghi1", name: "A", role: "ADMIN" };
    expect(registerInput.safeParse(sneaky).success).toBe(false);
    expect(updateProfileInput.safeParse({ name: "A", userId: "x" }).success).toBe(false);
    expect(updatePreferencesInput.safeParse({ notifyEmail: false, userId: "x" }).success).toBe(
      false,
    );
  });

  it("requires a different new password and at least one preference", () => {
    expect(
      changePasswordInput.safeParse({ currentPassword: "abcdefghi1", newPassword: "abcdefghi1" })
        .success,
    ).toBe(false);
    expect(updatePreferencesInput.safeParse({}).success).toBe(false);
  });
});
