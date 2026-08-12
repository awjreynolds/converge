# Third-party notices

Converge's own source code is licensed under the MIT License. The optional provider
integrations depend on software distributed under separate terms.

## Anthropic Claude Agent SDK

The `claude` provider uses `@anthropic-ai/claude-agent-sdk` version `0.3.228`.
The SDK and its platform packages are governed by Anthropic's applicable terms,
including the Anthropic Commercial Terms; they are not relicensed under Converge's
MIT License. See the license and terms files distributed with those packages and
Anthropic's current legal documentation before enabling this provider.

Converge does not broker Claude consumer-subscription login. The integration uses
provider-owned API-key or supported cloud authentication and stores no credentials.

## Pi coding agent

The `pi` provider interoperates with the user-installed Pi CLI version `0.84.1`,
which is licensed under the MIT License. Pi and its dependencies are external
runtime prerequisites and are not bundled into Converge or its VSIX. Converge
uses Pi's provider-owned model selection, authentication, and session storage.

Source and license: https://github.com/earendil-works/pi
