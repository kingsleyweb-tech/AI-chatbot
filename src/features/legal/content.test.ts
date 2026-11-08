import { describe, expect, it } from 'vitest';
import { PRIVACY, TERMS } from './content';

const CONTACT = 'kingsleyanaab99@gmail.com';
const texts = (d: typeof PRIVACY) => [d.intro, ...d.sections.flatMap((s) => [s.heading, ...(s.paragraphs ?? []), ...(s.bullets ?? [])]), ...d.toConfirm];
const outsidePlaceholders = (t: string) => t.replace(/\[(?:[^[\]]|\[[^\]]*\])*\]/g, '');

describe('legal documents', () => {
  for (const d of [PRIVACY, TERMS]) {
    it(`${d.title}: no invented contact details outside placeholders`, () => {
      for (const t of texts(d)) {
        // the only email address is the contact the owner supplied
        for (const m of outsidePlaceholders(t).match(/[\w.+-]+@[\w-]+\.\w+/g) ?? []) expect(m).toBe(CONTACT);
        expect(outsidePlaceholders(t)).not.toMatch(/\b(Ltd|Limited|LLC|Inc\.)(?=\s|$|,)|registration number/);
      }
    });
    it(`${d.title}: never claims registration, certification or compliance`, () => {
      for (const t of texts(d).filter((x) => !d.toConfirm.includes(x))) {
        expect(t).not.toMatch(/\bwe are (registered|certified|compliant)\b|\bis (registered|certified|compliant) with\b|fully compliant|we guarantee/i);
      }
    });
  }
  it('owner and contact are the details the owner supplied', () => {
    expect(JSON.stringify(PRIVACY)).toContain(`Privacy questions and requests: ${CONTACT}`);
    expect(JSON.stringify(PRIVACY)).toContain('operated by Anaab Kingsley, an individual');
    expect(JSON.stringify(TERMS)).toContain('operated by Anaab Kingsley, an individual');
    expect(JSON.stringify([PRIVACY, TERMS])).not.toContain('PRIVACY CONTACT EMAIL');
  });
  it('age and governing-law decisions are reflected', () => {
    expect(JSON.stringify(TERMS)).toContain('18 or older');
    expect(JSON.stringify(PRIVACY)).toContain('aged 18 or older');
    expect(JSON.stringify(TERMS)).toContain('laws of the Republic of Ghana');
    expect(JSON.stringify(PRIVACY)).toContain('Act 843');
  });
  it('liability, warranties, indemnity, disputes, fees and output ownership are marked for legal review', () => {
    for (const h of ['Ownership of AI-generated outputs', 'Fees', 'No warranties', 'Limitation of liability', 'Indemnity', 'Governing law and disputes']) {
      expect(TERMS.sections.find((s) => s.heading === h)?.review).toBe(true);
    }
  });
});
