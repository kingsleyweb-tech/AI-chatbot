/**
 * Answers that used the web show their sources under the answer (the Sources button), so a list of
 * sources the model wrote at the end ("Sources and Further Reading", "References") repeats them.
 * This removes that closing section when it is only a list of links or citations.
 */
const HEADING = /^\s*(?:#{1,6}\s*|\*\*|__)?\s*(?:sources?|references?|citations?|further reading|read more|sources?\s*(?:and|&)\s*further reading|sources?\s*(?:and|&)\s*references?|links?)\s*:?\s*(?:\*\*|__)?\s*:?\s*$/i;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/;
/** a link, a bare URL or a citation like [1] */
const REFERENCE = /\[[^\]]+\]\([^)]+\)|https?:\/\/|\[\d+\]/;

export function stripSourceList(markdown: string): string {
  const lines = markdown.split('\n');
  // the last heading-like line that names a sources section
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (HEADING.test(lines[i]!)) {
      start = i;
      break;
    }
  }
  if (start < 0) return markdown;
  const rest = lines.slice(start + 1).filter((l) => l.trim() !== '');
  // only a list (or lines) of references may follow; anything else is real content
  if (!rest.length || !rest.every((l) => (LIST_ITEM.test(l) || REFERENCE.test(l)) && REFERENCE.test(l))) return markdown;
  let end = start;
  // also drop a separator and blank lines just before it
  while (end > 0 && /^\s*(?:-{3,}|\*{3,}|_{3,})?\s*$/.test(lines[end - 1]!)) end--;
  return lines.slice(0, end).join('\n');
}
