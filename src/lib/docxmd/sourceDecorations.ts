/**
 * 源码模式下的 `.docx.md` 高亮。
 *
 * 高亮只读源码，不改变 CodeMirror 文档内容；装饰按视口切片生成，
 * 大文件不会因为每帧扫描全文而卡顿。指令行只做高亮，不提供折叠入口，
 * 因此源码行号与正文之间不会多出一列折叠按钮。
 */
import type { Extension } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import { parseDirectiveLine } from './directiveGrammar';
import { parseInlineMarker } from './inlineMarkers';
import { KNOWN_KEYWORDS } from './directiveRegistry';

export interface DocxSourceHighlight {
  from: number;
  to: number;
  /** 行级装饰的类名；与 markClass 二选一。 */
  lineClass?: string;
  /** 行内范围装饰的类名。 */
  markClass?: string;
  /** `[[...]]` 的标记类型，用于调试与样式扩展。 */
  kind?: string;
}

const DIRECTIVE_LINE_RE = /^\s*<!--[\s\S]*-->\s*$/;
const UNCLOSED_DIRECTIVE_RE = /^\s*<!--/;

function looksLikeDirectiveComment(line: string): boolean {
  const trimmed = line.trim();
  const start = trimmed.indexOf('<!--');
  if (start < 0) return false;
  const inner = trimmed.slice(start + 4, trimmed.endsWith('-->') ? -3 : undefined).trim();
  const head = /^(@?[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)/.exec(inner)?.[1];
  if (!head) return false;
  return head.startsWith('@') || head.startsWith('global.') || KNOWN_KEYWORDS.has(head);
}

/** 该行是否是完整、可解析的 docx 指令行。 */
export function isDocxDirectiveSourceLine(line: string): boolean {
  return DIRECTIVE_LINE_RE.test(line) && parseDirectiveLine(line) !== null;
}

/** 看起来像指令但解析失败的行（例如未闭合的 `<!--`）；同样按指令处理。 */
export function isInvalidDirectiveSourceLine(line: string): boolean {
  if (isDocxDirectiveSourceLine(line)) return false;
  if (UNCLOSED_DIRECTIVE_RE.test(line)) return looksLikeDirectiveComment(line);
  return DIRECTIVE_LINE_RE.test(line) && looksLikeDirectiveComment(line);
}

function isInsideCodeSpan(line: string, position: number): boolean {
  let ticks = 0;
  for (let index = 0; index < position; index += 1) {
    if (line[index] === '`') ticks += 1;
  }
  return ticks % 2 === 1;
}

/**
 * 收集一段源码中的高亮范围。
 *
 * @param text 待扫描的源码片段。
 * @param base 片段在完整文档中的起始偏移；装饰范围必须使用完整文档坐标。
 */
export function collectDocxSourceHighlights(text: string, base = 0): DocxSourceHighlight[] {
  const highlights: DocxSourceHighlight[] = [];
  let fence: string | null = null;
  let lineStart = 0;
  while (lineStart <= text.length) {
    const newline = text.indexOf('\n', lineStart);
    const lineEnd = newline < 0 ? text.length : newline;
    const line = text.slice(lineStart, lineEnd);
    const absoluteStart = base + lineStart;
    const absoluteEnd = base + lineEnd;

    const fenceMatch = /^\s*(```+|~~~+)/.exec(line);
    if (fenceMatch) {
      if (!fence) fence = fenceMatch[1]![0]!;
      else if (fence === fenceMatch[1]![0]) fence = null;
      if (newline < 0) break;
      lineStart = newline + 1;
      continue;
    }
    if (fence) {
      if (newline < 0) break;
      lineStart = newline + 1;
      continue;
    }

    if (isDocxDirectiveSourceLine(line)) {
      highlights.push({
        from: absoluteStart,
        to: absoluteStart,
        lineClass: 'docx-source-directive',
      });
    } else if (isInvalidDirectiveSourceLine(line)) {
      highlights.push({
        from: absoluteStart,
        to: absoluteStart,
        lineClass: 'docx-source-directive-invalid',
      });
    } else if (line.includes('[[')) {
      const token = /\[\[([^\]\n]*)(\]\])?/g;
      let match: RegExpExecArray | null;
      while ((match = token.exec(line)) !== null) {
        if (isInsideCodeSpan(line, match.index)) continue;
        const from = absoluteStart + match.index;
        if (!match[2]) {
          highlights.push({
            from,
            to: absoluteEnd,
            markClass: 'docx-source-inline-marker-invalid',
          });
          break;
        }
        const marker = parseInlineMarker(match[1] ?? '');
        highlights.push({
          from,
          to: absoluteStart + match.index + match[0].length,
          markClass: marker ? 'docx-source-inline-marker' : 'docx-source-inline-marker-invalid',
          ...(marker ? { kind: marker.kind } : {}),
        });
      }
    }

    if (newline < 0) break;
    lineStart = newline + 1;
  }
  return highlights;
}

const lineDecorationCache = new Map<string, Decoration>();
function lineDecoration(className: string): Decoration {
  let decoration = lineDecorationCache.get(className);
  if (!decoration) {
    decoration = Decoration.line({ attributes: { class: className } });
    lineDecorationCache.set(className, decoration);
  }
  return decoration;
}

const markDecorationCache = new Map<string, Decoration>();
function markDecoration(className: string, kind?: string): Decoration {
  const key = `${className}|${kind ?? ''}`;
  let decoration = markDecorationCache.get(key);
  if (!decoration) {
    decoration = Decoration.mark({
      class: className,
      ...(kind ? { attributes: { 'data-docx-kind': kind } } : {}),
    });
    markDecorationCache.set(key, decoration);
  }
  return decoration;
}

function buildDecorations(view: EditorView): DecorationSet {
  if (view.visibleRanges.length === 0) return Decoration.none;
  const first = view.state.doc.lineAt(view.visibleRanges[0]!.from);
  const lastRange = view.visibleRanges[view.visibleRanges.length - 1]!;
  const last = view.state.doc.lineAt(lastRange.to);
  const text = view.state.doc.sliceString(first.from, last.to);
  const highlights = collectDocxSourceHighlights(text, first.from);
  return Decoration.set(
    highlights.map((highlight) =>
      highlight.lineClass
        ? lineDecoration(highlight.lineClass).range(highlight.from)
        : markDecoration(highlight.markClass!, highlight.kind).range(highlight.from, highlight.to),
    ),
    true,
  );
}

const docxSourceHighlighter = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }

    update(update: ViewUpdate): void {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

const docxSourceTheme = EditorView.theme({
  '.cm-gutters': {
    borderRight: '1px solid color-mix(in srgb, var(--md-editor-border) 55%, transparent)',
    backgroundColor: 'transparent',
    color: 'var(--md-editor-muted-fg)',
  },
});

/** 源码模式扩展；只在 `.docx.md` 的源码编辑器上挂载。 */
export function docxSourceHighlighting(): Extension {
  return [docxSourceHighlighter, docxSourceTheme];
}
