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
  /** raw Firebase ID token; forwarded to Firestore REST so security rules apply */
  token: string;
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
  return {
    uid: payload.sub,
    email: typeof payload.email === 'string' ? payload.email.toLowerCase() : null,
    emailVerified: payload.email_verified === true,
    token: match[1],
  };
}
