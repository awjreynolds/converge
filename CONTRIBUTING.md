# Contributing

Converge is deliberately focused on implementation comprehension. Before proposing a feature, check that it strengthens the path from engineering intent to understood, verified code without replacing coding agents, editors, language servers, specification systems, or Pull Request review.

## Set up

```bash
npm ci
npm run verify
```

Use Node.js 20 or newer. Keep the core independent of VS Code and Codex-specific chat formats.

## Tests

Tests belong at public seams:

- Pairing Session behavior through the core interface;
- provider behavior through `AgentPort` with a fake transport;
- panel rendering and actions through plain JSON snapshots;
- host behavior through injected VS Code capabilities;
- the complete workflow through the revoked-session fixture.

Prefer one behavioral test and the smallest implementation that passes it. Do not test private helpers or mock internal collaborators.

## Pull requests

Keep changes small enough to understand. Explain the engineering decision, rationale, behavioral impact, risks, and verification. Converge does not replace normal review, CI, security checks, or repository governance.
