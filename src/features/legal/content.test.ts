import { describe, expect, it } from 'vitest';
import { PRIVACY_VERSION, TERMS_VERSION } from '@shared/legal';
import { CONTACT_EMAIL, PRIVACY, TERMS } from './content';

const CONTACT = 'kingsleyanaab99@gmail.com';
const texts = (d: typeof PRIVACY) => [d.title, d.intro, ...d.sections.flatMap((s) => [s.heading, ...(s.paragraphs ?? []), ...(s.bullets ?? [])])];

describe('legal documents (version 1.5)', () => {
  it('both documents are version 1.5', () => {
    expect(TERMS_VERSION).toBe('1.5');
    expect(PRIVACY_VERSION).toBe('1.5');
  });

  for (const d of [PRIVACY, TERMS]) {
    it(`${d.title}: publishable, with no draft wording, placeholders or review notes`, () => {
      for (const t of texts(d)) {
        expect(t).not.toMatch(/[[\]]/);
        expect(t).not.toMatch(/\bdraft\b|for legal review|to be confirmed|placeholder|\bTODO\b|\bTBC\b/i);
      }
      expect(Object.keys(d).sort()).toEqual(['intro', 'sections', 'title']);
    });
    it(`${d.title}: no invented contact or company details`, () => {
      for (const t of texts(d)) {
        for (const m of t.match(/[\w.+-]+@[\w-]+\.\w+/g) ?? []) expect(m).toBe(CONTACT);
        expect(t).not.toMatch(/\b(Ltd|Limited|LLC|Inc\.)(?=\s|$|,)|registration number|registered company/);
      }
    });
    it(`${d.title}: never claims registration, certification, compliance or legal review`, () => {
      for (const t of texts(d)) {
        expect(t).not.toMatch(/\bwe are (registered|certified|compliant)\b|\bis (registered|certified|compliant) with\b|fully compliant|GDPR[- ]compliant|we guarantee|reviewed by a lawyer|arbitration/i);
      }
    });
    it(`${d.title}: never promises a guaranteed response deadline`, () => {
      for (const t of texts(d)) expect(t).not.toMatch(/we will (respond|reply) within/i);
    });
  }

  it('owner and contact are the details the owner supplied', () => {
    expect(CONTACT_EMAIL).toBe(CONTACT);
    expect(JSON.stringify(PRIVACY)).toContain(`Privacy questions and requests: ${CONTACT}`);
    expect(JSON.stringify(PRIVACY)).toContain('operated by Anaab Kingsley, an individual');
    expect(JSON.stringify(TERMS)).toContain('operated by Anaab Kingsley, an individual');
  });

  it('age, governing law and data protection rights are reflected', () => {
    expect(JSON.stringify(TERMS)).toContain('18 or older');
    expect(JSON.stringify(PRIVACY)).toContain('aged 18 or older');
    expect(JSON.stringify(TERMS)).toContain('laws of the Republic of Ghana');
    expect(JSON.stringify(TERMS)).toContain('courts of Ghana');
    expect(JSON.stringify(PRIVACY)).toContain('Act 843');
    expect(JSON.stringify(PRIVACY)).toContain('Data Protection Commission');
  });

  it('the Terms keep every section, with balanced liability wording and no cap amount', () => {
    const headings = TERMS.sections.map((s) => s.heading);
    for (const h of ['Ownership of AI-generated outputs', 'Fees', 'No warranties', 'Limitation of liability', 'Indemnity', 'Governing law and disputes', 'Third-party AI services']) {
      expect(headings).toContain(h);
    }
    const t = JSON.stringify(TERMS);
    expect(t).toContain('cannot be excluded or limited under the law that applies');
    expect(t).not.toMatch(/GH₵|GHS|cedis?\b|US\$|\$\d/);
    expect(t).toContain('Ghana (+233) numbers');
  });

  it('retention, response time, analytics consent and providers match the implementation', () => {
    const p = JSON.stringify(PRIVACY);
    expect(p).toContain('deleted automatically 30 days after the account is permanently deleted');
    expect(p).toContain('We aim to reply within 24 hours');
    expect(p).toContain('Google Analytics for Firebase is off unless you allow it');
    expect(p).toContain('no longer than 14 months');
    expect(p).toContain('kept for 1 hour');
    expect(p).toContain('Google Gemini is the primary provider and OpenRouter is an additional provider');
    expect(p).toContain('terms for unpaid services apply');
    expect(p).toContain('model providers have their own policies');
    expect(p).not.toMatch(/Vertex|Anthropic|OpenAI/);
    // PPTX images are not stored: only extracted text is
    expect(p).not.toMatch(/embedded images|images from (slides|presentations)/i);
  });

  it('describes the Cloudflare Workers AI image integration as implemented', () => {
    const p = JSON.stringify(PRIVACY);
    const t = JSON.stringify(TERMS);
    const both = JSON.stringify([PRIVACY, TERMS]);
    expect(both).not.toMatch(/does not generate or edit images/i);
    expect(p).toContain('Google (Gemini), OpenRouter, Cloudflare (Workers AI) and ElevenLabs are third-party AI providers');
    expect(p).toContain('ElevenLabs voice: if an administrator has made it available');
    expect(p).toContain('https://elevenlabs.io/privacy-policy');
    expect(p).toContain('never in place of Gemini or OpenRouter');
    expect(p).toContain('first to a safety model');
    expect(p).toContain('To edit an image, the image is sent as well');
    expect(p).toContain('does not use content processed by Workers AI to train AI models');
    expect(p).toContain('https://developers.cloudflare.com/workers-ai/platform/data-usage/');
    expect(p).toContain('until you delete the image in Images, delete the conversation it was created in, or your account is deleted');
    expect(p).toContain('in its original quality, with its Download button');
    expect(p).toContain('Images Atlas AI created can be read and deleted only by your account');
    expect(t).toContain('Cloudflare (Workers AI)');
    expect(t).toContain('Atlas AI can create an image, or edit one, when you ask');
    expect(t).toContain('deepfakes, face swaps or fake photos of a real person');
    expect(t).toContain('does not switch to paid usage');
    // no invented retention period or guarantee for Cloudflare
    expect(both).not.toMatch(/Cloudflare (deletes|keeps)[^.]*\b\d+ (days|hours)/i);
  });

  it('describes Atlas AI as general purpose, never as professional-only', () => {
    const t = JSON.stringify(TERMS);
    expect(t).toContain('general-purpose AI assistant for personal and professional use');
    expect(JSON.stringify([PRIVACY, TERMS])).not.toMatch(/professional (use )?only|exclusively (for )?professional|only for professional/i);
  });
});
