/**
 * `.docx.md` 预览预处理。
 *
 * Quick Look 和大文件预览共用：先把指令注释、成对行内标记和原始 DrawingML
 * 从 Markdown 中剥离，再交给现有 sanitizer/markdown-it 渲染。这里只处理文本，
 * 不信任任何内嵌 OOXML，也不生成可执行的 HTML。
 */
import { parseDirectiveLine } from './directiveGrammar';
import { parseInlineMarker } from './inlineMarkers';
import { KNOWN_KEYWORDS } from './directiveRegistry';

const INLINE_MARKER_RE = /\[\[([^\]\n]*)\]\]/g;
const RAW_DRAWING_BLOCKS: RegExp[] = [
  /<w:drawing\b[\s\S]*?<\/w:drawing>/gi,
  /<w:pict\b[\s\S]*?<\/w:pict>/gi,
  /<v:shape\b[\s\S]*?<\/v:shape>/gi,
  /<v:group\b[\s\S]*?<\/v:group>/gi,
  /<o:OLEObject\b[\s\S]*?<\/o:OLEObject>/gi,
];
const RAW_NAMESPACE_TAGS =
  /<\/?(?:w|v|o|wp|a|m|pic|r|wps|wpg|mc):[A-Za-z][^>]*>/g;
const PAIRED_OPEN_RE =
  /\[\[\s*(?:NEW|CMT|TBL|FIG|EQ|REF|INS|DEL)\b[^\]\n]*\]\]/gi;
const PAIRED_CLOSE_RE = /\[\[\s*\/\s*(?:NEW|CMT|TBL|FIG|EQ|REF|INS|DEL)\s*\]\]/gi;
const DELETED_RANGE_RE =
  /\[\[\s*DEL\b[^\]\n]*\]\][\s\S]*?\[\[\s*\/\s*DEL\s*\]\]/gi;

function stripDrawingMarkup(text: string): string {
  let output = text;
  for (const pattern of RAW_DRAWING_BLOCKS) output = output.replace(pattern, '');
  return output.replace(RAW_NAMESPACE_TAGS, '');
}

function looksLikeDirectiveComment(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.startsWith('<!--')) return false;
  const inner = trimmed
    .slice(4, trimmed.endsWith('-->') ? -3 : undefined)
    .trim();
  const head = /^(@?[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)/.exec(inner)?.[1];
  if (!head) return false;
  return head.startsWith('@') || head.startsWith('global.') || KNOWN_KEYWORDS.has(head);
}

function stripDirectiveLines(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      if (parseDirectiveLine(line)) return '';
      // 未闭合或写坏的指令注释也不能原样进入预览。
      return looksLikeDirectiveComment(line) ? '' : line;
    })
    .join('\n');
}

function replacePointAnchors(text: string): string {
  return text
    .replace(/\[\[\s*SLOT\s+([^\]\n]*?)\s*\]\]/gi, (_match, name: string) =>
      name.replace(/^["']|["']$/g, ''),
    )
    .replace(/\[\[\s*BR\s*\]\]/gi, '<br>')
    .replace(/\[\[\s*TAB\s*\]\]/gi, '    ')
    .replace(/\[\[\s*FN\b[^\]\n]*\]\]/gi, '<sup class="docx-preview-note">注</sup>')
    .replace(/\[\[\s*EN\b[^\]\n]*\]\]/gi, '<sup class="docx-preview-note">尾</sup>');
}

/**
 * 将 `.docx.md` 源文转换成只含可见内容的 Markdown。
 *
 * 成对标记只去掉边界，保留其中正文；`DEL` 范围连同正文一起删除。
 */
export function prepareDocxPreviewMarkdown(markdown: string): string {
  let output = stripDrawingMarkup(markdown);
  output = stripDirectiveLines(output);
  output = output.replace(DELETED_RANGE_RE, '');
  output = replacePointAnchors(output);
  output = output.replace(PAIRED_OPEN_RE, '').replace(PAIRED_CLOSE_RE, '');
  // 未知、未闭合的行内标记同样不能以原始 [[...]] 出现在预览里。
  output = output.replace(INLINE_MARKER_RE, '');
  return output.replace(/\[\[/g, '');
}

/** 内容/文件名是否足够像 `.docx.md`；普通 Markdown 不会被预处理。 */
export function isDocxMarkdownSource(markdown: string, fileName?: string): boolean {
  if (fileName && /\.docx\.md$/i.test(fileName.trim())) return true;
  let directiveCount = 0;
  let markerCount = 0;
  for (const line of markdown.split('\n')) {
    if (parseDirectiveLine(line)) directiveCount += 1;
    if (!line.includes('[[')) continue;
    for (const match of line.matchAll(INLINE_MARKER_RE)) {
      if (parseInlineMarker(match[1] ?? '')) markerCount += 1;
    }
  }
  return directiveCount > 0 || markerCount >= 2;
}
