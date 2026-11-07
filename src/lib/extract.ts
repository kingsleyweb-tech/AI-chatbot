/**
 * In-browser text extraction for uploaded documents. Libraries are loaded
 * lazily so they never weigh on the initial bundle.
 */
export interface ExtractedSection {
  ref: string;
  text: string;
}

export interface ExtractResult {
  sections: ExtractedSection[];
  pageCount?: number;
  warning?: string;
}

export const MAX_DOC_BYTES = 25 * 1024 * 1024;

export const DOC_ACCEPT = [
  '.pdf',
  '.docx',
  '.txt',
  '.md',
  '.csv',
  '.tsv',
  '.json',
  '.xlsx',
  '.xls',
  '.pptx',
  '.html',
  '.htm',
].join(',');

export type DocKind = 'pdf' | 'docx' | 'text' | 'csv' | 'xlsx' | 'pptx' | 'html' | 'unsupported';

export function detectKind(file: File): DocKind {
  const name = file.name.toLowerCase();
  const ext = name.split('.').pop() ?? '';
  if (ext === 'pdf' || file.type === 'application/pdf') return 'pdf';
  if (ext === 'docx') return 'docx';
  if (ext === 'xlsx' || ext === 'xls') return 'xlsx';
  if (ext === 'pptx') return 'pptx';
  if (ext === 'csv' || ext === 'tsv') return 'csv';
  if (ext === 'html' || ext === 'htm') return 'html';
  if (['txt', 'md', 'json', 'log', 'xml', 'yaml', 'yml'].includes(ext) || file.type.startsWith('text/')) return 'text';
  if (ext === 'doc' || ext === 'ppt') return 'unsupported';
  return 'unsupported';
}

export async function extractText(file: File): Promise<ExtractResult> {
  if (file.size > MAX_DOC_BYTES) throw new Error('Files must be 25 MB or smaller.');
  const kind = detectKind(file);
  switch (kind) {
    case 'pdf':
      return extractPdf(file);
    case 'docx':
      return extractDocx(file);
    case 'xlsx':
    case 'csv':
      return extractSheet(file);
    case 'pptx':
      return extractPptx(file);
    case 'html': {
      const html = await file.text();
      const doc = new DOMParser().parseFromString(html, 'text/html');
      return { sections: [{ ref: 'Page', text: doc.body?.innerText ?? doc.body?.textContent ?? '' }] };
    }
    case 'text':
      return { sections: [{ ref: 'Text', text: await file.text() }] };
    default:
      throw new Error('This file type is not supported. Use PDF, DOCX, TXT, CSV, XLSX or PPTX (legacy .doc/.ppt are not supported).');
  }
}

async function extractPdf(file: File): Promise<ExtractResult> {
  const pdfjs = await import('pdfjs-dist');
  const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  const pdf = await task.promise;
  const sections: ExtractedSection[] = [];
  let emptyPages = 0;
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    let text = '';
    for (const item of content.items) {
      if ('str' in item) text += item.str + (item.hasEOL ? '\n' : ' ');
    }
    text = text.replace(/[ \t]+/g, ' ').trim();
    if (text.length < 20) emptyPages++;
    if (text) sections.push({ ref: `p. ${i}`, text });
  }
  const pageCount = pdf.numPages;
  await task.destroy();
  const scanned = emptyPages / Math.max(pageCount, 1) > 0.6;
  if (!sections.length || scanned) {
    if (!sections.length) {
      throw new Error('No selectable text found. This looks like a scanned PDF; OCR is not configured, so it cannot be read yet.');
    }
    return { sections, pageCount, warning: 'Most pages contain no selectable text (likely scanned). Only partial text was extracted; OCR is not configured.' };
  }
  return { sections, pageCount };
}

async function extractDocx(file: File): Promise<ExtractResult> {
  const mammoth = await import('mammoth');
  const { value } = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
  return { sections: [{ ref: 'Document', text: value }] };
}

async function extractSheet(file: File): Promise<ExtractResult> {
  const XLSX = await import('xlsx');
  const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
  const sections = wb.SheetNames.map((name) => ({
    ref: wb.SheetNames.length > 1 || file.name.toLowerCase().endsWith('x') ? `Sheet "${name}"` : 'Table',
    text: XLSX.utils.sheet_to_csv(wb.Sheets[name], { blankrows: false }),
  })).filter((s) => s.text.trim());
  return { sections };
}

async function extractPptx(file: File): Promise<ExtractResult> {
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const slides = Object.keys(zip.files)
    .filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p))
    .sort((a, b) => Number(a.match(/\d+/g)!.pop()) - Number(b.match(/\d+/g)!.pop()));
  const sections: ExtractedSection[] = [];
  for (const path of slides) {
    const xml = await zip.files[path].async('string');
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    const paras = Array.from(doc.getElementsByTagName('a:p')).map((p) =>
      Array.from(p.getElementsByTagName('a:t'))
        .map((t) => t.textContent ?? '')
        .join(''),
    );
    const text = paras.filter(Boolean).join('\n');
    const n = path.match(/\d+/g)!.pop();
    if (text.trim()) sections.push({ ref: `Slide ${n}`, text });
  }
  return { sections, pageCount: slides.length };
}
