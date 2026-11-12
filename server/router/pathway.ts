/**
 * Response pathway: does this message need Advanced Reasoning, or the normal fast pathway?
 *
 * Deterministic rules on the message itself (no model call, a few microseconds): the fast
 * pathway is the default, and Advanced Reasoning is chosen only for a concrete reason, such as
 * a multi-step calculation, debugging code, a logic puzzle, a multi-stage plan, a comparison of
 * several technical options, or an explicit request to think carefully. Length alone never
 * decides: a long message can be simple, and a short one can be hard.
 *
 * The pathway only changes how much the model thinks before answering (on models that can do
 * both); it never changes the model the user selected.
 */
import { isTrivial } from '../search/decide.js';

export type Pathway = 'fast' | 'reasoning';

export type PathwayReason =
  // fast
  | 'default'
  | 'smalltalk'
  | 'quick_request'
  | 'writing'
  // reasoning
  | 'explicit'
  | 'math'
  | 'debugging'
  | 'algorithm'
  | 'logic'
  | 'planning'
  | 'comparison'
  | 'analysis'
  | 'deep_explanation'
  | 'science';

export interface PathwayDecision {
  pathway: Pathway;
  reason: PathwayReason;
}

const fast = (reason: PathwayReason): PathwayDecision => ({ pathway: 'fast', reason });
const deep = (reason: PathwayReason): PathwayDecision => ({ pathway: 'reasoning', reason });

const EXPLICIT =
  /\b(think (?:it )?(?:deeply|carefully|hard|harder|thoroughly|through|step[- ]by[- ]step)|reason (?:carefully|through|it out|step[- ]by[- ]step)|step[- ]by[- ]step (?:solution|proof|derivation|reasoning|explanation)|show (?:your|the|all) (?:work|working|reasoning|steps)|use (?:advanced |deep )?reasoning|deep(?:ly)? (?:think|reason)|prove (?:that|why)|proof (?:that|of)|derive (?:the|an?|that)|derivation of)\b/i;
/** "briefly", "in one sentence": the user wants a short answer, not deliberation */
const QUICK = /\b(briefly|in brief|quick(?:ly)?|short answer|in (?:one|a|two) (?:sentence|line|word)s?|tl;?dr|just (?:tell|give) me|one[- ]liner)\b/i;
const TRANSLATE = /^(?:please\s+|can you\s+|could you\s+)?translate\b/i;
const WRITING =
  /^(?:please\s+|can you\s+|could you\s+|help me\s+(?:to\s+)?)*(?:write|rewrite|draft|compose|proofread|paraphrase|rephrase|reword|polish|shorten|fix (?:the )?(?:grammar|spelling|typos)|correct (?:this|my)|create (?:a|an) (?:poem|story|letter|email|caption))\b/i;

// ---- mathematics ----
const NUMBER = /(?<![\w.])\d+(?:[.,]\d+)?(?![\w.])/g;
const MATH_VERB =
  /\b(solve|calculate|compute|work out|evaluate|simplify|factori[sz]e|expand|how (?:many|much|long|far|fast)|probability|odds|expected value|percentage|percent|ratio|proportion|average speed|compound interest|interest rate|equation|inequalit(?:y|ies)|integra(?:l|te)|derivative|differentiate|limit of|matrix|matrices|determinant|eigen\w*|vector|series|sequence|sum of|product of|prime|modulo|gcd|lcm|logarithm|log\b|quadratic|polynomial|roots? of|area|volume|perimeter|triangle|angle|hypotenuse)\b/i;
/** word problems: several quantities plus a rate or a "when do they meet" question */
const WORD_PROBLEM = /\b(at what time|catch(?:es)? up|overtakes?|meet|km\/h|mph|m\/s|per (?:hour|minute|second|day|week|month|year)|speed|rate|discount|profit|loss|split|share(?:d)? equally)\b/i;
const EQUATION =/[a-z]\s*\^\s*\d|\d\s*[a-z]\s*[+\-=]|[a-z]\s*=\s*[-\d(]|[=<>≤≥]\s*[-\d(a-z]|∫|√|∑|∏|\bsqrt\(|\bdy\/dx\b|\bf\(x\)/i;

// ---- programming ----
const CODE_BLOCK = /```|^\s{4,}\S|\b(?:Traceback|stack ?trace|at [\w.$<>]+\(.*:\d+\)|Exception:|Error:|TypeError|ReferenceError|SyntaxError|NullPointerException|Segmentation fault|panic:)/m;
const DEBUG =
  /\b(debug|bug|fix|broken|doesn'?t work|does not work|not working|isn'?t working|fails?|failing|crash(?:es|ing)?|throws?|exception|error|wrong (?:output|result)|unexpected(?:ly)?|why (?:does|is|do|doesn'?t|isn'?t)|race condition|deadlock|memory leak|infinite loop|off[- ]by[- ]one)\b/i;
const CODE_TOPIC =
  /\b(code|function|method|class|script|program|query|regex|api|endpoint|component|hook|async|await|promise|thread|loop|recursion|pointer|compiler|typescript|javascript|python|java|kotlin|swift|rust|golang|c\+\+|c#|php|ruby|sql|react|node(?:\.js)?|django|flask|spring|docker|kubernetes)\b/i;
const ALGORITHM =
  /\b(algorithm|time complexity|space complexity|big[- ]o|optimi[sz]e (?:this|the|my)|dynamic programming|data structure|implement (?:a|an|the)\b.{0,40}\b(?:tree|graph|heap|queue|stack|cache|parser|scheduler|search|sort)|design (?:a|an) (?:system|architecture|database schema|api))\b/i;

// ---- reasoning-heavy tasks ----
const LOGIC =
  /\b(riddle|puzzle|logic(?:al)? (?:problem|puzzle|question)|brain ?teaser|knights? and knaves|truth[- ]teller|liars?\b.{0,40}\btruth|which (?:of the following )?(?:must|could|cannot) be true|if .{3,80} then .{3,80} (?:who|which|what|how)|syllogism|deduce|deduction)\b/i;
const PLANNING =
  /\b(?:plan|roadmap|strategy|schedule|itinerary|curriculum|study plan|business plan|project plan|migration plan|launch plan)\b.{0,80}\b(?:step[- ]by[- ]step|phases?|stages?|milestones?|week[- ]by[- ]week|month[- ]by[- ]month|detailed|comprehensive|timeline|dependencies|budget)\b|\b(?:step[- ]by[- ]step|detailed|comprehensive|multi[- ](?:stage|step|phase))\b.{0,40}\b(?:plan|roadmap|strategy|schedule|itinerary)\b/i;
const COMPARE = /\b(compare|comparison|versus|vs\.?|trade[- ]?offs?|pros and cons|advantages and disadvantages|which (?:is|would be) better)\b/i;
const TECH_DEPTH =
  /\b(architecture|architectures|scalab\w*|performance|latency|throughput|consistency|availability|fault[- ]toleran\w*|microservices?|monolith\w*|serverless|event[- ]driven|database|sql|nosql|cach\w*|distributed|concurren\w*|security model|framework|protocol)\b/i;
const ANALYSE = /\b(analy[sz]e|evaluate|assess|critique|examine|weigh up|work through)\b/i;
const SCENARIO = /\b(scenario|case study|situation|implications|consequences|risks?|dilemma|decision|strategy|outcome|what would happen)\b/i;
const EXPLAIN = /\b(explain|describe|walk me through|how does|how do|why does|why do|what happens when)\b/i;
const DEPTH_CUE = /\b(in (?:great |full )?detail|in[- ]depth|thoroughly|under the hood|internals?|from first principles|mathematically|rigorously|step by step)\b/i;
/** topics that are hard to explain well without working through them */
const HARD_TOPIC =
  /\b(quantum|relativity|thermodynamic\w*|entropy|fourier|laplace|eigen\w*|backpropagation|gradient descent|transformer (?:model|architecture)|attention mechanism|consensus (?:algorithm|protocol)|paxos|raft|byzantine|public[- ]key|elliptic curve|zero[- ]knowledge|cryptograph\w*|garbage collect\w*|virtual memory|tcp congestion|cap theorem|np[- ]complete|halting problem|turing machine|bayes(?:ian)?|monte carlo|differential equation|game theory|nash equilibrium|black[- ]scholes|general equilibrium|krebs cycle|protein folding|crispr)\b/i;
const SCIENCE_TASK =
  /\b(calculate|derive|find|determine|prove|show that|balance|predict)\b.{0,60}\b(force|velocity|acceleration|momentum|energy|power|pressure|current|voltage|resistance|wavelength|frequency|half[- ]life|molar|moles?|concentration|ph\b|enthalpy|equilibrium constant|reaction|orbit|gravitational)\b/i;

const words = (t: string) => t.trim().split(/\s+/).filter(Boolean).length;
const listCount = (t: string) => {
  // "React, Vue and Svelte" / "A vs B vs C": how many things are being compared
  const vs = t.split(/\bvs\.?\b|\bversus\b/i).length;
  const commas = (t.match(/,\s*(?:and\s+|or\s+)?\w/g) ?? []).length;
  return Math.max(vs, commas + (/\band\b|\bor\b/i.test(t) ? 2 : 1));
};

/**
 * Models whose thinking can be switched off per request: Gemini Flash and Flash-Lite. Pro models
 * always think, and other providers' reasoning models are chosen for their reasoning, so on those
 * the user's choice of model decides.
 */
export function thinkingSwitchable(modelId: string): boolean {
  const id = modelId.replace(/^gemini:/, '');
  return modelId.startsWith('gemini:') && id.startsWith('gemini-') && !id.includes('pro');
}

/**
 * Choose the pathway for the newest user message. `hasCodeAttachment`: a code file is attached
 * (debugging questions about it are reasoning tasks).
 */
export function choosePathway(text: string, opts: { hasCodeAttachment?: boolean } = {}): PathwayDecision {
  const t = text.trim();
  if (!t) return fast('smalltalk');
  if (EXPLICIT.test(t)) return deep('explicit');
  if (isTrivial(t)) return fast('smalltalk');
  if (QUICK.test(t)) return fast('quick_request');
  if (TRANSLATE.test(t)) return fast('writing');

  const code = CODE_BLOCK.test(t) || Boolean(opts.hasCodeAttachment);
  if (code && DEBUG.test(t)) return deep('debugging');
  if (!code && DEBUG.test(t) && CODE_TOPIC.test(t) && /\b(why|how (?:do|can) i fix|what(?:'s| is) wrong|debug)\b/i.test(t) && words(t) >= 8) return deep('debugging');
  if (ALGORITHM.test(t)) return deep('algorithm');

  // writing tasks (emails, letters, rewording) stay fast unless they asked for analysis
  if (WRITING.test(t) && !ANALYSE.test(t)) return fast('writing');

  const numbers = (t.match(NUMBER) ?? []).length;
  if (EQUATION.test(t) && (MATH_VERB.test(t) || /[=?]/.test(t))) return deep('math');
  if (MATH_VERB.test(t) && numbers >= 2 && words(t) >= 6) return deep('math');
  if (WORD_PROBLEM.test(t) && numbers >= 2) return deep('math');
  if (/\b(integra(?:l|te)|derivative|differentiate|eigen\w*|determinant|limit of)\b/i.test(t)) return deep('math');

  if (LOGIC.test(t)) return deep('logic');
  if (SCIENCE_TASK.test(t) && numbers >= 1) return deep('science');
  if (PLANNING.test(t)) return deep('planning');
  if (COMPARE.test(t) && (listCount(t) >= 3 || TECH_DEPTH.test(t))) return deep('comparison');
  if (ANALYSE.test(t) && SCENARIO.test(t) && words(t) >= 12) return deep('analysis');
  if (EXPLAIN.test(t) && (HARD_TOPIC.test(t) || (DEPTH_CUE.test(t) && (TECH_DEPTH.test(t) || CODE_TOPIC.test(t))))) return deep('deep_explanation');
  return fast('default');
}
