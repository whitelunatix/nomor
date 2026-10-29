/** Callout 解析：Token 后处理 + parser token mapping */

import Token from 'markdown-it/lib/token.mjs';
import type { CalloutType } from './calloutTypes';

// 匹配行首 [!TYPE] 标记，后面可以跟换行或其他内容
const CALLOUT_MARKER_RE = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/;

/** 支持的 callout 类型集合（小写） */
const VALID_TYPES = new Set(['note', 'tip', 'important', 'warning', 'caution']);

/**
 * 在 markdown-it 的 token 流中检测 blockquote 内的 [!TYPE] 标记，
 * 将匹配的 blockquote 改写为 callout_open/close，并从内容中剥离标记行。
 *
 * 直接修改传入的 tokens 数组（in-place）。
 */
export function transformCalloutTokens(tokens: Token[]): void {
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];

    // 只处理 blockquote_open
    if (tok.type !== 'blockquote_open') {
      i++;
      continue;
    }

    // 找到对应的 blockquote_close
    const openIdx = i;
    let closeIdx = -1;
    let depth = 1;
    for (let j = openIdx + 1; j < tokens.length; j++) {
      if (tokens[j].type === 'blockquote_open') depth++;
      if (tokens[j].type === 'blockquote_close') {
        depth--;
        if (depth === 0) {
          closeIdx = j;
          break;
        }
      }
    }

    if (closeIdx === -1) {
      i++;
      continue;
    }

    // 标记只能位于当前引用的首个直接段落，列表、后段和嵌套引用不能提升外层。
    const paraOpenIdx = openIdx + 1;
    const paraOpenTok = tokens[paraOpenIdx];
    const inlineTok = tokens[paraOpenIdx + 1];
    if (
      paraOpenTok?.type !== 'paragraph_open' ||
      paraOpenTok.level !== tok.level + 1 ||
      inlineTok?.type !== 'inline'
    ) {
      i++;
      continue;
    }

    // 检查 inline 内容是否以 [!TYPE] 开头
    const match = inlineTok.content.match(CALLOUT_MARKER_RE);
    if (!match) {
      i++;
      continue;
    }

    const calloutType = match[1].toLowerCase() as CalloutType;
    if (!VALID_TYPES.has(calloutType)) {
      i++;
      continue;
    }

    // --- 匹配成功，开始改写 tokens ---

    // 1. 将 blockquote_open 改为 callout_open，保存 type
    tok.type = 'callout_open';
    tok.tag = 'div';
    tok.nesting = 1;
    tok.meta = { calloutType };
    tok.attrSet('class', 'callout-card');
    tok.attrSet('data-callout-type', calloutType);

    // 2. 将 blockquote_close 改为 callout_close
    const closeTok = tokens[closeIdx];
    closeTok.type = 'callout_close';
    closeTok.tag = 'div';
    closeTok.nesting = -1;
    closeTok.meta = { calloutType };

    // 3. 从 inline token 中剥离 [!TYPE] 标记行
    //    markdown-it 会把 blockquote 内多行内容合并到一个 inline token
    //    content 形如 "[!NOTE]\n这是内容"，children 形如 [text("[!NOTE]"), softbreak, text("这是内容")]
    stripCalloutMarker(inlineTok);

    // 如果剥离后 inline 内容为空，且是唯一段落，则移除整个段落 token 组
    if (inlineTok.content.trim() === '' && inlineTok.children?.length === 0) {
      const removeStart = paraOpenIdx;
      tokens.splice(removeStart, 3); // 移除 paragraph_open, inline, paragraph_close

      // 如果移除后 callout 内部为空，插入一个空段落
      const newCloseIdx = tokens.indexOf(closeTok);
      if (newCloseIdx === openIdx + 1) {
        const emptyParaOpen = new Token('paragraph_open', 'p', 1);
        emptyParaOpen.block = true;
        const emptyInline = new Token('inline', '', 0);
        emptyInline.content = '';
        emptyInline.children = [];
        const emptyParaClose = new Token('paragraph_close', 'p', -1);
        emptyParaClose.block = true;
        tokens.splice(openIdx + 1, 0, emptyParaOpen, emptyInline, emptyParaClose);
      }
    }

    // 内层引用按自己的首段独立识别，不能借其标记改写外层。
    i = openIdx + 1;
  }
}

/**
 * 从 inline token 中剥离 [!TYPE] 标记行。
 * 处理两种情况：
 * 1. 整行只有 [!TYPE]：清空 children 和 content
 * 2. [!TYPE] 后面有其他内容：移除 [!TYPE] 文本节点和紧跟的 softbreak
 */
function stripCalloutMarker(inlineTok: Token): void {
  const markerPattern = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/;

  // 从 children 中查找并移除 [!TYPE] 标记
  const children = inlineTok.children ?? [];
  let markerIdx = -1;

  for (let j = 0; j < children.length; j++) {
    const child = children[j];
    if (child.type === 'text' && markerPattern.test(child.content)) {
      markerIdx = j;
      break;
    }
  }

  if (markerIdx === -1) return;

  // 检查 [!TYPE] 文本节点的内容
  const markerChild = children[markerIdx];
  const markerMatch = markerChild.content.match(markerPattern);

  if (markerChild.content.length > markerMatch![0].length) {
    // 文本节点包含 [!TYPE] 和后续文本（如 "[!NOTE]这是内容"）
    // 只剥离 [!TYPE] 部分
    markerChild.content = markerChild.content.slice(markerMatch![0].length);
  } else {
    // 整个文本节点就是 [!TYPE]，移除它和紧跟的 softbreak/换行
    children.splice(markerIdx, 1);
    // 如果下一个节点是 softbreak，也移除
    if (markerIdx < children.length && children[markerIdx]?.type === 'softbreak') {
      children.splice(markerIdx, 1);
    }
  }

  // 重新构建 content
  inlineTok.children = children;
  inlineTok.content = children.map((c) => c.content ?? (c.type === 'softbreak' ? '\n' : '')).join('');
}

/**
 * callout parser token mapping（注册到 MarkdownParser）。
 * 注意：callout_open/close 由 transformCalloutTokens 生成，
 * 不是 markdown-it 原生 token type，需要在这里手动注册。
 */
export const calloutParserTokens = {
  callout: {
    block: 'callout',
    getAttrs: (tok: Token) => ({ type: tok.meta?.calloutType ?? 'note' }),
  },
};
