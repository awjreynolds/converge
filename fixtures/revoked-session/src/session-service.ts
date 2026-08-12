export interface Session {
  id: string;
  expiresAt: Date;
  revokedAt?: Date;
}

export interface SessionLookup {
  find(sessionId: string): Promise<Session | undefined>;
}

export interface TokenIssuer {
  issue(sessionId: string): Promise<string>;
}

export class UnauthorizedError extends Error {
  constructor() {
    super("Session is not authorized to refresh");
    this.name = "UnauthorizedError";
  }
}

export class SessionService {
  constructor(
    private readonly sessions: SessionLookup,
    private readonly tokens: TokenIssuer,
    private readonly now: () => Date,
  ) {}

  async refresh(sessionId: string): Promise<string> {
    const session = await this.sessions.find(sessionId);

    if (!session || session.expiresAt <= this.now()) {
      throw new UnauthorizedError();
    }

    return this.tokens.issue(session.id);
  }
}
