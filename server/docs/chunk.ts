export interface Section {
  /** human-readable location, e.g. "p. 3", "Sheet1", "Slide 4" */
  ref: string;
  text: string;
}

export interface Chunk {
  index: number;
  ref: string;
  text: string;
}

/** ~4 characters per token is a reasonable estimate for English text. */
export const estimateTokens = (s: string) => Math.ceil(s.length / 4);

/**
 * Split sections into overlapping chunks of roughly `size` characters,
 * preferring paragraph and sentence boundaries. Each chunk keeps the
 * reference of the section it came from (first section if it spans).
 */
export function chunkSections(sections: Section[], size = 3200, overlap = 400): Chunk[] {
  const chunks: Chunk[] = [];
  for (const section of sections) {
    const text = section.text.replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    if (!text) continue;
    let start = 0;
    while (start < text.length) {
      let end = Math.min(start + size, text.length);
      if (end < text.length) {
        const window = text.slice(start, end);
        const para = window.lastIndexOf('\n\n');
        const sentence = Math.max(window.lastIndexOf('. '), window.lastIndexOf('.\n'), window.lastIndexOf('? '));
        if (para > size * 0.5) end = start + para;
        else if (sentence > size * 0.5) end = start + sentence + 1;
      }
      const piece = text.slice(start, end).trim();
      if (piece) chunks.push({ index: chunks.length, ref: section.ref, text: piece });
      if (end >= text.length) break;
      start = Math.max(end - overlap, start + 1);
    }
  }
  return chunks;
}
