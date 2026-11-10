/**
 * Search Decision Engine: decides, before any SerpAPI/Tavily call, whether a
 * message needs the web at all. Deterministic rules, no model call, no credits.
 *
 * The rule of thumb: answer from the model, the conversation, memory and the
 * user's documents unless the question needs current or externally verifiable
 * information, or the user explicitly asks for a search. Some messages (small
 * talk, arithmetic, writing tasks, questions about earlier chats or the attached
 * documents) never search, not even with the Search toggle on.
 */
import { isAboutAtlas } from '../shared/identity.js';
import { extractUrls } from './heuristics.js';
import type { SearchIntent, SearchKind } from './types.js';

/** User preference (Settings): when may the assistant search on its own? */
export type SearchMode = 'auto' | 'manual' | 'eager';

export type DecisionAction = 'none' | 'search' | 'extract' | 'research';

/** Why the engine decided what it did (stored as a counter, never with message text). */
export type DecisionReason =
  // no search
  | 'empty'
  | 'smalltalk'
  | 'math'
  | 'writing'
  | 'memory'
  | 'document'
  | 'model_knowledge'
  | 'mode_manual'
  | 'knowledge_base'
  // a question about Atlas AI itself: answered from its verified identity record
  | 'atlas_identity'
  // search
  | 'toggle'
  | 'explicit_request'
  | 'url'
  | 'current_info'
  | 'eager'
  | 'entity_lookup'
  | 'follow_up'
  // deep research
  | 'research_toggle'
  | 'research_request';

export interface SearchDecision {
  action: DecisionAction;
  reason: DecisionReason;
  /** true when the user asked for the web (toggle, phrase or URL), not the heuristic */
  explicit: boolean;
  intent: SearchIntent;
  kind: SearchKind;
}

export interface DecisionInput {
  /** the Search toggle in the composer */
  webSearch?: boolean;
  /** the Deep Research toggle in the composer */
  deepResearch?: boolean;
  mode?: SearchMode;
  /** documents are attached to this conversation */
  hasDocuments?: boolean;
  /** the knowledge base already has a strong match for this message */
  knowledgeHit?: boolean;
  /** the previous user message in this conversation needed the web (follow-ups keep searching) */
  previousSearched?: boolean;
}

const words = (t: string) => t.trim().split(/\s+/).filter(Boolean).length;

// ---- Never-search categories ----
const SMALLTALK =
  /^(?:(?:hi|hey|hello|hiya|yo|sup|good (?:morning|afternoon|evening|night)|morning|evening|greetings|thanks?(?: you)?(?: so much| a lot)?|thank u|thx|ty|cheers|ok(?:ay)?|cool|nice|great|awesome|perfect|got it|sounds good|alright|bye|goodbye|see (?:you|ya)|lol|haha|yes|no|yep|nope|sure|hmm+|wow)\b[\s,!.?]*)+(?:.{0,60})$/i;
const SMALLTALK_PHRASE =
  /\b(how are you|how(?:'| a)?re you|how are things|how(?:'s| is) it going|how(?:'s| has) your day|what(?:'s| is) up|hope (?:you(?:'re| are)|all is) (?:good|well|fine|doing well|okay|ok)|hope you(?:'re| are) doing (?:well|good|fine)|nice to meet you|you(?:'re| are) (?:awesome|great|amazing|the best|helpful)|i(?:'m| am) (?:good|fine|great|okay|ok|well)|good job|well done|thank(?:s| you))\b/i;
const MATH_ONLY = /^[\s\d.,+\-*/×÷^%()=xX]+[?]?$/;
const MATH_Q = /^(?:what(?:'s| is)|calculate|compute|evaluate|solve|how much is)\s+[\d.,\s+\-*/×÷^%()xX]+[?.!]*$/i;
const WRITING =
  /^(?:please\s+|can you\s+|could you\s+|help me\s+(?:to\s+)?)*(?:write|rewrite|re-write|draft|compose|edit|proofread|paraphrase|rephrase|reword|polish|shorten|expand|translate|summari[sz]e (?:this|the following|my)|fix (?:the )?(?:grammar|spelling|typos)|correct (?:this|my)|brainstorm|outline|create (?:a|an) (?:poem|story|essay|letter|email|cover letter|speech|outline|caption)|make (?:this|it) (?:shorter|longer|more|less|formal|casual))\b/i;
const MEMORY =
  /\b(what did i (?:tell|say|mention|ask|share)|did i (?:tell|mention) you|do you remember|you remember|remind me what|we (?:discussed|talked about|spoke about)|(?:earlier|before|last time|previously) (?:i|you|we) (?:said|told|mentioned|discussed)|as i (?:said|mentioned)|my (?:previous|last|earlier) (?:message|question)|in (?:our|this) (?:conversation|chat))\b/i;
const DOC_REF =
  /\b(?:this|the|attached|uploaded|my|these)\s+(?:pdf|document|doc|docx|file|files|report|slides?|deck|presentation|spreadsheet|sheet|workbook|csv|paper|contract|notes?)\b|\b(?:in|from) (?:the )?(?:attachment|upload)\b/i;

// ---- Search signals ----
const EXPLICIT =
  /\b(search(?: the)?(?: web| internet| online)?(?: for)?|google(?: it| for)?|look\s*(?:it\s*)?up|lookup|browse|find (?:me )?(?:online|on the web|sources|articles|links|references)|check (?:online|the web|the internet)|web results?|with (?:sources|citations|links)|cite (?:your )?sources)\b/i;
const LIVE =
  /\b(weather|forecast|temperature (?:in|at|today)|exchange rate|stock price|share price|market cap|price of|prices? (?:today|now|of)|how much (?:does|do|is|are) .{1,40} (?:cost|costs)|scores?|standings|fixtures|live (?:updates?|score|results?)|(?:match|game|league|cup|football|soccer|race|fight|election|exam) results?|results? (?:of|from) (?:the |last |yesterday|today|this|tonight)|traffic)\b/i;
const NEWS = /\b(news|headlines?|breaking|announced|announcement|press release|election results?|box office|trending)\b/i;
const RECENCY =
  /\b(latest|current(?:ly)?|today|tonight|this (?:week|month|year)|right now|at the moment|recent(?:ly)?|up[- ]to[- ]date|as of (?:now|today)|upcoming|just (?:announced|released|launched)|new(?:est)? (?:version|release|update)|still (?:open|available|alive|in office|ceo|president))\b/i;
// headline-style requests without a question word: "Latest Premier League results", "Give me today's top stories"
const HEADLINE_REQUEST = /^(?:please\s+)?(?:(?:tell|give|show|get|send|update) me\b|list\b|(?:the\s+)?(?:latest|current|recent|newest|today'?s|tonight'?s|this (?:week|month)'?s?)\b)/i;
// league tables, positions, fixtures and results change every week
const SPORTS_LIVE =
  /\b(?:(?:league|premier league|epl|la liga|serie a|bundesliga|ligue 1|champions league|europa league|afcon|world cup|ghana premier league|nba|nfl|f1|formula 1)\s+(?:table|standings|log|top scorers?|fixtures?|schedule)|(?:which|what) (?:position|place)|(?:on|in|top of|bottom of) the (?:table|log|standings)|next (?:match|game|fixture|fight|race)|last (?:match|game)|last night'?s (?:match|game)|top scorers?|transfer (?:news|rumou?rs|window)|who (?:won|scored|is winning)|kick[- ]?off)\b/i;
const NOT_SPORT = /\b(sleep|sleeping|yoga|exercise|baby|pregnan\w*|job|interview|career|resume|cv|essay|poem|story|code)\b/i;
// follow-ups about the previous answer itself, not new facts
const ABOUT_ANSWER =
  /^(?:please\s+)?(?:explain|simplify|summari[sz]e|rewrite|rephrase|translate|shorten|expand|elaborate|make it|in simple|thanks?|thank you|ok(?:ay)?|cool|nice|great)\b|\b(your (?:answer|reply|response)|the above|that answer)\b/i;
const OFFICE = /\b(who (?:is|are) (?:the )?(?:current |new )?(?:president|prime minister|ceo|chair(?:man|person)?|governor|mayor|minister|king|queen|head|leader|owner|coach))\b/i;
const VERSION = /\b(latest|current|newest|stable) (?:version|release)\b|\bversion of\b.*\b(latest|current)\b/i;
const RESEARCH_VERB = /^(?:please\s+)?(?:research|investigate|find out|look into|dig into)\b/i;
const DEEP =
  /\b(deep research|(?:comprehensive|in[- ]depth|detailed|thorough|full|extensive|systematic) (?:study|research|investigation|analysis|report|review|literature review|comparison)|(?:conduct|prepare|write|produce|do) (?:a |an )?(?:comprehensive|in[- ]depth|detailed|thorough|full) (?:study|research|report|investigation|analysis|review))\b/i;
const QUESTION = /\?|^\s*(who|what|when|where|which|how|is|are|did|does|has|have|will|can|should)\b/i;
/** programming topics: "current directory", "current user" etc. are not about time */
const PROG = /\b(python|javascript|typescript|java|kotlin|swift|rust|golang|c\+\+|c#|php|ruby|sql|bash|shell|linux|terminal|regex|css|html|directory|folder|variable|array|string|loop|script|code|program)\b/i;
const CODEY = /```|\b(function|const|let|var|def|class|import|return|SELECT|npm|pip|git|stack ?trace|exception|error:|compile|syntax)\b|[{};]\s*$/m;

// Questions about a specific organization or named thing the model may not know.
const FAMILIAR =
  /\b(?:do you know|have you heard|are you familiar with|know anything|what do you know)\s+(?:about\s+|of\s+)?(?!how\b|what\b|why\b|when\b|where\b|who\b|which\b|if\b|whether\b|that\b|the answer\b|anything\b|any\b|me\b|my\b|your?\b|it\b|this\b)(?:the\s+)?[\w&'.-]+(?:\s+[\w&'.-]+){0,4}\s*[?.!]*$/i;
const ORG_CUE =
  /\b(company|companies|organi[sz]ation|startup|start-up|firm|agency|business|brand|ltd|limited|inc|llc|plc|group|enterprise|ngo|foundation|institute|ministry|authority)\b/i;

/** Year at or after which the model may lack knowledge. */
export const KNOWLEDGE_YEAR = 2026;

export function classifyIntent(text: string): { intent: SearchIntent; kind: SearchKind } {
  const t = text.toLowerCase();
  if (LIVE.test(t)) return { intent: 'live', kind: 'web' };
  if (NEWS.test(t) || /\b(today|yesterday|this week)\b/.test(t)) return { intent: 'news', kind: 'news' };
  if (/\b(research|investigate|in[- ]depth|compare|comparison|versus|vs\.?|analysis|studies|study|evidence|pros and cons|literature|report on|threats?|developments?)\b/.test(t))
    return { intent: 'research', kind: 'web' };
  if (/\b(documentation|docs|api reference|reference|specification|spec|manual|how to install|changelog|release notes)\b/.test(t))
    return { intent: 'reference', kind: 'web' };
  return { intent: 'general', kind: 'web' };
}

/** Messages that never need the web, whatever the toggle says. */
function neverSearch(t: string, hasDocuments: boolean): DecisionReason | null {
  const n = words(t);
  if ((SMALLTALK.test(t) && n <= 12 && !QUESTION.test(t.replace(/how are you|how'?s it going/gi, ''))) || (SMALLTALK_PHRASE.test(t) && n <= 12))
    return 'smalltalk';
  if (MATH_ONLY.test(t) || MATH_Q.test(t)) return 'math';
  if (MEMORY.test(t)) return 'memory';
  if (hasDocuments && DOC_REF.test(t)) return 'document';
  if (WRITING.test(t) && !RECENCY.test(t) && !NEWS.test(t)) return 'writing';
  return null;
}

/** Greetings, small talk, arithmetic and empty messages: no retrieval of any kind. */
export function isTrivial(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  const r = neverSearch(t, false);
  return r === 'smalltalk' || r === 'math';
}

export function decideSearch(text: string, input: DecisionInput = {}): SearchDecision {
  const t = text.trim();
  const mode = input.mode ?? 'auto';
  const { intent, kind } = classifyIntent(t);
  const none = (reason: DecisionReason): SearchDecision => ({ action: 'none', reason, explicit: false, intent, kind });
  if (!t || t.length > 4000) return none('empty');

  const explicitPhrase = EXPLICIT.test(t);
  const blocked = neverSearch(t, Boolean(input.hasDocuments));
  // An explicit "search the web for ..." beats the writing/document rules, never small talk or math.
  if (blocked && !(explicitPhrase && (blocked === 'writing' || blocked === 'document' || blocked === 'memory'))) return none(blocked);

  const research = (reason: DecisionReason): SearchDecision => ({ action: 'research', reason, explicit: true, intent: 'research', kind: 'web' });
  const search = (reason: DecisionReason, explicit: boolean): SearchDecision => ({ action: 'search', reason, explicit, intent, kind });

  if (input.deepResearch) return research('research_toggle');
  if (extractUrls(t).length) return { action: 'extract', reason: 'url', explicit: true, intent: 'reference', kind: 'web' };
  if (DEEP.test(t) && mode !== 'manual') return research('research_request');
  if (input.webSearch) return search('toggle', true);
  if (explicitPhrase) return search('explicit_request', true);
  if (mode === 'manual') return none('mode_manual');
  // "Who built Atlas AI?": the verified record answers it; a web search would find other organisations with the same name
  if (isAboutAtlas(t)) return none('atlas_identity');

  const codey = CODEY.test(t);
  const years = (t.match(/\b(20\d{2})\b/g) ?? []).map(Number);
  const futureYear = years.some((y) => y >= KNOWLEDGE_YEAR);
  // "latest version of React" is a current fact even though it is about code
  if (VERSION.test(t) && !/```/.test(t)) return search('current_info', false);
  if (!codey) {
    if (LIVE.test(t) || NEWS.test(t)) return search('current_info', false);
    if (SPORTS_LIVE.test(t) && !NOT_SPORT.test(t)) return search('current_info', false);
    if (OFFICE.test(t)) return search('current_info', false);
    if (RECENCY.test(t) && !PROG.test(t) && (QUESTION.test(t) || RESEARCH_VERB.test(t) || HEADLINE_REQUEST.test(t))) return search('current_info', false);
    if (futureYear && QUESTION.test(t)) return search('current_info', false);
  }
  // a short follow-up in a conversation about current events ("which position is Liverpool?") keeps using the web
  if (input.previousSearched && !codey && words(t) <= 15 && !ABOUT_ANSWER.test(t)) return search('follow_up', false);
  // eager: questions about named things may search; plain definitions ("What is Java?") still do not
  const definition = /^(?:what (?:is|are)|explain|define|describe)\s+(?:an?\s+|the\s+)?[\w+#.-]+\s*[?.!]*$/i.test(t);
  // "Do you know Soko Aerial?": look it up, unless the knowledge base already covers it
  const entity = !codey && (FAMILIAR.test(t) || (ORG_CUE.test(t) && /\b[A-Z][\w&'.-]+(?:\s+[A-Z][\w&'.-]+)+|\b[A-Z]{2,}/.test(t.replace(/^\W*\w+/, '')) && (QUESTION.test(t) || /^(?:please\s+)?(?:tell me|explain|describe|give me|info|information|details)\b/i.test(t))));
  if (entity) return input.knowledgeHit ? none('knowledge_base') : search('entity_lookup', false);
  if (mode === 'eager' && !codey && !definition && QUESTION.test(t) && /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/.test(t.slice(1))) return search('eager', false);
  return none('model_knowledge');
}
