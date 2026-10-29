/**
 * 源码模式的搜索高亮。
 *
 * CodeMirror 没有内置的搜索装饰，这里用一个 StateField 保存 DecorationSet，
 * App 通过 `setSourceSearchHighlights` effect 更新。装饰只是行内 mark，
 * 不改变文本，也不进入撤销历史；文档变化时随 changes 映射。
 */

import { StateEffect, StateField, type Extension } from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';

export interface SourceSearchMatchRange {
  from: number;
  to: number;
}

export interface SourceSearchHighlightPayload {
  matches: readonly SourceSearchMatchRange[];
  /** 当前激活项；-1 表示只标出全部匹配，不突出某一项。 */
  activeIndex: number;
}

export const setSourceSearchHighlights = StateEffect.define<SourceSearchHighlightPayload>();

/** 与语义区保持一致：最多渲染 1000 条，激活项始终落在窗口内。 */
const SEARCH_DECORATION_LIMIT = 1000;

const matchMark = Decoration.mark({ class: 'search-match' });
const activeMatchMark = Decoration.mark({ class: 'search-match-active' });

/** 计算要渲染的匹配窗口；坐标越界的匹配直接丢弃。 */
export function visibleSourceSearchMatches(
  matches: readonly SourceSearchMatchRange[],
  activeIndex: number,
): Array<{ match: SourceSearchMatchRange; isActive: boolean }> {
  let start = 0;
  let end = matches.length;
  if (matches.length > SEARCH_DECORATION_LIMIT) {
    if (activeIndex >= 0 && activeIndex < matches.length) {
      const halfWindow = Math.floor(SEARCH_DECORATION_LIMIT / 2);
      start = Math.min(
        Math.max(0, activeIndex - halfWindow),
        matches.length - SEARCH_DECORATION_LIMIT,
      );
      end = start + SEARCH_DECORATION_LIMIT;
    } else {
      end = SEARCH_DECORATION_LIMIT;
    }
  }

  const visible: Array<{ match: SourceSearchMatchRange; isActive: boolean }> = [];
  for (let index = start; index < end; index += 1) {
    visible.push({ match: matches[index]!, isActive: index === activeIndex });
  }
  return visible;
}

export function buildSourceSearchDecorations(
  docLength: number,
  matches: readonly SourceSearchMatchRange[],
  activeIndex: number,
): DecorationSet {
  const ranges = [];
  for (const { match, isActive } of visibleSourceSearchMatches(matches, activeIndex)) {
    if (match.from < 0 || match.to > docLength || match.to <= match.from) continue;
    ranges.push((isActive ? activeMatchMark : matchMark).range(match.from, match.to));
  }
  return Decoration.set(ranges, true);
}

const sourceSearchHighlightField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decorations, transaction) {
    let next = decorations.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (!effect.is(setSourceSearchHighlights)) continue;
      next = buildSourceSearchDecorations(
        transaction.newDoc.length,
        effect.value.matches,
        effect.value.activeIndex,
      );
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

export function sourceSearchHighlights(): Extension {
  return sourceSearchHighlightField;
}
