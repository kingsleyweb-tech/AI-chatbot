# AI provider compliance: Gemini and alternatives for a general-purpose assistant

Prepared 8 November 2026 from the providers' published terms. This is a technical research note, **not legal advice**. Every conclusion marked "for counsel" needs a lawyer's review before it is relied on.

## Intended audience

Atlas AI is a general-purpose assistant for both everyday users (personal conversations, learning, writing, research, daily tasks) and professionals, developers, researchers and organisations. Users must be 18 or older. Atlas AI is currently free. The Terms of Use say it is for personal and professional use. They never describe it as a professional-only service.

## What Atlas AI uses today

| Route | Models | Terms that apply |
|---|---|---|
| Gemini API (direct, Google AI Studio key, unpaid) | `gemini-3.6-flash` (the default when the key is set), `gemini-3.8-flash`, `gemini-3.5-flash-lite` | Gemini API Additional Terms of Service (Unpaid Services), Google APIs Terms, Generative AI Prohibited Use Policy |
| OpenRouter (free models) | Nemotron 3 Ultra, Nemotron 3.5 Super VL, Gemma 4 26B/31B, Cohere North Mini Code, Nemotron embeddings | OpenRouter Terms (31 Aug 2026), plus each model's "Model Terms" (licence and serving provider's terms) |

## Findings

### 1. Gemini API (Google AI Studio)

Quoted from the Gemini API Additional Terms, effective 23 March 2026 (aistudio.google.com/docs/terms):

- "Use of Google AI Studio and Gemini API is for developers building with Google AI models for professional or business purposes, not for consumer use."
- "You may only access the Services (or make API Clients available to users) within an available region."
- "You must be 18 years of age or older to use the APIs." You also may not use the Services in a service "that is directed towards or is likely to be accessed by individuals under the age of 18."
- Unpaid Services: Google uses submitted content and responses "to provide, improve, and develop" its products; "human reviewers may read, annotate, and process your API input and output"; "Do not submit sensitive, confidential, or personal information to the Unpaid Services."
- Paid Services: prompts and responses are not used to improve Google's products and are processed under Google's Data Processing Addendum.

**Assessment (for counsel).** The terms clearly allow a developer to make "API Clients available to users", so building an app on the API is contemplated. What is unclear is whether "not for consumer use" restricts:
- (a) who may hold the API account: the developer must be acting professionally, which Atlas AI's owner is; or
- (b) who an app may serve: no consumer-facing apps.

Reading (b) would conflict with Atlas AI's everyday-user audience. **The paid tier does not resolve this**: the sentence applies to the whole Gemini API, paid or unpaid. The paid tier only changes data use (no training, DPA). Atlas AI does meet the age conditions: 18+ only, and it is not directed at minors.

Separately, sending personal information to the **unpaid** tier conflicts with Google's own advice ("Do not submit ... personal information to the Unpaid Services"), because chat messages often contain personal information.

**Using Gemini through OpenRouter does not remove these restrictions.** OpenRouter's terms make the customer responsible for complying with each model's provider terms (see 3).

### 2. Google Cloud Vertex AI (Gemini on Google Cloud)

From the Google Cloud Service Specific Terms, section 20 (Generative AI Services):

- No "professional or business purposes" or "not for consumer use" wording was found.
- Age: the customer will not allow use "as part of a website, Customer Application, or other online service that is directed towards or is likely to be accessed by individuals under the age of 18". Atlas AI meets this.
- Training: "Google will not use Customer Data to train or fine-tune any AI/ML models without Customer's prior permission or instruction" (section 18).
- Also restricted: clinical or medical-advice use (20(e)), and using outputs to build competing models (17).

**Assessment.** Of the providers checked, this is the most direct way to keep Gemini models for a consumer-facing app. **Cost:** Vertex AI is a paid, billed Google Cloud service and needs a billing account. It needs your approval before any change.

### 3. OpenRouter

From the OpenRouter Terms, last updated 31 August 2026:

- You may incorporate the Service into your own products for your customers (5.1), and you judge whether models suit "customer-facing use" (5.6).
- You "will ensure that your Authorized Users and customers agree, to comply with the applicable terms", must review the Model Terms of each model, and are "responsible for all acts and omissions" of your users, including Model Terms violations (5.1, 5.2).
- 18+ to use the Service (2).
- "Some Models may store or train on your Inputs" (6.1).

**Tested 8 November 2026:** with `data_collection: "deny"`, the free Nemotron chat models and the free embedding model are refused ("Free model training"). The free models Atlas AI uses run only on providers that may train on prompts.

**Assessment.** OpenRouter permits customer-facing apps. Compliance then depends on each model's terms. The open-weight models Atlas AI uses (NVIDIA Nemotron, Google Gemma) are published under their own model licences, not the Gemini API terms. **Still to verify:** the current NVIDIA Open Model License, the Gemma Terms of Use, Cohere's terms for North Mini Code, and the terms of the providers serving each free endpoint.

### 4. Other providers checked

| Provider | End-user (consumer) apps | Minimum age / minors | Training on API data | Free tier | Confidence |
|---|---|---|---|---|---|
| **Anthropic (Claude API)** | Allowed. The Usage Policy (effective 12 Nov 2026) requires consumer-facing chatbots to "disclose to users that they are interacting with AI rather than a human" at least at the start of each session or in the interface. | Minor = under 18. Products for minors must follow extra guidelines. | Not used by default under commercial terms (to confirm in the Commercial Terms) | No | Usage Policy read directly; commercial terms not yet read |
| **OpenAI API** | Business Terms allow customers to make their products available to end users and make the customer responsible for them (Aug 2023 text) | Reported as 13+ with parental consent under 18 (secondary sources) | Not used by default for API data (to confirm) | No (pay as you go) | Primary page blocked (403); current text not read |
| **Google Vertex AI** | Allowed; no consumer-use restriction found | Not for services likely to be accessed by under-18s | Not used without permission | No (billing; new-account credits only) | Read directly |
| **Mistral (La Plateforme)** | To confirm | To confirm | Free mode: data may be used for training unless opted out (secondary sources disagree) | Yes (rate-limited) | Secondary sources only |
| **Groq (GroqCloud)** | **Possible restriction:** a secondary source quotes "not for consumer use" | To confirm | Not used unless permitted (secondary) | Yes (rate-limited; described as for prototyping) | Secondary sources only |
| **Cloudflare Workers AI** (in use since Terms/Privacy 1.3: images, and chat models the user selects) | Allowed as part of Cloudflare services (to confirm in the Cloudflare terms) | To confirm | Not used: "Cloudflare does not use Customer Content processed by Workers AI to train AI models"; inputs and outputs not kept after the request for standard inference; operational metadata kept (data-usage page, updated 16 Oct 2026) | Yes (10,000 Neurons/day; Atlas AI caps itself at 9,000 and never enables paid usage) | Data-usage page read directly; terms of service not yet read |

Rows marked "secondary sources" must be checked against the provider's own legal pages before any decision.

## Which providers can support the intended audience

- **Clearly permitted (on the terms read):** Google Vertex AI, Anthropic Claude API (with the AI disclosure, which Atlas AI already makes by being an AI assistant; add an explicit line in the interface to be safe), and OpenRouter as a platform, subject to each model's terms. **All of these except OpenRouter's free models are paid.**
- **Unclear, for counsel:** the Gemini API (AI Studio), paid or unpaid, because of "not for consumer use".
- **Not yet assessable:** OpenAI (current text not read), Mistral, Groq (possible consumer restriction). Cloudflare: data use read directly; the terms on end-user apps and minimum age still to confirm.

## Recommended architecture

Atlas AI already routes every request through one server-side provider layer (`server/providers`, `server/router`), so providers can change without touching the app. As you asked, nothing below is implemented yet.

1. **Provider policy registry (no cost).** Add a `providerPolicy` map in `server/config`, one entry per provider and route, recording:
   - `endUserAppsAllowed` (`yes` / `unclear` / `no`)
   - `trainsOnData`
   - `minAge`
   - `termsUrl`
   - `reviewedAt`
   
   The router would use it to exclude a provider by configuration, for example "exclude routes marked `no`" or an admin switch "exclude `unclear`", without a code change. The Privacy Policy's provider list could be generated from the same data, so the documents never drift from the routing.
2. **Short term (free):** keep the current routing, as you instructed. Keep the disclosures in the Privacy Policy and Terms (done). Get counsel's reading of the Gemini sentence.
3. **If counsel reads Gemini as no consumer apps:**
   - Free path: make OpenRouter's free open-weight models the default and disable the direct Gemini route through the policy switch. Trade-off: quality and rate limits, and prompts may be used for training by the free providers.
   - Paid path, when the budget allows and **with your approval**: move Google models to **Vertex AI**, or add **Anthropic** or **OpenAI** as a primary provider. All three give a no-training default and a documented commercial basis for end-user apps.
4. **Whatever the outcome:** stop sending personal information to any **unpaid** tier whose terms advise against it, or say clearly in the app that the free models may use messages for training (the Privacy Policy now says this).

## API environments and capacity

Separate API keys do not by themselves mean separate quotas. Gemini free-tier limits apply per Google Cloud project, Cloudflare Workers AI limits per account, and OpenRouter, Tavily and SerpAPI limits per account.

Atlas AI only treats an environment as extra capacity when the provider confirms it is a different project or account and a health check passes. Each Temporary credential is also checked with a real request.

The health check needs that real request for Gemini. On 12 Nov 2026 the first Temporary Gemini key belonged to a project whose free tier was unavailable: Google listed its models but refused to generate without billing. It was replaced with a key from a project that answers on the free tier.

## Sources

- Gemini API Additional Terms of Service: https://aistudio.google.com/docs/terms (effective 23 March 2026)
- Google Cloud Service Specific Terms, section 20 Generative AI Services: https://cloud.google.com/terms/service-terms
- Google Generative AI Prohibited Use Policy: https://support.google.com/gemini/answer/16625148
- OpenRouter Terms of Service: https://openrouter.ai/terms (last updated 31 August 2026)
- OpenRouter enterprise terms: https://openrouter.ai/terms-of-service-enterprise
- Anthropic Usage Policy: https://www.anthropic.com/legal/aup
- OpenAI Business Terms: https://openai.com/policies/business-terms
- Groq legal framework: https://console.groq.com/docs/legal/contractual-framework-overview
- Mistral data use: https://help.mistral.ai/en/articles/347617-do-you-use-my-user-data-to-train-your-artificial-intelligence-models
- Cloudflare Workers AI pricing: https://developers.cloudflare.com/workers-ai/platform/pricing/
- Cloudflare Workers AI data usage: https://developers.cloudflare.com/workers-ai/platform/data-usage/ (updated 16 October 2026)
