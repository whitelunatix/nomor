import { Plugin } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { closeHistory } from 'prosemirror-history';
import { EmojiSuggestions } from '../../emoji/suggestions';
import { findEmojiQuery } from '../../emoji/catalog';
import { analyzeInlineSource } from '../InlineSourceCodec';
import { getEmptyInlineTemplateFormats } from './inlineSourceEditing';
import { dismissQuickInsert } from './quickInsert';

export function emojiSuggestionsPlugin(enabled: () => boolean): Plugin {
  let menu: EmojiSuggestions | undefined;
  let input = false;
  const read = (view: EditorView) => {
    const { selection } = view.state;
    const { $from } = selection;
    if (
      !enabled() ||
      !view.editable ||
      !view.hasFocus() ||
      view.composing ||
      !selection.empty ||
      !$from.parent.inlineContent ||
      $from.parent.type.spec.code ||
      $from.marks().some((mark) => ['code', 'link'].includes(mark.type.name)) ||
      getEmptyInlineTemplateFormats(view.state).has('code')
    )
      return null;
    const before = $from.parent.textBetween(
      Math.max(0, $from.parentOffset - 192),
      $from.parentOffset,
      '\n',
      '\ufffc',
    );
    const query = findEmojiQuery(before, selection.from);
    if (!query) return null;
    if (/\]\([^)]*$|<[^>]*$/.test(before)) return null;
    let literal = false;
    view.state.doc.nodesBetween(query.from, query.to, (node) => {
      if (node.marks.some((mark) => ['code', 'link'].includes(mark.type.name))) literal = true;
    });
    if (literal) return null;
    // 复用正文编辑插件已经维护的 WeakMap 分析，不为 Emoji 再保存段落副本。
    if (
      analyzeInlineSource($from.parent).spans.some(
        (span) =>
          span.type === 'code' && $from.parentOffset >= span.from && $from.parentOffset <= span.to,
      )
    )
      return null;
    return query;
  };
  return new Plugin({
    props: {
      handleTextInput() {
        input = true;
        return false;
      },
      handleKeyDown(_view, event) {
        const handled = menu?.keydown(event) ?? false;
        if (
          !handled &&
          menu?.isOpen &&
          ['Backspace', 'Delete'].includes(event.key) &&
          !event.ctrlKey &&
          !event.metaKey &&
          !event.altKey
        )
          input = true;
        return handled;
      },
      handleDOMEvents: {
        compositionstart() {
          menu?.close();
          input = false;
          return false;
        },
        compositionend(view) {
          input = true;
          queueMicrotask(() => {
            if (enabled() && !view.isDestroyed) menu?.sync(true);
          });
          return false;
        },
        blur() {
          menu?.close();
          input = false;
          return false;
        },
      },
    },
    view(view) {
      input = false;
      menu = new EmojiSuggestions({
        dom: view.dom,
        read: () => read(view),
        anchor: () => {
          try {
            return view.coordsAtPos(view.state.selection.head);
          } catch {
            return null;
          }
        },
        insert(query, entry) {
          dismissQuickInsert(view);
          view.dispatch(
            closeHistory(view.state.tr)
              .insertText(entry.unicode, query.from, query.to)
              .setMeta('emoji-insert', true)
              .scrollIntoView(),
          );
          view.dispatch(closeHistory(view.state.tr).setMeta('addToHistory', false));
          view.focus();
        },
      });
      return {
        update(view, previous) {
          if (!input && !view.state.doc.eq(previous.doc)) menu?.close();
          else menu?.sync(input);
          input = false;
          if (menu?.isOpen) dismissQuickInsert(view);
        },
        destroy() {
          input = false;
          menu?.destroy();
          menu = undefined;
        },
      };
    },
  });
}
