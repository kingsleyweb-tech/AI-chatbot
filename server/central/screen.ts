/**
 * Screening applied to everything that enters the central repository, whoever submits it:
 *  - plain text only (markup and control characters removed, lengths capped)
 *  - secrets and identity numbers are refused outright
 *  - personal contact details (emails, phone numbers, IP addresses) are redacted
 *  - text written to steer an AI ("ignore previous instructions ...") is refused, so a record can
 *    never carry instructions into answers
 */

export const LIMITS = { title: 200, content: 4000, tag: 40, tags: 10, sources: 5 };

export function sanitize(text: string, max: number): string {
  return text
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]{0,500}>/g, ' ')
    // eslint-disable-next-line no-control-regex -- control and invisible formatting characters are stripped on purpose
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max);
}

function luhn(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/** Things that must never be stored, even redacted: the submission is refused. */
const SECRETS: [string, RegExp][] = [
  ['API key or token', /\b(sk-[A-Za-z0-9_-]{16,}|sk-ant-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|xox[abpr]-[A-Za-z0-9-]{10,}|tvly-[A-Za-z0-9_-]{16,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/],
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['password', /\b(password|passwd|pwd|passcode|pin code|otp)\s*[:=]\s*\S{3,}/i],
  ['Ghana Card number', /\bGHA-?\d{9}-?\d\b/i],
  ['social security number', /\b\d{3}-\d{2}-\d{4}\b/],
  ['bank account (IBAN)', /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){3,7}\b/],
];

const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
// international or local numbers with at least 9 digits (Ghana 0XX XXX XXXX, +233 ..., +1 (555) ...)
const PHONE = /(?<![\w.])(?:\+\d{1,3}[\s.-]?)?(?:\(\d{1,4}\)[\s.-]?)?\d{2,4}(?:[\s.-]?\d{2,4}){2,4}(?!\w|\.\d)/g;
const IPV4 = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g;
const CARD = /\b(?:\d[ -]?){13,19}\b/g;

export interface PiiResult {
  text: string;
  redacted: string[];
  blocked: string[];
}

export function screenPii(input: string): PiiResult {
  const blocked = SECRETS.filter(([, re]) => re.test(input)).map(([k]) => k);
  let text = input;
  for (const m of input.match(CARD) ?? []) {
    const d = m.replace(/\D/g, '');
    if (d.length >= 13 && d.length <= 19 && luhn(d) && !/^(19|20)\d{2}/.test(d.slice(0, 4))) blocked.push('payment card number');
  }
  const redacted: string[] = [];
  text = text.replace(EMAIL, () => {
    redacted.push('email address');
    return '[email removed]';
  });
  text = text.replace(PHONE, (m) => {
    const digits = m.replace(/\D/g, '');
    // years, ranges and figures ("2024-2025", "1 000 000") are not phone numbers
    if (digits.length < 9 || digits.length > 15 || /^\d{1,3}([ .]\d{3})+$/.test(m.trim())) return m;
    redacted.push('phone number');
    return '[phone removed]';
  });
  text = text.replace(IPV4, () => {
    redacted.push('IP address');
    return '[address removed]';
  });
  return { text, redacted: [...new Set(redacted)], blocked: [...new Set(blocked)] };
}

const INJECTION: RegExp[] = [
  /\b(ignore|disregard|forget|override|bypass)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|any|your|the|system)\b[^.\n]{0,30}\b(instructions?|rules|prompts?|guidelines|directives|messages)\b/i,
  /\byou are now\b|\bfrom now on,? you\b|\bact as (?:an?|the) (?:unrestricted|jailbroken|different)\b|\bpretend (?:to be|you are)\b/i,
  /\b(system prompt|developer mode|jailbreak|DAN mode|do anything now)\b/i,
  /\b(reveal|print|show|repeat|output)\b[^.\n]{0,30}\b(system prompt|hidden instructions|your instructions|api keys?|secrets?)\b/i,
  /<\/?\s*(system|assistant|user|instructions?|im_start|im_end)\s*>|\[\/?(INST|SYS)\]|<\|(?:im_start|im_end|system|endoftext)\|>/i,
  /\b(new|updated|additional) instructions\s*:/i,
  /\bwhen (?:an? )?(?:ai|assistant|model|chatbot|llm) reads this\b/i,
];

export function looksLikeInjection(text: string): boolean {
  return INJECTION.some((re) => re.test(text));
}

export interface Screened {
  title: string;
  content: string;
  tags: string[];
  redacted: string[];
  /** reasons the submission must be refused */
  refused: string[];
}

/** Clean and screen a candidate's text fields. */
export function screenCandidate(raw: { title: string; content: string; tags?: string[] }): Screened {
  const title0 = sanitize(raw.title, LIMITS.title);
  const content0 = sanitize(raw.content, LIMITS.content);
  const tags0 = (raw.tags ?? [])
    .map((t) => sanitize(t, LIMITS.tag).toLowerCase())
    .filter((t) => /^[\p{L}\p{N} _.+#-]{1,40}$/u.test(t))
    .slice(0, LIMITS.tags);
  const refused: string[] = [];
  if (title0.length < 3) refused.push('A title is required.');
  if (content0.length < 20) refused.push('The content is too short to be useful (at least 20 characters).');
  const t = screenPii(title0);
  const c = screenPii(content0);
  const tg = tags0.map((x) => screenPii(x));
  const blocked = [...new Set([...t.blocked, ...c.blocked, ...tg.flatMap((x) => x.blocked)])];
  if (blocked.length) refused.push(`It contains information that must never be stored: ${blocked.join(', ')}.`);
  if ([title0, content0, ...tags0].some(looksLikeInjection)) refused.push('It contains text written to instruct an AI system, which knowledge records may not carry.');
  return {
    title: t.text,
    content: c.text,
    tags: [...new Set(tg.map((x) => x.text).filter((x) => !x.includes('removed]')))],
    redacted: [...new Set([...t.redacted, ...c.redacted])],
    refused,
  };
}
