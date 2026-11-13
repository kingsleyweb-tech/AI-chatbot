import { describe, expect, it } from 'vitest';
import { READY_TEMPLATES, TEMPLATE_CATEGORIES, unfilled } from './messageTemplates';

/** GSM 03.38 basic characters: anything else makes a text Unicode (70 characters per SMS). */
const GSM = /^[@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&'()*+,\-./0-9:;<=>?¡A-ZÄÖÑÜ§¿a-zäöñüà]*$/;

describe('ready-made message templates', () => {
  it('have unique ids and a known category of the same kind', () => {
    expect(new Set(READY_TEMPLATES.map((t) => t.id)).size).toBe(READY_TEMPLATES.length);
    for (const t of READY_TEMPLATES) {
      const c = TEMPLATE_CATEGORIES.find((x) => x.id === t.category);
      expect(c, t.id).toBeDefined();
      expect(c!.kind, t.id).toBe(t.kind);
    }
    for (const c of TEMPLATE_CATEGORIES) expect(READY_TEMPLATES.some((t) => t.category === c.id), c.id).toBe(true);
  });

  it('every text fits one SMS with the "Atlas AI: " prefix and uses plain SMS characters', () => {
    for (const t of READY_TEMPLATES) {
      const text = /^atlas ai\b/i.test(t.sms) ? t.sms : `Atlas AI: ${t.sms}`;
      // {name} becomes a first name of up to 40 characters; allow a typical 10
      expect(text.replace('{name}', 'Abena-Mary').length, t.id).toBeLessThanOrEqual(160);
      // {name} and [fill-in] parts are replaced before sending
      const sent = t.sms.replace('{name}', 'Ama').replace(/\[[^\]]*\]/g, 'x');
      expect(GSM.test(sent), `${t.id} has a non-SMS character`).toBe(true);
    }
  });

  it('every email has a subject and a body, and only names places that exist', () => {
    for (const t of READY_TEMPLATES) {
      expect(t.subject.trim(), t.id).not.toBe('');
      expect(t.body.trim(), t.id).not.toBe('');
      expect(`${t.sms} ${t.body}`, t.id).not.toMatch(/Help & support/);
    }
  });

  it('finds the parts that still need filling in', () => {
    expect(unfilled('Reason: [write the reason here]', 'Hi {name}')).toEqual(['[write the reason here]']);
    expect(unfilled('All done.')).toEqual([]);
  });
});
