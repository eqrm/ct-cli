import { randomBytes, timingSafeEqual } from "node:crypto";

export type SessionCapability = "read" | "plan" | "mutate" | "credentials";

export interface ApiSession {
  id: string;
  capabilities: ReadonlySet<SessionCapability>;
  expiresAt: Date;
}

const ALL_CAPABILITIES: readonly SessionCapability[] = ["read", "plan", "mutate", "credentials"];

function token(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export class SessionManager {
  readonly pairingCode: string;
  readonly pairingExpiresAt: Date;
  private pairingUsed = false;
  private readonly sessions = new Map<string, ApiSession>();

  constructor(
    private readonly now: () => Date = () => new Date(),
    pairingTtlMs = 5 * 60_000,
    private readonly sessionTtlMs = 8 * 60 * 60_000,
  ) {
    this.pairingCode = String(Number.parseInt(randomBytes(4).toString("hex"), 16) % 1_000_000).padStart(
      6,
      "0",
    );
    this.pairingExpiresAt = new Date(this.now().getTime() + pairingTtlMs);
  }

  pair(code: string, requested?: readonly string[]): { token: string; session: ApiSession } {
    const supplied = Buffer.from(code);
    const expected = Buffer.from(this.pairingCode);
    const matches = supplied.length === expected.length && timingSafeEqual(supplied, expected);
    if (this.pairingUsed || this.pairingExpiresAt.getTime() <= this.now().getTime() || !matches) {
      throw new Error("Invalid or expired pairing code.");
    }
    const capabilities = new Set<SessionCapability>(
      requested === undefined
        ? ALL_CAPABILITIES
        : requested.filter((value): value is SessionCapability =>
            ALL_CAPABILITIES.includes(value as SessionCapability),
          ),
    );
    if (capabilities.size === 0) throw new Error("Pairing requested no supported capabilities.");
    this.pairingUsed = true;
    const rawToken = token();
    const session: ApiSession = {
      id: token(12),
      capabilities,
      expiresAt: new Date(this.now().getTime() + this.sessionTtlMs),
    };
    this.sessions.set(rawToken, session);
    return { token: rawToken, session };
  }

  authenticate(rawToken: string | undefined): ApiSession | null {
    if (!rawToken) return null;
    const session = this.sessions.get(rawToken);
    if (!session) return null;
    if (session.expiresAt.getTime() <= this.now().getTime()) {
      this.sessions.delete(rawToken);
      return null;
    }
    return session;
  }
}

export class RateLimiter {
  private readonly buckets = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly limit = 120,
    private readonly windowMs = 60_000,
  ) {}

  allow(key: string, now = Date.now()): boolean {
    const bucket = this.buckets.get(key);
    if (!bucket || now - bucket.start >= this.windowMs) {
      this.buckets.set(key, { start: now, count: 1 });
      return true;
    }
    bucket.count += 1;
    return bucket.count <= this.limit;
  }
}
