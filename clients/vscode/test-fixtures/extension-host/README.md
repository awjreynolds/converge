# Extension Host fixture

This intentionally minimal local workspace selects Claude and configures deliberately missing
Codex and Claude executables. The Extension Host suite proves production provider selection at
activation and confirms that provider validation happens before session persistence. It supplies a
placeholder API key only to reach the local executable check; it never contacts an external service.
