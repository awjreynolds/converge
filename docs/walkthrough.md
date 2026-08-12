# Revoked-session walkthrough

This walkthrough proves the first complete Converge interaction against a deterministic local repository.

## Prepare the target

Copy `fixtures/revoked-session` to a temporary directory and install dependencies from this workspace, or open the fixture directly when you do not need to preserve its red baseline.

Confirm the starting suite:

```bash
npm test --workspace @converge/fixture-revoked-session
```

The happy-path test must pass. There is deliberately no revoked-session test yet; creating it and observing its expected failure is the first Change Unit.

## Run the Pairing Session

1. Launch Converge in an Extension Development Host or install the generated VSIX.
2. Open the copied fixture as a trusted, single-folder workspace.
3. Select Codex, Claude, or Pi as the provider. When using Pi, install the supported Pi CLI,
   authenticate and select a model in Pi, and let Converge load only its packaged approval gate.
4. Run **Converge: Start Pairing Session** and provide `task.md` as the specification.
5. Inspect the agent's investigation progress and first proposed Change Unit.
6. Discuss the proposed behaviour if its rationale is unclear.
7. Redirect any proposal that bypasses `SessionLookup`; require the existing persistence seam to remain intact.
8. Approve the revised Change Unit, then choose **Apply approved change**. Treat any provider command or file approval as a separate execution decision.
9. Inspect the resulting files with **View Diff** in VS Code.
10. Choose **Run verification**. A test-only Change Unit may report **expected failure**; the implementation Change Unit must pass.
11. Choose **Next Change Unit** after each verified or rejected unit. The selected provider either proposes the next meaningful decision or, once every requirement is verified, presents the final system model and Understanding Check.

## Expected result

The session may be marked Converged only when:

- revoked sessions cannot refresh;
- revocation is enforced by `SessionService`;
- persistence remains behind `SessionLookup`;
- no public interface changes;
- the behavioural test passes;
- the engineer's answer matches the implemented system.

Normal Pull Request review begins after this point.
