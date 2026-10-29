import { calculateWritingStats } from './writingStats';
import { extractTocItems } from '../toc/tocService';
export { normalizeHeadingTitle } from '../toc/tocService';

export interface OutlineItem {
  id: string;
  level: 1 | 2 | 3 | 4 | 5 | 6;
  title: string;
  line: number;
}

export interface DocumentStats {
  chars: number;
  words: number;
  visibleChars: number;
  lines: number;
  headings: number;
  readingMinutes: number;
}


export function extractOutline(markdown: string): OutlineItem[] {
  return extractOutlineOnly(markdown);
}

export function calculateDocumentStats(markdown: string): DocumentStats {
  return calculateWritingStats(markdown);
}

export function analyzeMarkdown(markdown: string): { outline: OutlineItem[]; stats: DocumentStats } {
  return { outline: extractOutlineOnly(markdown), stats: calculateWritingStats(markdown) };
}

function extractOutlineOnly(markdown: string): OutlineItem[] {
  return extractTocItems(markdown);
}
