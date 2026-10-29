import { isolateHistory } from '@codemirror/commands';
import { Prec } from '@codemirror/state';
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import { findEmojiQuery } from './catalog';
import { EmojiSuggestions } from './suggestions';
import { SourceEmojiContext } from './sourceContext';

const plugin = ViewPlugin.fromClass(
  class {
    readonly menu: EmojiSuggestions;
    private context = new SourceEmojiContext();
    compositionEnded = false;
    constructor(readonly view: EditorView) {
      this.menu = new EmojiSuggestions({
        dom: view.contentDOM,
        read: () => {
          const selection = view.state.selection.main;
          if (!view.hasFocus || view.composing || view.state.readOnly || !selection.empty)
            return null;
          const query = findEmojiQuery(
            view.state.sliceDoc(Math.max(0, selection.head - 192), selection.head),
            selection.head,
          );
          return query && this.context.allows(view.state.doc, selection.head) ? query : null;
        },
        anchor: () => view.coordsAtPos(view.state.selection.main.head),
        insert: (query, entry) => {
          view.dispatch({
            changes: { from: query.from, to: query.to, insert: entry.unicode },
            selection: { anchor: query.from + entry.unicode.length },
            annotations: isolateHistory.of('full'),
            userEvent: 'input.emoji',
            scrollIntoView: true,
          });
          view.focus();
        },
      });
    }
    update(update: ViewUpdate): void {
      if (update.docChanged)
        this.context.update(update.startState.doc, update.state.doc, update.changes);
      const input =
        update.transactions.some(
          (tr) =>
            (tr.isUserEvent('input.type') && !tr.isUserEvent('input.type.compose')) ||
            (this.menu.isOpen && tr.isUserEvent('delete')),
        ) ||
        (this.compositionEnded && !this.view.composing);
      if (update.docChanged && !input) this.menu.close();
      else this.menu.sync(input);
      if (!this.view.composing) this.compositionEnded = false;
    }
    destroy(): void {
      this.menu.destroy();
    }
  },
  {
    eventHandlers: {
      compositionstart() {
        this.compositionEnded = false;
        this.menu.close();
      },
      compositionend() {
        this.compositionEnded = true;
        queueMicrotask(() => this.menu.sync(true));
      },
      blur() {
        this.menu.close();
      },
      keydown(event) {
        if (this.menu.keydown(event)) {
          event.preventDefault();
          return true;
        }
        return false;
      },
    },
  },
);

export function sourceEmojiSuggestions() {
  return Prec.highest(plugin);
}
