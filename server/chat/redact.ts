/**
 * Last line of defence on model output: anything that looks like a credential
 * is replaced before it reaches the browser or Firestore. The model is never
 * given a secret (see securityPolicy in prompt.ts), so this only matters if a
 * value leaks some other way, or a model makes one up that happens to be real.
 *
 * Two checks: the exact values of the server's own secrets (environment
 * variables whose names mark them as secret), and the well-known shapes of API
 * keys and private keys. Applied to the answer and the reasoning, streamed
 * chunk by chunk without splitting a value across chunks.
 */

export const REDACTED = '[redacted]';

const SHAPES: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API keys
  /\bAQ\.[0-9A-Za-z_-]{40,}/g, // Google auth keys (newer AI Studio format)
  /\bcfut_[0-9A-Za-z]{30,}\b/g, // Cloudflare user API tokens
  /\bsk-or-v1-[0-9a-f]{32,}\b/g, // OpenRouter
  /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{32,}\b/g, // OpenAI-style and Anthropic keys
  /\btvly-(?:dev-|prod-)?[A-Za-z0-9_-]{20,}\b/g, // Tavily
  /\bxkeysib-[0-9a-f]{40,}-[A-Za-z0-9]{8,}\b/g, // Brevo
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, // GitHub tokens
  /\bxox[abprs]-[A-Za-z0-9-]{20,}\b/g, // Slack tokens
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key ids
];

const SECRET_NAME = /(KEY|SECRET|TOKEN|PASSWORD|PASS|PRIVATE|CREDENTIAL|SERVICE_ACCOUNT)/i;

/** Values of the server's secret environment variables (and the pieces of a service account JSON). */
export function knownSecrets(envVars: Record<string, string | undefined> = process.env): string[] {
  const out = new Set<string>();
  for (const [name, raw] of Object.entries(envVars)) {
    // VITE_ variables are public by design (bundled into the web app)
    if (!raw || name.startsWith('VITE_') || !SECRET_NAME.test(name)) continue;
    const v = raw.trim();
    if (v.length >= 12) out.add(v);
    // service account JSON (raw or base64): its private key id and key lines
    let json = v;
    if (!v.startsWith('{')) {
      try {
        json = Buffer.from(v, 'base64').toString('utf8');
      } catch {
        json = '';
      }
    }
    if (json.startsWith('{')) {
      try {
        const sa = JSON.parse(json) as Record<string, unknown>;
        if (typeof sa.private_key_id === 'string' && sa.private_key_id.length >= 12) out.add(sa.private_key_id);
        if (typeof sa.private_key === 'string')
          for (const line of sa.private_key.split(/\\n|\n/)) if (line.length >= 40 && !line.startsWith('-----')) out.add(line.trim());
      } catch {
        // not JSON
      }
    }
  }
  // longest first, so a value containing another is replaced whole
  return [...out].sort((a, b) => b.length - a.length);
}

let cached: string[] | null = null;
function secrets(): string[] {
  return (cached ??= knownSecrets());
}
/** for tests */
export function setKnownSecrets(v: string[] | null) {
  cached = v;
}

export function redactSecrets(text: string, values: string[] = secrets()): string {
  let out = text;
  for (const v of values) if (out.includes(v)) out = out.split(v).join(REDACTED);
  for (const re of SHAPES) out = out.replace(re, REDACTED);
  return out;
}

/**
 * Streaming redaction. Text is held back from the last whitespace onwards (a
 * secret never contains whitespace, except a PEM private key, which is held
 * until it ends), so a value split across chunks is still caught.
 */
export function createRedactor(values: string[] = secrets()) {
  let pending = '';
  const MAX_HOLD = 4096;
  return {
    push(chunk: string): string {
      pending += chunk;
      const pem = pending.lastIndexOf('-----BEGIN');
      if (pem !== -1 && !/-----END [A-Z ]*PRIVATE KEY-----/.test(pending.slice(pem)) && pending.length - pem < MAX_HOLD) {
        const ready = pending.slice(0, pem);
        pending = pending.slice(pem);
        return redactSecrets(ready, values);
      }
      const cut = Math.max(pending.lastIndexOf(' '), pending.lastIndexOf('\n'), pending.lastIndexOf('\t'));
      if (cut === -1 && pending.length < MAX_HOLD) return '';
      const at = cut === -1 ? pending.length : cut + 1;
      const ready = pending.slice(0, at);
      pending = pending.slice(at);
      return redactSecrets(ready, values);
    },
    flush(): string {
      const rest = pending;
      pending = '';
      return redactSecrets(rest, values);
    },
  };
}
