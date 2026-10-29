/**
 * `.docx.md` 专用 markdown-it / ProseMirror 解析器。
 *
 * 普通 `.md` 继续使用 `editor-core/markdown.ts` 里的实例；这里额外安装
 * 单行指令块规则与 token 绑定，并把结构指令转换成隐藏的 `docx_meta` 节点。
 */
import type MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';
import {
  createMarkdownTokenizer,
  type MarkdownBlockRuleState,
} from '../editor-core/markdownTokenizer';
import {
  createSemanticMarkdownParser,
  type HtmlMarkdownParseState,
  type SemanticMarkdownParser,
} from '../editor-core/markdownParserFactory';
import { schema } from '../editor-core/schema';
import { parseDirectiveLine } from './directiveGrammar';
import { transformDocxTokens } from './tokenStream';
import {
  docxInlineRule,
  parseInlineMarker,
  type ParsedDocxInlineMarker,
} from './inlineMarkers';
import type { ParsedDocxDirective } from './model';

interface DocxDirectiveState extends MarkdownBlockRuleState {
  line: number;
}

const SINGLE_LINE_COMMENT = /^\s*<!--[\s\S]*-->\s*$/;

/**
 * 单行 HTML 注释 → docx_directive token。
 *
 * 只吞掉关键字已知的注释；普通注释继续交给 `html_block`，保持原有
 * comment chip 行为。规则注册在 `html_block` 之前。
 */
function docxDirectiveRule(
  state: DocxDirectiveState,
  startLine: number,
  _endLine: number,
  silent: boolean,
): boolean {
  const indent = state.sCount[startLine] ?? 0;
  if (indent - state.blkIndent >= 4) return false;
  const start = (state.bMarks[startLine] ?? 0) + (state.tShift[startLine] ?? 0);
  const end = state.eMarks[startLine] ?? start;
  const line = state.src.slice(start, end).replace(/\r$/, '');
  if (!SINGLE_LINE_COMMENT.test(line)) return false;
  const directive = parseDirectiveLine(line);
  if (!directive) return false;
  if (silent) return true;

  const token = state.push('docx_directive', 'div', 0);
  token.content = directive.content;
  token.map = [startLine, startLine + 1];
  token.meta = { docxDirective: directive, docxRaw: line };
  state.line = startLine + 1;
  return true;
}

let cached: SemanticMarkdownParser | null = null;
let cachedTokenizer: MarkdownIt | null = null;

function createDocxSemanticParser(): SemanticMarkdownParser {
  const tokenizer = createMarkdownTokenizer({
    inlineSource: true,
    docxInlineMarkers: true,
    docxExtendedHeadings: true,
    transformTokens: transformDocxTokens,
    docxDirectiveRule: docxDirectiveRule as unknown as (
      state: MarkdownBlockRuleState,
      startLine: number,
      endLine: number,
      silent: boolean,
    ) => boolean,
  });
  // 必须早于 link：否则 `[[NEW ...]]` 会被当成普通链接标签扫描。
  tokenizer.inline.ruler.before(
    'link',
    'docx_inline_marker',
    docxInlineRule as unknown as Parameters<typeof tokenizer.inline.ruler.before>[2],
  );
  const semantic = createSemanticMarkdownParser(tokenizer);
  installDocxTokenHandlers(semantic);
  cachedTokenizer = tokenizer;
  return semantic;
}

function installDocxTokenHandlers(semantic: SemanticMarkdownParser): void {
  const parser = semantic.parser;

  semantic.addTokenHandler('docx_meta', (state, token) => {
    const rawLines = (token.meta?.docxMetaLines as string[] | undefined) ?? [];
    state.addNode(schema.nodes.docx_meta, {
      rawLines,
      metaKind: token.meta?.docxMetaKind ?? 'mixed',
      sectionIndex: token.meta?.docxSectionIndex ?? null,
    });
  });

  // 容器内部没有参与顶层绑定的指令行仍然是隐藏 meta 节点，绝不丢失原文。
  semantic.addTokenHandler('docx_directive', (state, token) => {
    const directive = token.meta?.docxDirective as ParsedDocxDirective | undefined;
    const raw = directive?.raw ?? (token.meta?.docxRaw as string | undefined) ?? token.content;
    state.addNode(schema.nodes.docx_meta, { rawLines: [raw], metaKind: 'mixed' });
  });

  // 行内标记：开闭边界与点原子都保存完整原文，正文仍是普通可编辑行内内容。
  const markerAttrs = (token: Token, marker: ParsedDocxInlineMarker, valid: boolean) => ({
    kind: marker.kind,
    raw: marker.raw,
    inner: marker.inner,
    groups: marker.groups,
    name: marker.name,
    content: marker.content,
    ...(token.type === 'docx_inline_atom'
      ? {
          author: marker.author,
          initials: marker.initials,
          status: marker.status,
          date: marker.date,
          valid,
        }
      : {}),
  });
  const readMarker = (token: Token): ParsedDocxInlineMarker | null =>
    (token.meta?.docxInlineMarker as ParsedDocxInlineMarker | undefined) ??
    parseInlineMarker(token.content.replace(/^\[\[|\]\]$/g, ''));
  semantic.addTokenHandler('docx_inline_open', (state, token) => {
    const marker = readMarker(token);
    if (!marker) {
      state.addText(token.content);
      return;
    }
    state.addNode(schema.nodes.docx_inline_open, markerAttrs(token, marker, true));
  });
  semantic.addTokenHandler('docx_inline_close', (state, token) => {
    const marker = readMarker(token);
    if (!marker) {
      state.addText(token.content);
      return;
    }
    state.addNode(schema.nodes.docx_inline_close, markerAttrs(token, marker, true));
  });
  semantic.addTokenHandler('docx_inline_atom', (state, token) => {
    const marker = readMarker(token);
    if (!marker) {
      state.addText(token.content);
      return;
    }
    state.addNode(
      schema.nodes.docx_inline_atom,
      markerAttrs(token, marker, token.meta?.docxInlineValid !== false),
    );
  });

  // 把 docxPrefix 加到本 token 创建的第一个块节点上。token handler 的
  // openNode/addNode 参数是唯一能同时覆盖段落、标题、列表、表格和代码块的入口。
  // prosemirror 实际会传入 tokens/index（getAttrs 依赖），工厂类型只声明了前两个参数。
  type WideTokenHandler = (
    state: HtmlMarkdownParseState,
    token: Token,
    tokens: Token[],
    index: number,
  ) => void;
  const handlers = parser.tokenHandlers as unknown as Record<string, WideTokenHandler>;
  for (const type of Object.keys(handlers)) {
    if (type === 'docx_meta' || type === 'docx_directive') continue;
    const original = handlers[type]!;
    handlers[type] = (state, token, tokens, index) => {
      const prefix = token.meta?.docxPrefix as string[] | undefined;
      if (!prefix?.length) {
        original(state, token, tokens, index);
        return;
      }
      // 必须绑定 this：解析状态的 openNode/addNode 依赖实例上的 stack。
      const openNode = state.openNode.bind(state);
      const addNode = state.addNode.bind(state);
      let applied = false;
      const withPrefix = (attrs: unknown) => {
        if (applied) return attrs;
        applied = true;
        return { ...((attrs as Record<string, unknown> | null) ?? {}), docxPrefix: prefix };
      };
      state.openNode = (nodeType, attrs) => openNode(nodeType, withPrefix(attrs));
      state.addNode = (nodeType, attrs, content) => addNode(nodeType, withPrefix(attrs), content);
      try {
        original(state, token, tokens, index);
      } finally {
        state.openNode = openNode;
        state.addNode = addNode;
      }
    };
  }
}

export function getDocxSemanticParser(): SemanticMarkdownParser {
  cached ??= createDocxSemanticParser();
  return cached;
}

export function getDocxMarkdownIt(): MarkdownIt {
  getDocxSemanticParser();
  return cachedTokenizer!;
}

/** 仅测试使用：丢弃缓存，验证懒初始化与模式切换。 */
export function resetDocxParserCachesForTests(): void {
  cached = null;
  cachedTokenizer = null;
}
