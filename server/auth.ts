import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { env } from './env.js';
import { HttpError } from './http.js';

const JWKS_URL =
  'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

export interface AuthUser {
  uid: string;
  email: string | null;
  emailVerified: boolean;
  /** sign-in method of this session: 'password', 'google.com', 'apple.com', ... */
  provider: string;
  /** set by the server (custom claim) once the account's phone number is verified */
  phoneVerified: boolean;
  /** custom claim set by the server for the Super Admin (used by the Firestore rules) */
  superAdminClaim?: boolean;
  /** when this sign-in session started (seconds since epoch) */
  authTime: number;
  /** raw Firebase ID token; forwarded to Firestore REST so security rules apply */
  token: string;
  /** display name and photo from the sign-in provider, when present */
  name?: string | null;
  picture?: string | null;
}

type Verifier = (token: string) => Promise<JWTPayload>;
let verifierOverride: Verifier | null = null;
/** test hook */
export function setTokenVerifier(v: Verifier | null) {
  verifierOverride = v;
}

async function verify(token: string): Promise<JWTPayload> {
  if (verifierOverride) return verifierOverride(token);
  const { projectId } = env();
  if (!projectId) throw new HttpError(500, 'config', 'FIREBASE_PROJECT_ID is not configured.');
  jwks ??= createRemoteJWKSet(new URL(JWKS_URL));
  const { payload } = await jwtVerify(token, jwks, {
    issuer: `https://securetoken.google.com/${projectId}`,
    audience: projectId,
    algorithms: ['RS256'],
  });
  return payload;
}

/** Email/password accounts must verify a phone number; Google and Apple sign-ins do not. */
export function needsPhone(user: Pick<AuthUser, 'provider' | 'phoneVerified'>): boolean {
  return user.provider === 'password' && !user.phoneVerified;
}

/** Verifies the Firebase ID token in the Authorization header. */
export async function requireUser(request: Request): Promise<AuthUser> {
  const header = request.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) throw new HttpError(401, 'unauthenticated', 'Sign in required.');
  let payload: JWTPayload;
  try {
    payload = await verify(match[1]);
  } catch {
    throw new HttpError(401, 'invalid_token', 'Your session has expired. Please sign in again.');
  }
  if (!payload.sub) throw new HttpError(401, 'invalid_token', 'Invalid token.');
  // The server's own identity is never a user of the app.
  if (payload.atlasServer === true || payload.sub === 'atlas-server') throw new HttpError(403, 'forbidden', 'Not allowed.');
  return {
    uid: payload.sub,
    email: typeof payload.email === 'string' ? payload.email.toLowerCase() : null,
    emailVerified: payload.email_verified === true,
    provider: String((payload.firebase as { sign_in_provider?: string } | undefined)?.sign_in_provider ?? ''),
    phoneVerified: payload.phoneVerified === true,
    superAdminClaim: payload.superAdmin === true,
    authTime: typeof payload.auth_time === 'number' ? payload.auth_time : Number(payload.iat ?? 0),
    token: match[1],
    name: typeof payload.name === 'string' ? payload.name.slice(0, 100) : null,
    picture: typeof payload.picture === 'string' ? payload.picture.slice(0, 500) : null,
  };
}
