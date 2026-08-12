# `@converge/codex`

The Codex adapter implements Converge's `AgentPort` using `codex app-server` over
stdio JSONL. It starts the executable directly without a shell, initializes the
JSON-RPC connection, starts or resumes a Converge-owned Codex thread, and runs one
structured turn for each Converge phase.

```ts
import { CodexAppServerAdapter } from "@converge/codex";

const adapter = new CodexAppServerAdapter({
  executablePath: "/absolute/path/to/codex",
});
```

The default executable is `codex` from `PATH`. The adapter currently requires
`codex-cli 0.147.0-alpha.6.5`, the version against which its stable protocol subset
was generated and tested. A caller may explicitly select another pinned version
with `supportedCliVersion` while validating an updated app-server protocol.

Persist every emitted `thread-started` ID in the `PairingSession.codexThreadId`
field before the next phase. Command and file permission requests are emitted as
`execution-approval-requested`; answer them independently of Converge design
approval with `respondToExecutionApproval`. Call `cancel()` to interrupt an active
turn, and `dispose()` when the owning extension is deactivated.

## Initial limits

- Threads must be created and exclusively driven by Converge. The adapter does not
  attach to a turn that is active in another Codex process.
- Each Converge phase is one completed structured turn. Live steering and dynamic
  tools are intentionally excluded.
- Network access is disabled by the adapter's read-only and workspace-write
  sandbox policies. Codex execution approvals remain separate human decisions.
- Connection-scoped notifications have no replay cursor. Resume a persisted thread
  after process failure and reconcile it with Converge's own durable event log.
