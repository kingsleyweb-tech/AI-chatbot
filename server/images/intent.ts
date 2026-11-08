/**
 * Deterministic image-request detection (no model call, no cost).
 *
 * "Generate an image of a lion in a forest", "Draw a futuristic city" and
 * "Create a professional business logo" are image requests. Questions about
 * image generation ("Which AI model is best for generating images?"),
 * requests for text about images ("write a prompt for a logo", "create a
 * name for my logo") and figurative uses ("draw a conclusion") are not.
 */

export type ImageIntent =
  | { kind: 'generate'; prompt: string }
  /** source: an image attached to this message, or the image this conversation produced last */
  | { kind: 'edit'; prompt: string; source: 'attachment' | 'previous' };

const NOUN =
  '(images?|pictures?|pics?|photos?|photographs?|illustrations?|logos?|drawings?|artworks?|paintings?|sketch(es)?|icons?|wallpapers?|posters?|banners?|stickers?|avatars?|portraits?|cartoons?|mock-?ups?|renders?|renderings?|memes?|emojis?|clip ?art|graphics?|thumbnails?|flyers?|concept art|character designs?|3d (characters?|models?|renders?|scenes?|objects?)|watercolou?rs?|digital art|pixel art|anime (art|characters?))';
const REQUEST_VERB =
  '(generate|create|make|draw|design|render|paint|sketch|illustrate|produce|imagine|craft|give me|show me|send me|get me|i (want|need|would like)|i\'d like)';
/** verbs that only ever mean producing a picture when followed by a concrete subject */
const VISUAL_VERB = '(draw|paint|sketch|illustrate|render)';

const GENERATE = new RegExp(`\\b${REQUEST_VERB}\\b[^.?!\\n]{0,60}?\\b${NOUN}\\b`, 'i');
const VISUAL = new RegExp(`^\\s*(please\\s+)?${VISUAL_VERB}\\s+(me\\s+)?(a|an|the|some|my|our|\\d+)?\\s*\\w+`, 'i');

/** draw/render used figuratively or about something that is not a picture */
const FIGURATIVE =
  /\b(draw|drew|drawing|render|rendering)\s+(up\s+)?(a |an |the |some |my |your |our )?(conclusions?|parallels?|comparisons?|attention|lessons?|inspiration|distinctions?|lines? between|blood|breath|plans?|contracts?|agreements?|budgets?|crowds?|fire|money|funds?|cards?|lots?|straws?|a blank|inferences?|services?|judg(e)?ments?|verdicts?|assistance|aid|help|it useless|the page|html|component|template|markdown|text)\b/i;

/** the thing being made is text, code or a plan, even if an image word follows */
const TEXT_OBJECT =
  /\b(generate|create|make|design|produce|write|draft|give me|suggest|come up with)\s+(me\s+)?((a|an|the|some|my|our|\d+)\s+)?((short|good|catchy|creative|professional|detailed|better|new|few|list of|couple of)\s+)*([\w-]+\s+){0,2}?(names?|slogans?|taglines?|captions?|descriptions?|prompts?|brief|briefs|lists?|plans?|stor(y|ies)|poems?|texts?|copy|titles?|posts?|bios?|essays?|emails?|scripts?|outlines?|strateg(y|ies)|alt[- ]text|questions?|ideas?|concepts? for|summar(y|ies)|reports?|tables?|charts?|graphs?|diagrams? in|spreadsheets?|documents?|code|functions?|components?|html|css|svg|regex|quiz|recipes?)\b/i;

/** asking about image generation rather than asking for an image */
const QUESTION_START =
  /^\s*(which|what|why|how|where|when|who|whose|is|are|was|were|does|do|did|should|has|have|explain|tell me (about|how|why|what)|compare|list)\b/i;
const HOW_TO = /\b(how (do|can|could|would|should) (i|we|you|one)|how to|ways? to|steps? to|tips? (for|on)|tutorial|best (way|tool|app|model|ai|software|site|website))\b/i;
const ABOUT_TOOLS = /\b(model|models|tool|tools|ai|app|apps|software|service|services|website|websites|api|apis|midjourney|dall-?e|stable diffusion|flux|program|programs)\b/i;
/** polite requests are still requests: "can you generate an image of ..." */
const POLITE = /^\s*(hey|hi|hello|ok(ay)?|so|now|please|pls|kindly|atlas)?[,!\s]*(can|could|would|will) (you|u)\s+(please\s+|kindly\s+)?/i;

const NOT_A_PICTURE = /\b(describe|description of|explain|what('?s| is) in|analy[sz]e|read the text|transcribe|identify|caption this|tell me about|summari[sz]e|translate|ocr)\b/i;

const EDIT_VERB =
  /\b(edit|change|remove|erase|delete|replace|add|put|make|turn|convert|transform|recolou?r|colou?ri[sz]e|retouch|blur|sharpen|enhance|restyle|stylize|stylise|swap|fix|clean up|brighten|darken|crop|extend|expand|redo|re-?draw|re-?create|repaint|give (it|him|her|them))\b/i;
const FOLLOW_UP_EDIT =
  /^\s*(ok(ay)?[,!\s]+|now[,\s]+|please[,\s]+|and[,\s]+|great[,!\s]+|nice[,!\s]+|cool[,!\s]+|perfect[,!\s]+|thanks[,!\s]+|but[,\s]+)*((can|could|would) you\s+(please\s+)?)?(make|change|turn|convert|transform|add|remove|erase|replace|put|give|recolou?r|colou?ri[sz]e|edit|redo|re-?draw|re-?do|try again|try another|another|one more|variation|variant|more|less|same|use|set|swap|zoom|brighten|darken|enhance|restyle|stylize|stylise|show (it|me it|him|her|them))\b/i;
const TEXT_EDIT = /\b(shorter|longer|summar|explain|translate|rephrase|rewrite|reword|bullet|paragraph|sentence|essay|answer|response|reply|code|list|table)\b/i;

const MAX_PROMPT = 2000;

function clean(text: string): string {
  return text.replace(POLITE, '').replace(/\s+/g, ' ').trim().slice(0, MAX_PROMPT);
}

/** True when the text asks for a new picture to be produced. */
export function isGenerateRequest(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 3000) return false;
  const body = t.replace(POLITE, '');
  if (QUESTION_START.test(body) && !POLITE.test(t)) return false;
  if (HOW_TO.test(t)) return false;
  if (/\?\s*$/.test(t) && !POLITE.test(t) && ABOUT_TOOLS.test(t)) return false;
  if (NOT_A_PICTURE.test(t)) return false;
  if (TEXT_OBJECT.test(body)) return false;
  if (FIGURATIVE.test(t)) return false;
  // "write a prompt for", "prompt to generate an image of": text about an image
  if (/\b(prompt|prompts)\b/i.test(t) && /\b(write|give|suggest|create|make|generate|craft|improve)\b/i.test(t)) return false;
  return GENERATE.test(body) || VISUAL.test(body);
}

export function detectImageIntent(
  text: string,
  opts: { hasImageAttachment: boolean; previousImage: boolean },
): ImageIntent | null {
  const t = text.trim();
  if (!t) return null;
  if (opts.hasImageAttachment) {
    // an attached picture plus an instruction to change it (or to make something from it)
    if (NOT_A_PICTURE.test(t) || QUESTION_START.test(t.replace(POLITE, ''))) return null;
    if (TEXT_OBJECT.test(t.replace(POLITE, ''))) return null;
    if (EDIT_VERB.test(t) || isGenerateRequest(t)) return { kind: 'edit', prompt: clean(t), source: 'attachment' };
    return null;
  }
  if (isGenerateRequest(t)) return { kind: 'generate', prompt: clean(t) };
  if (opts.previousImage && t.length <= 400 && FOLLOW_UP_EDIT.test(t) && !TEXT_EDIT.test(t) && !QUESTION_START.test(t.replace(POLITE, ''))) {
    return { kind: 'edit', prompt: clean(t), source: 'previous' };
  }
  return null;
}

/** First line of an image reply: lets a later message know the previous reply was an image. */
export const IMAGE_REPLY_PREFIX = /^(Created an image|Edited the image)\b/;
