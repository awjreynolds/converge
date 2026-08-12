# Contributing

Converge is deliberately focused on implementation comprehension. Before proposing a feature, check that it strengthens the path from engineering intent to understood, verified code without replacing coding agents, editors, language servers, specification systems, or Pull Request review.

## Set up

```bash
npm ci
npm run verify
```

Use Node.js 22 or newer. Keep the core independent of VS Code and Codex-specific chat formats.

`npm run verify` includes the approved dependency-license policy. Run `npm run audit` before changing dependencies; CI rejects moderate-or-higher advisories.

The policy distinguishes distributable open-source dependencies from reviewed build-only tools. The official VSIX packager's platform signer binaries have a restrictive Microsoft tool license, are pinned explicitly, and must never be bundled into Converge runtime artifacts.

An opt-in provider adapter may depend on an exact-pinned runtime under separate terms only when the provider cannot satisfy the approved safety contract through an open-source SDK. Such an exception requires a documented selection decision, an exact package-and-version license check, a third-party notice in distributed artifacts, provider-owned credentials, and a clear UI limitation. It does not change the MIT license on Converge's own source.

## Tests

Tests belong at public seams:

- Pairing Session behavior through the core interface;
- provider behavior through `AgentPort` with a fake transport;
- external wire/SDK conformance through a public provider-package transport seam when that behavior is not observable from normalized events alone;
- panel rendering and actions through plain JSON snapshots;
- host behavior through injected VS Code capabilities;
- the complete workflow through the revoked-session fixture.

Prefer one behavioral test and the smallest implementation that passes it. Do not test private helpers or mock internal collaborators; an injectable, exported provider transport is a supported boundary rather than a private collaborator.

## Pull requests

Keep changes small enough to understand. Explain the engineering decision, rationale, behavioral impact, risks, and verification. Converge does not replace normal review, CI, security checks, or repository governance.
