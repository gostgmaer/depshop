import { describe, expect, it } from "vitest";
import { AppError, ErrorCode } from "./errors.js";

describe("AppError", () => {
  it("maps codes to HTTP status", () => {
    expect(AppError.notFound("Watchlist").statusCode).toBe(404);
    expect(AppError.unauthenticated().statusCode).toBe(401);
    expect(new AppError(ErrorCode.USAGE_LIMIT_EXCEEDED, "x").statusCode).toBe(429);
  });
});
