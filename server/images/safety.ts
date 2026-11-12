/**
 * Safety check for image prompts, run before any image model call.
 *
 * 1. Hard rules (no cost): sexual content involving minors, any sexual or
 *    nude imagery, non-consensual intimate or deceptive imagery of real people
 *    (deepfakes, face swaps, "fake photo of ..."), and forged documents,
 *    money, receipts or impersonated official branding.
 * 2. Llama Guard 3 on Cloudflare (about 9 Neurons): any "unsafe" verdict blocks.
 *
 * Fails closed: if the classifier cannot be reached, no image is generated.
 * Limitation: Llama Guard 3 8B reads text only, so an attached picture itself
 * is not classified; the instruction that comes with it is.
 */
import { chatOnce } from '../cloudflare/client.js';
import { SAFETY_MODEL } from '../config/images.js';

export type SafetyCategory = 'minors' | 'sexual' | 'real_person' | 'fraud' | 'classifier' | 'unavailable';

export type SafetyResult =
  | { ok: true; neurons: number }
  | { ok: false; category: SafetyCategory; message: string; neurons: number };

const MINOR =
  /\b(child|children|kid|kids|minor|minors|underage|under-age|teen|teens|teenager|teenage|preteen|pre-teen|schoolgirl|schoolboy|school girl|school boy|loli|lolita|shota|toddler|baby|babies|infant|little (girl|boy)|young (girl|boy)|(1[0-7]|[1-9])[- ]?(yo|y\/o|years?[- ]old)|girl|boy)\b/i;
const SEXUAL =
  /\b(nude|nudes|nudity|naked|nsfw|porn\w*|erotic\w*|sexual\w*|sexy|seductive|sensual|topless|bottomless|lingerie|undress\w*|strip(ping|tease)|explicit|hentai|genital\w*|(?<!chicken |turkey |duck )breasts?|boobs?|nipples?|buttocks|butt|penis|vagina|intercourse|orgasm\w*|fetish\w*|bdsm|onlyfans|xxx|lewd|provocative pose|without (any )?cloth\w*|no cloth\w*|remove (her|his|their|the) cloth\w*|take off (her|his|their) cloth\w*|in (a )?bikini|bikini|underwear)\b/i;
const MINOR_ONLY_SENSITIVE = /\b(bikini|underwear|swimsuit|bath|bathing|shower\w*|kiss\w*|romantic|lover|dating)\b/i;

const REAL_PERSON =
  /\b(deep ?fakes?|face ?swap\w*|swap (the|his|her|their|my) faces?|put ((my|his|her|their|your|a|the) )?(\w+['’]s |\w+ )?face on|replace (his|her|their|the) face|fake (photo|photos|picture|pictures|image|images|video|selfie|footage|evidence|screenshot)s? of|make it look like (a )?real (photo|picture)|(photo|picture|image)s? of (a )?real (person|people|woman|man)|revenge porn|leaked (photo|nude|picture)s?|without (her|his|their) (consent|permission)|(arrested|in handcuffs|in prison|committing a crime|drunk|doing drugs)\b.*\b(president|minister|politician|celebrity|mp|senator|governor|ceo|pastor))\b/i;

const DOCUMENT =
  /\b(passports?|id cards?|identity cards?|national id|ghana ?card|voter'?s? (id|card)|driver'?s? licen[cs]es?|driving licen[cs]es?|licen[cs]e plates?|bank ?notes?|banknotes?|currency|cedi notes?|dollar bills?|euro notes?|money notes?|cheques?|checks? (from|for|of) |receipts?|invoices?|bank statements?|payslips?|pay slips?|certificates?|diplomas?|degree certificates?|transcripts?|visas?|boarding pass(es)?|work permits?|residence permits?|birth certificates?|medical (report|certificate|note)s?|doctor'?s note|prescriptions?|official (stamp|seal|letter|document)s?|signatures?|mobile money (transfer|transaction|receipt|screenshot)|momo (transfer|transaction|receipt|screenshot)|(transaction|transfer|payment) (screenshot|confirmation|receipt))\b/i;
const FORGERY_CUE =
  /\b(fake|forged?|forgery|counterfeit|replica|realistic|real|authentic|genuine|official|valid|copy of|duplicate|scan(ned)?|with (my|his|her|their|the|a) (name|photo|picture|details|number|signature|face)|that looks real|to (use|show|send|submit|print)|for (verification|kyc|proof))\b/i;
const BRAND_IMPERSONATION =
  /\b((official|exact|identical|copy of( the)?|replica of( the)?|replicate( the)?|recreate( the)?|counterfeit)\b.{0,40}\blogos?|logos? (of|for) (a |the )?(bank|government|ministry|police|army|court|university|mtn|vodafone|telecel|airteltigo|ecobank|gcb|absa|stanbic|paypal|visa|mastercard|google|apple|microsoft|meta|facebook|instagram|whatsapp|amazon|netflix)|(fake|phishing|spoof(ed)?) (website|login|page|email|message|sms|screenshot)s?|fake (chat|whatsapp|conversation|tweet|post|news) screenshots?)\b/i;

export const SAFETY_MESSAGES: Record<SafetyCategory, string> = {
  minors: 'I can’t create that image. Atlas AI never generates sexual or suggestive images involving children.',
  sexual: 'I can’t create that image. Atlas AI doesn’t generate nude, sexual or sexually suggestive images.',
  real_person:
    'I can’t create that image. Atlas AI doesn’t create deceptive or intimate images of real people, deepfakes or face swaps.',
  fraud:
    'I can’t create that image. Atlas AI doesn’t create forged documents, money, receipts, official stamps or copies of real organisations’ branding that could be used to deceive.',
  classifier: 'I can’t create that image because it may break the content rules for image generation. Try a different description.',
  unavailable: 'The image safety check is unavailable right now, so no image was created. Please try again in a moment.',
};

/** The no-cost rules alone (also used for tests). */
export function ruleCheck(prompt: string): SafetyCategory | null {
  const t = prompt.toLowerCase();
  const minor = MINOR.test(t);
  if (minor && (SEXUAL.test(t) || MINOR_ONLY_SENSITIVE.test(t))) return 'minors';
  if (SEXUAL.test(t)) return 'sexual';
  if (REAL_PERSON.test(t)) return 'real_person';
  if (DOCUMENT.test(t) && FORGERY_CUE.test(t)) return 'fraud';
  if (BRAND_IMPERSONATION.test(t)) return 'fraud';
  return null;
}

/** Map a Llama Guard verdict ("safe" / "unsafe\nS4,S12") to a category, or null when safe. */
export function parseGuardVerdict(reply: string): SafetyCategory | null | 'unparseable' {
  const text = reply.trim().toLowerCase();
  if (/^safe\b/.test(text)) return null;
  if (!/^unsafe\b/.test(text)) return 'unparseable';
  const codes: string[] = text.match(/s\d+/g) ?? [];
  if (codes.includes('s4')) return 'minors';
  if (codes.includes('s12') || codes.includes('s3')) return 'sexual';
  if (codes.includes('s2') || codes.includes('s8')) return 'fraud';
  return 'classifier';
}

type GuardFn = (prompt: string, signal?: AbortSignal) => Promise<{ text: string; neurons: number }>;

export const defaultGuard: GuardFn = (prompt, signal) =>
  chatOnce(SAFETY_MODEL, [{ role: 'user', content: `Create an image: ${prompt}` }], { maxTokens: 12, signal, timeoutMs: 15_000 });

export async function checkImagePrompt(prompt: string, opts: { signal?: AbortSignal; guard?: GuardFn } = {}): Promise<SafetyResult> {
  const rule = ruleCheck(prompt);
  if (rule) return { ok: false, category: rule, message: SAFETY_MESSAGES[rule], neurons: 0 };
  let verdict: { text: string; neurons: number };
  try {
    verdict = await (opts.guard ?? defaultGuard)(prompt, opts.signal);
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    // fail closed: no verdict, no image
    return { ok: false, category: 'unavailable', message: SAFETY_MESSAGES.unavailable, neurons: 0 };
  }
  const category = parseGuardVerdict(verdict.text);
  if (category === null) return { ok: true, neurons: verdict.neurons };
  if (category === 'unparseable') return { ok: false, category: 'unavailable', message: SAFETY_MESSAGES.unavailable, neurons: verdict.neurons };
  return { ok: false, category, message: SAFETY_MESSAGES[category], neurons: verdict.neurons };
}
