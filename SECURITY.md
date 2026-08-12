# Security policy

Converge is an early local-only implementation. Please do not open public issues for vulnerabilities that could expose workspace contents, credentials, or command execution.

Report security issues privately through [GitHub's private vulnerability reporting](https://github.com/awjreynolds/converge/security/advisories/new). Include the affected version or commit, reproduction steps, impact, and any suggested mitigation.

The current supported surface is the latest commit on `main`. Design approval inside Converge never grants execution permission: filesystem, command, and network approvals remain separate user decisions.
