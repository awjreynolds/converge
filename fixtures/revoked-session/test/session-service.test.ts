import { describe, expect, it, vi } from "vitest";

import {
  SessionService,
  type SessionLookup,
  type TokenIssuer,
} from "../src/session-service.js";

describe("SessionService", () => {
  it("issues a refresh token for an active session", async () => {
    const sessions: SessionLookup = {
      find: vi.fn().mockResolvedValue({
        id: "session-1",
        expiresAt: new Date("2030-01-01T00:00:00.000Z"),
      }),
    };
    const tokens: TokenIssuer = {
      issue: vi.fn().mockResolvedValue("new-token"),
    };
    const service = new SessionService(
      sessions,
      tokens,
      () => new Date("2029-06-01T00:00:00.000Z"),
    );

    await expect(service.refresh("session-1")).resolves.toBe("new-token");
    expect(tokens.issue).toHaveBeenCalledWith("session-1");
  });
});
