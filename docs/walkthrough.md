# Revoked-session walkthrough

This walkthrough proves the first complete Converge interaction against a deterministic local repository.

## Prepare the target

Copy `fixtures/revoked-session` to a temporary directory and install dependencies from this workspace, or open the fixture directly when you do not need to preserve its red baseline.

Confirm the starting behaviour:

```bash
npm test --workspace @converge/fixture-revoked-session
```

The test must fail because `SessionService.refresh()` returns `new-token` for a revoked session.

## Run the Pairing Session

1. Launch Converge in an Extension Development Host or install the generated VSIX.
2. Open the copied fixture as a trusted, single-folder workspace.
3. Run **Converge: Start Pairing Session** and provide `task.md` as the specification.
4. Inspect the agent's investigation progress and first proposed Change Unit.
5. Discuss the proposed behaviour if its rationale is unclear.
6. Redirect any proposal that bypasses `SessionLookup`; require the existing persistence seam to remain intact.
7. Approve the revised Change Unit, then choose **Apply approved change**. Treat any Codex command or file approval as a separate execution decision.
8. Inspect the resulting files with **View Diff** in VS Code.
9. Choose **Run verification**. A test-only Change Unit may report **expected failure**; the implementation Change Unit must pass.
10. Choose **Next Change Unit** after each verified or rejected unit. Codex either proposes the next meaningful decision or, once every requirement is verified, presents the final system model and Understanding Check.

## Expected result

The session may be marked Converged only when:

- revoked sessions cannot refresh;
- revocation is enforced by `SessionService`;
- persistence remains behind `SessionLookup`;
- no public interface changes;
- the behavioural test passes;
- the engineer's answer matches the implemented system.

Normal Pull Request review begins after this point.
