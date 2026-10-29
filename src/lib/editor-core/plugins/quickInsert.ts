import { Plugin, PluginKey, type EditorState } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { closeHistory } from 'prosemirror-history';
import { onInterfaceLocaleChanged, t } from '../../../app/i18n';
import { insertQuickInsertContent } from '../editorCommands';
import type { EditorQuickInsertPickerEvent } from '../types';
import { isQuickInsertTrigger, QUICK_INSERT_CATEGORIES } from '../quickInsert';
import { analyzeInlineSource } from '../InlineSourceCodec';
import { getEmptyInlineTemplateFormats } from './inlineSourceEditing';

interface QuickInsertSession {
  from: number;
  to: number;
  trigger: string;
  category: number;
  variants: number[];
  unavailable?: boolean;
}

interface QuickInsertOptions {
  enabled: boolean;
  trigger: string;
  onChoose?: (event: EditorQuickInsertPickerEvent) => boolean;
}

type QuickInsertAction =
  | { type: 'open'; from: number; trigger: string }
  | { type: 'close' }
  | { type: 'unavailable' }
  | { type: 'category'; index: number }
  | { type: 'variant'; category: number; direction: number };

export const quickInsertKey = new PluginKey<QuickInsertSession | null>('quickInsert');

function canTriggerAt(state: EditorState, from: number, to: number): boolean {
  if (from !== to || !state.selection.empty || state.selection.from !== from) return false;
  const $pos = state.doc.resolve(from);
  if (!['paragraph', 'heading'].includes($pos.parent.type.name)) return false;
  if ($pos.marks().some((mark) => mark.type.name === 'code' || mark.type.name === 'link'))
    return false;
  if (
    getEmptyInlineTemplateFormats(state).has('code') ||
    analyzeInlineSource($pos.parent).spans.some(
      (span) =>
        span.type === 'code' && $pos.parentOffset >= span.from && $pos.parentOffset <= span.to,
    )
  )
    return false;
  const previous = $pos.nodeBefore;
  return (
    !previous ||
    previous.type.name === 'hard_break' ||
    (previous.isText && /[ \u3000]$/.test(previous.text ?? ''))
  );
}

export function dismissQuickInsert(view: EditorView): void {
  if (!quickInsertKey.getState(view.state)) return;
  view.dispatch(
    view.state.tr.setMeta(quickInsertKey, { type: 'close' }).setMeta('addToHistory', false),
  );
}

function changeMenu(view: EditorView, action: QuickInsertAction): void {
  view.dispatch(view.state.tr.setMeta(quickInsertKey, action).setMeta('addToHistory', false));
}

function insertSelected(view: EditorView, getOptions: () => QuickInsertOptions): boolean {
  const session = quickInsertKey.getState(view.state);
  if (!session) return false;
  const category = QUICK_INSERT_CATEGORIES[session.category];
  const command = category.variants[session.variants[session.category]].command;
  let inserted: boolean;
  if (command.type === 'chooseImage' || command.type === 'chooseLink' || command.type === 'chooseEmoji') {
    inserted =
      getOptions().onChoose?.({
        kind: command.type === 'chooseImage' ? 'image' : command.type === 'chooseEmoji' ? 'emoji' : 'link',
        selection: { anchor: session.from, head: session.to },
      }) ?? false;
    if (inserted)
      view.dispatch(
        closeHistory(view.state.tr)
          .setMeta(quickInsertKey, { type: 'close' })
          .setMeta('addToHistory', false),
      );
  } else {
    inserted = insertQuickInsertContent(view, session.from, session.to, command);
    if (inserted && command.type === 'insertMathInline') dismissQuickInsert(view);
  }
  if (!inserted) changeMenu(view, { type: 'unavailable' });
  return inserted;
}

/** 只由实际输入打开菜单；移动光标、粘贴和恢复文档不会唤起。 */
export function quickInsertPlugin(getOptions: () => QuickInsertOptions): Plugin {
  return new Plugin<QuickInsertSession | null>({
    key: quickInsertKey,
    state: {
      init: () => null,
      apply(tr, session, oldState, state) {
        let action = tr.getMeta(quickInsertKey) as QuickInsertAction | undefined;
        const options = getOptions();
        if (action?.type === 'close' || !options.enabled) return null;
        // 输入法先把字符提交到文档；只在这次变更恰好插入一个触发符号时打开。
        if (
          !action &&
          !session &&
          tr.docChanged &&
          tr.getMeta('composition') !== undefined &&
          isQuickInsertTrigger(options.trigger)
        ) {
          const { from, to } = oldState.selection;
          if (
            canTriggerAt(oldState, from, to) &&
            state.selection.empty &&
            state.selection.from === from + options.trigger.length &&
            tr.doc.eq(oldState.tr.insertText(options.trigger, from, to).doc)
          ) {
            action = { type: 'open', from, trigger: options.trigger };
          }
        }
        if (action?.type === 'open') {
          return {
            from: action.from,
            to: action.from + action.trigger.length,
            trigger: action.trigger,
            category: 0,
            variants: QUICK_INSERT_CATEGORIES.map((category) => category.defaultVariant ?? 0),
          };
        }
        if (!session || session.trigger !== options.trigger) return null;
        const from = tr.mapping.map(session.from, 1);
        const to = tr.mapping.map(session.to, -1);
        if (
          from >= to ||
          state.doc.textBetween(from, to) !== session.trigger ||
          !state.selection.empty ||
          state.selection.from !== to
        )
          return null;
        if (action?.type === 'unavailable') return { ...session, from, to, unavailable: true };
        if (action?.type === 'category')
          return { ...session, from, to, category: action.index, unavailable: false };
        if (action?.type === 'variant') {
          const variants = [...session.variants];
          const count = QUICK_INSERT_CATEGORIES[action.category].variants.length;
          variants[action.category] =
            (variants[action.category] + action.direction + count) % count;
          return { ...session, from, to, category: action.category, variants, unavailable: false };
        }
        return { ...session, from, to };
      },
    },
    props: {
      attributes: { role: 'textbox', 'aria-multiline': 'true' },
      handleTextInput(view, from, to, text) {
        const options = getOptions();
        if (
          !view.editable ||
          view.composing ||
          !options.enabled ||
          !isQuickInsertTrigger(options.trigger) ||
          text !== options.trigger ||
          !canTriggerAt(view.state, from, to)
        )
          return false;
        const tr = view.state.tr.insertText(text, from, to);
        view.dispatch(tr.setMeta(quickInsertKey, { type: 'open', from, trigger: text }));
        return true;
      },
      handleKeyDown(view, event) {
        const session = quickInsertKey.getState(view.state);
        const options = getOptions();
        if (
          !session ||
          !view.editable ||
          !options.enabled ||
          session.trigger !== options.trigger ||
          view.composing ||
          event.isComposing ||
          event.keyCode === 229
        )
          return false;
        if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return false;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          const count = QUICK_INSERT_CATEGORIES.length;
          changeMenu(view, {
            type: 'category',
            index: (session.category + (event.key === 'ArrowDown' ? 1 : -1) + count) % count,
          });
        } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          changeMenu(view, {
            type: 'variant',
            category: session.category,
            direction: event.key === 'ArrowRight' ? 1 : -1,
          });
        } else if (event.key === 'Enter') {
          insertSelected(view, getOptions);
        } else if (event.key === 'Escape') {
          dismissQuickInsert(view);
        } else {
          dismissQuickInsert(view);
          return false;
        }
        return true;
      },
      handleDOMEvents: {
        compositionstart(view) {
          dismissQuickInsert(view);
          return false;
        },
        compositionend(view) {
          queueMicrotask(() => {
            if (!view.isDestroyed && quickInsertKey.getState(view.state))
              view.dispatch(view.state.tr.setMeta('addToHistory', false));
          });
          return false;
        },
        blur(view) {
          dismissQuickInsert(view);
          return false;
        },
      },
    },
    view: (view) => new QuickInsertMenu(view, getOptions),
  });
}

let nextMenuId = 0;

const ICON_PATHS: Record<string, string[]> = {
  emoji: ['M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20', 'M8 9h.01M16 9h.01M7 14a5 5 0 0 0 10 0'],
  heading: ['M6 4v16M18 4v16M6 12h12'],
  list: ['M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01'],
  table: ['M3 3h18v18H3zM3 9h18M9 3v18M3 15h18'],
  code: ['m8 6-6 6 6 6m8-12 6 6-6 6m-3-15-2 18'],
  quote: ['M3 3h7v7H3zM14 3h7v7h-7zM10 10v4a5 5 0 0 1-5 5M21 10v4a5 5 0 0 1-5 5'],
  callout: ['M12 8v4m0 4h.01', 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20'],
  image: ['M3 3h18v18H3zM3 17l6-6 4 4 3-3 5 5', 'M8 7h.01'],
  link: [
    'M10 13a5 5 0 0 0 7 .5l3-3a5 5 0 0 0-7-7l-2 2',
    'M14 11a5 5 0 0 0-7-.5l-3 3a5 5 0 0 0 7 7l2-2',
  ],
  math: ['M19 4H5l7 8-7 8h14'],
  diagram: ['M8 3h8v5H8zM3 16h6v5H3zM15 16h6v5h-6zM12 8v4M6 16v-4h12v4'],
  comment: ['M21 11a8 8 0 0 1-8 8H7l-4 3V11a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8Z', 'M7 9h10M7 13h6'],
  divider: ['M4 12h16'],
  previous: ['m14 6-6 6 6 6'],
  next: ['m10 6 6 6-6 6'],
};

function createIcon(doc: Document, name: string): SVGSVGElement {
  const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.7');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of ICON_PATHS[name]) {
    const path = doc.createElementNS(svg.namespaceURI, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

class QuickInsertMenu {
  private readonly dom: HTMLDivElement;
  private readonly title: HTMLSpanElement;
  private readonly trigger: HTMLElement;
  private readonly list: HTMLDivElement;
  private readonly help: HTMLDivElement;
  private readonly rows: {
    row: HTMLDivElement;
    option: HTMLButtonElement;
    label: HTMLSpanElement;
    value: HTMLSpanElement;
    previous?: HTMLButtonElement;
    next?: HTMLButtonElement;
  }[] = [];
  private readonly doc: Document;
  private readonly win: Window;
  private readonly stopLocaleListener: () => void;
  private readonly observer: ResizeObserver | null;
  private frame: number | null = null;
  private activeCategory = -1;
  private revealActiveRow = false;

  constructor(
    private readonly view: EditorView,
    private readonly getOptions: () => QuickInsertOptions,
  ) {
    this.doc = view.dom.ownerDocument;
    this.win = this.doc.defaultView!;
    this.dom = this.doc.createElement('div');
    this.dom.className = 'quick-insert-menu';
    this.dom.hidden = true;
    this.dom.contentEditable = 'false';
    const header = this.doc.createElement('div');
    header.className = 'quick-insert-header';
    this.title = this.doc.createElement('span');
    this.trigger = this.doc.createElement('kbd');
    header.append(this.title, this.trigger);
    this.list = this.doc.createElement('div');
    this.list.id = `nomo-quick-insert-${++nextMenuId}`;
    this.list.className = 'quick-insert-list';
    this.list.setAttribute('role', 'listbox');
    QUICK_INSERT_CATEGORIES.forEach((category, index) => {
      const row = this.doc.createElement('div');
      row.className = 'quick-insert-row';
      const option = this.doc.createElement('button');
      option.type = 'button';
      option.tabIndex = -1;
      option.id = `${this.list.id}-${category.id}`;
      option.className = 'quick-insert-option';
      option.setAttribute('role', 'option');
      const label = this.doc.createElement('span');
      option.append(createIcon(this.doc, category.icon), label);
      option.addEventListener('click', () => {
        changeMenu(view, { type: 'category', index });
        insertSelected(view, getOptions);
      });
      row.append(option);
      const value = this.doc.createElement('span');
      value.className = 'quick-insert-variant';
      const controls: { previous?: HTMLButtonElement; next?: HTMLButtonElement } = {};
      if (category.variants.length > 1) {
        for (const direction of [-1, 1]) {
          const button = this.doc.createElement('button');
          button.type = 'button';
          button.tabIndex = -1;
          button.className = 'quick-insert-step';
          button.append(createIcon(this.doc, direction < 0 ? 'previous' : 'next'));
          button.addEventListener('click', () =>
            changeMenu(view, { type: 'variant', category: index, direction }),
          );
          if (direction < 0) {
            controls.previous = button;
            row.append(button, value);
          } else {
            controls.next = button;
            row.append(button);
          }
        }
      }
      this.rows.push({ row, option, label, value, ...controls });
      this.list.append(row);
    });
    this.help = this.doc.createElement('div');
    this.help.className = 'quick-insert-help';
    this.help.setAttribute('role', 'status');
    this.dom.append(header, this.list, this.help);
    this.doc.body.append(this.dom);
    this.dom.addEventListener('pointerdown', this.preserveFocus);
    this.doc.addEventListener('pointerdown', this.onOutsidePointer, true);
    this.win.addEventListener('scroll', this.schedulePosition, true);
    this.win.addEventListener('resize', this.schedulePosition);
    this.stopLocaleListener = onInterfaceLocaleChanged(() => this.update());
    this.observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(this.schedulePosition);
    this.observer?.observe(view.dom);
    // 挂起再挂载时，旧菜单会话不随文档历史一起恢复。
    if (quickInsertKey.getState(view.state))
      queueMicrotask(() => {
        if (!view.isDestroyed) dismissQuickInsert(view);
      });
  }

  update(): void {
    const session = quickInsertKey.getState(this.view.state);
    const options = this.getOptions();
    if (
      !session ||
      this.view.composing ||
      !this.view.editable ||
      !options.enabled ||
      session.trigger !== options.trigger
    ) {
      this.dom.hidden = true;
      this.activeCategory = -1;
      if (this.view.dom.getAttribute('aria-controls') === this.list.id) {
        this.view.dom.removeAttribute('aria-activedescendant');
        this.view.dom.removeAttribute('aria-controls');
      }
      return;
    }
    this.title.textContent = t.quickInsert();
    this.trigger.textContent = session.trigger;
    this.list.setAttribute('aria-label', t.quickInsert());
    const help = session.unavailable ? t.quickInsertUnavailable() : t.quickInsertKeys();
    if (this.help.textContent !== help) this.help.textContent = help;
    this.rows.forEach(({ row, option, label, value, previous, next }, index) => {
      const category = QUICK_INSERT_CATEGORIES[index];
      const variant = category.variants[session.variants[index]];
      label.textContent = category.label();
      value.textContent = variant.label();
      value.title = variant.label();
      row.classList.toggle('active', index === session.category);
      option.setAttribute('aria-selected', String(index === session.category));
      option.setAttribute(
        'aria-label',
        [category.label(), variant.label()].filter(Boolean).join(', '),
      );
      if (variant.command.type === 'insertTable')
        option.title = t.quickInsertTableSize({
          columns: variant.command.columns,
          rows: variant.command.rows,
        });
      previous?.setAttribute(
        'aria-label',
        t.quickInsertPreviousStyle({ category: category.label() }),
      );
      next?.setAttribute('aria-label', t.quickInsertNextStyle({ category: category.label() }));
    });
    this.view.dom.setAttribute('aria-controls', this.list.id);
    this.view.dom.setAttribute('aria-activedescendant', this.rows[session.category].option.id);
    if (this.dom.hidden || this.activeCategory !== session.category) this.revealActiveRow = true;
    this.activeCategory = session.category;
    if (this.dom.hidden) this.dom.style.visibility = 'hidden';
    this.dom.hidden = false;
    this.schedulePosition();
  }

  destroy(): void {
    if (this.frame !== null) this.win.cancelAnimationFrame(this.frame);
    this.observer?.disconnect();
    this.stopLocaleListener();
    this.dom.removeEventListener('pointerdown', this.preserveFocus);
    this.doc.removeEventListener('pointerdown', this.onOutsidePointer, true);
    this.win.removeEventListener('scroll', this.schedulePosition, true);
    this.win.removeEventListener('resize', this.schedulePosition);
    this.view.dom.removeAttribute('aria-activedescendant');
    this.view.dom.removeAttribute('aria-controls');
    this.dom.remove();
  }

  private preserveFocus = (event: PointerEvent): void => {
    event.preventDefault();
  };

  private onOutsidePointer = (event: PointerEvent): void => {
    if (!this.dom.hidden && event.target instanceof Node && !this.dom.contains(event.target))
      dismissQuickInsert(this.view);
  };

  private schedulePosition = (): void => {
    if (this.dom.hidden || this.frame !== null) return;
    this.frame = this.win.requestAnimationFrame(() => {
      this.frame = null;
      const session = quickInsertKey.getState(this.view.state);
      if (!session || this.dom.hidden || this.view.isDestroyed) return;
      const caret = this.view.coordsAtPos(session.to);
      const margin = 8;
      const width = this.dom.offsetWidth;
      this.dom.style.maxHeight = '';
      const naturalHeight = this.dom.offsetHeight;
      const viewport = this.view.dom.closest('.semantic-pane')?.getBoundingClientRect();
      if (
        caret.bottom < (viewport?.top ?? 0) ||
        caret.top > (viewport?.bottom ?? this.win.innerHeight)
      ) {
        dismissQuickInsert(this.view);
        return;
      }
      const left = Math.max(margin, Math.min(caret.left, this.win.innerWidth - width - margin));
      const below = caret.bottom + 6;
      const belowSpace = Math.max(0, this.win.innerHeight - margin - below);
      const aboveSpace = Math.max(0, caret.top - margin - 6);
      const placeBelow = belowSpace >= naturalHeight || belowSpace >= aboveSpace;
      this.dom.style.maxHeight = `${placeBelow ? belowSpace : aboveSpace}px`;
      const top = placeBelow ? below : Math.max(margin, caret.top - this.dom.offsetHeight - 6);
      if (this.revealActiveRow) {
        const row = this.rows[session.category].row;
        const rowBottom = row.offsetTop + row.offsetHeight;
        if (row.offsetTop < this.list.scrollTop) this.list.scrollTop = row.offsetTop;
        else if (rowBottom > this.list.scrollTop + this.list.clientHeight)
          this.list.scrollTop = rowBottom - this.list.clientHeight;
        this.revealActiveRow = false;
      }
      this.dom.style.left = `${left}px`;
      this.dom.style.top = `${top}px`;
      this.dom.style.visibility = 'visible';
    });
  };
}
