/**
 * 渲染区的 Markdown 行号。
 *
 * 语义文档与源码不是一一对应的：一个顶层块可能覆盖多行 Markdown，指令行也
 * 会折叠进块属性里。因此行号只标在顶层块上，取该块在源码中的起始行。
 * 行号用节点装饰挂到块元素上，不进入文档内容，也不进撤销历史。
 *
 * 编号与源码模式共用一套「有效行」规则：空行和指令行不占号，数字是第几条
 * 有内容的行，两个面板因此能一一对应。
 */
import type { Node as ProseMirrorNode } from 'prosemirror-model';
import { Plugin, PluginKey, type EditorState } from 'prosemirror-state';
import {
  Decoration,
  DecorationSet,
  type DecorationAttrs,
  type EditorView,
} from 'prosemirror-view';
import { getMarkdownBlockLineMap } from '../editor-core/markdown';
import { buildEffectiveLineNumbers, shouldShowSourceLineNumber } from './sourceLineNumbers';

export const semanticLineNumbersPluginKey = new PluginKey<DecorationSet>('semanticLineNumbers');

export const REBUILD_SEMANTIC_LINE_NUMBERS = 'rebuild';

/** 停止输入后再重算行号，避免每个按键都重新解析整篇 Markdown。 */
const REBUILD_DELAY_MS = 320;
/** 长文档的语义 Markdown 同步更晚（1s），行号重建必须排在它之后。 */
const LARGE_DOCUMENT_REBUILD_DELAY_MS = 1200;
const LARGE_DOCUMENT_LENGTH = 100_000;

/**
 * 这些块的 `::before` 已经被引用块/提示框/详情块的样式占用，再挂行号会互相覆盖；
 * 带自定义 NodeView 的块（表格、代码块等）也不会接收节点装饰。行号从它们旁边的
 * 普通段落继续显示即可。
 */
const SKIPPED_NODE_TYPES = new Set([
  'blockquote',
  'callout',
  'details',
  'docx_meta',
  'horizontal_rule',
]);

export interface SemanticLineNumberOptions {
  enabled: () => boolean;
  docxMode: () => boolean;
  getMarkdown: () => string;
}

/**
 * 为每个顶层块生成 `data-nomo-line` 装饰。
 *
 * 行号来自与 `revealMarkdownLine` 相同的映射：`nodeIndex` 是文档顶层子块的序号。
 */
export function buildSemanticLineNumberDecorations(
  doc: ProseMirrorNode,
  markdown: string,
  docxMode: boolean,
): DecorationSet {
  const mappings = getMarkdownBlockLineMap(markdown, { docx: docxMode });
  if (mappings.length === 0 || doc.childCount === 0) {
    return DecorationSet.empty;
  }

  const sourceLines = markdown.split(/\r?\n/);
  const effectiveNumbers = buildEffectiveLineNumbers(sourceLines, docxMode);
  const lineByNodeIndex = new Map<number, number>();
  for (const mapping of mappings) {
    if (mapping.nodeIndex < 0 || mapping.nodeIndex >= doc.childCount) continue;
    // 块从指令行或空行开始时它本身不占号（例如只由指令生成的块），交给相邻块继续。
    if (!shouldShowSourceLineNumber(sourceLines[mapping.fromLine - 1] ?? '', docxMode)) continue;
    const line = effectiveNumbers[mapping.fromLine];
    if (line) lineByNodeIndex.set(mapping.nodeIndex, line);
  }

  const decorations: Decoration[] = [];
  let offset = 0;
  doc.forEach((node, _offset, index) => {
    const line = lineByNodeIndex.get(index);
    const from = offset;
    const to = offset + node.nodeSize;
    offset = to;
    if (line === undefined || SKIPPED_NODE_TYPES.has(node.type.name)) {
      return;
    }
    const attrs: DecorationAttrs = {
      class: 'nomo-line-numbered',
      'data-nomo-line': String(line),
    };
    // 同时放进 spec，便于测试与调试读取；渲染仍以 attrs 为准。
    decorations.push(Decoration.node(from, to, attrs, { attrs }));
  });

  return DecorationSet.create(doc, decorations);
}

export function semanticLineNumbersPlugin(
  options: SemanticLineNumberOptions,
): Plugin<DecorationSet> {
  let view: EditorView | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let enabledAtState: boolean | null = null;

  const cancelRebuild = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const build = (state: EditorState) => {
    enabledAtState = options.enabled();
    if (!enabledAtState) return DecorationSet.empty;
    return buildSemanticLineNumberDecorations(
      state.doc,
      options.getMarkdown(),
      options.docxMode(),
    );
  };

  const scheduleRebuild = () => {
    cancelRebuild();
    const delay =
      options.getMarkdown().length > LARGE_DOCUMENT_LENGTH
        ? LARGE_DOCUMENT_REBUILD_DELAY_MS
        : REBUILD_DELAY_MS;
    timer = setTimeout(() => {
      timer = null;
      if (!view || view.isDestroyed) return;
      view.dispatch(view.state.tr.setMeta(semanticLineNumbersPluginKey, REBUILD_SEMANTIC_LINE_NUMBERS));
    }, delay);
  };

  return new Plugin<DecorationSet>({
    key: semanticLineNumbersPluginKey,
    state: {
      init: (_config, state) => (options.enabled() ? build(state) : DecorationSet.empty),
      apply(transaction, value, _oldState, newState) {
        if (
          transaction.getMeta(semanticLineNumbersPluginKey) === REBUILD_SEMANTIC_LINE_NUMBERS
        ) {
          return build(newState);
        }
        // 设置刚切换但尚未派发重建请求时，先跟随开关状态。
        if (options.enabled() !== enabledAtState) {
          enabledAtState = options.enabled();
          if (!enabledAtState) return DecorationSet.empty;
          scheduleRebuild();
          return DecorationSet.empty;
        }
        if (!enabledAtState) return DecorationSet.empty;
        if (!transaction.docChanged) return value;
        // 连续输入时只平移旧装饰，停手后再按最新的 Markdown 重新计算行号。
        scheduleRebuild();
        return value.map(transaction.mapping, transaction.doc);
      },
    },
    view(editorView) {
      view = editorView;
      return {
        destroy() {
          cancelRebuild();
          view = null;
        },
      };
    },
    props: {
      decorations(state) {
        return semanticLineNumbersPluginKey.getState(state) ?? null;
      },
    },
  });
}
