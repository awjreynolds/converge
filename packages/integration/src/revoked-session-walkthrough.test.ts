import { describe, expect, it } from "vitest";

import {
  formatWalkthrough,
  runRevokedSessionWalkthrough,
} from "./revoked-session-walkthrough.js";

describe("revoked-session fake-agent walkthrough", () => {
  it("takes the real fixture from a failing regression test to shared understanding", async () => {
    const result = await runRevokedSessionWalkthrough();

    expect(result.session.status).toBe("converged");
    expect(result.session.changes.map((change) => ({
      title: change.revisions.at(-1)?.title,
      status: change.status,
      verification: change.verificationTests.map((test) => test.outcome),
    }))).toEqual([
      {
        title: "Specify revoked-session behavior",
        status: "verified",
        verification: ["expected-failure"],
      },
      {
        title: "Enforce revocation before token issuance",
        status: "verified",
        verification: ["passed"],
      },
    ]);
    expect(result.testRuns.map((run) => ({ outcome: run.outcome, exitCode: run.exitCode }))).toEqual([
      { outcome: "expected-failure", exitCode: 1 },
      { outcome: "passed", exitCode: 0 },
    ]);
    expect(result.session.finalSummary).toContain("SessionService.refresh");
    expect(result.session.finalSummary).toContain("public interface is unchanged");
    expect(result.session.understandingCheck).toMatchObject({
      assessment: "aligned",
      answer: "SessionService.refresh rejects a revoked session before TokenIssuer is called.",
    });
    expect(result.sourceFixtureUnchanged).toBe(true);
    expect(result.temporaryWorkspaceRemoved).toBe(true);
    expect(formatWalkthrough(result)).toContain([
      "1. Investigated the revoked-session task.",
      "2. Verified the regression test fails for the missing behavior (expected red).",
      "3. Verified the implementation with the fixture's real test suite (green).",
      "4. Completed the Understanding Check and converged.",
    ].join("\n"));
  });
});
