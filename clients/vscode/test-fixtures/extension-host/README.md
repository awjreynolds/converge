# Extension Host fixture

This intentionally minimal local workspace selects Claude and sets `converge.codexPath` to a
missing executable. The Extension Host suite proves production provider selection at activation;
its behavioral checks use inert agents and never contact an external service.
