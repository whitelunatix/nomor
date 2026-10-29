import { loadEmojiCatalog } from '../../app/services/emojiCatalog';
import { onInterfaceLocaleChanged, t } from '../../app/i18n';
import { searchEmoji, type EmojiEntry, type EmojiQuery } from './catalog';

interface SuggestionHost {
  dom: HTMLElement;
  read(): EmojiQuery | null;
  anchor(): { left: number; top: number; bottom: number } | null;
  insert(query: EmojiQuery, entry: EmojiEntry): void;
}
let nextSuggestionId = 0;

/** 浮层只在实际输入后创建，编辑器销毁时不保留 DOM、监听器或异步回调。 */
export class EmojiSuggestions {
  private query: EmojiQuery | null = null;
  private entries: EmojiEntry[] = [];
  private selected = 0;
  private generation = 0;
  private menu: HTMLDivElement | null = null;
  private status: 'loading' | 'ready' | 'error' = 'loading';
  private dismissed = '';
  private unsubscribe: (() => void) | undefined;
  private frame = 0;
  private dead = false;
  private readonly win: Window;
  private readonly id = `emoji-suggestions-${++nextSuggestionId}`;

  constructor(private host: SuggestionHost) {
    this.win = host.dom.ownerDocument.defaultView!;
  }
  get isOpen(): boolean {
    return this.query !== null;
  }

  sync(allowOpen = false): void {
    if (this.dead) return;
    const next = this.host.read();
    if (!next || (!this.query && !allowOpen)) {
      this.close();
      return;
    }
    const signature = `${next.from}:${next.to}:${next.text}`;
    if (signature === this.dismissed) return;
    if (
      !allowOpen &&
      this.query &&
      (next.from !== this.query.from || next.to !== this.query.to || next.text !== this.query.text)
    ) {
      this.close();
      return;
    }
    if (
      this.query &&
      next.from === this.query.from &&
      next.to === this.query.to &&
      next.text === this.query.text
    ) {
      this.schedulePosition();
      return;
    }
    this.query = next;
    this.entries = [];
    this.selected = 0;
    this.status = 'loading';
    const generation = ++this.generation;
    this.render();
    void loadEmojiCatalog().then(
      (catalog) => {
        if (this.dead || generation !== this.generation || !this.query) return;
        const current = this.host.read();
        if (
          !current ||
          current.from !== next.from ||
          current.to !== next.to ||
          current.text !== next.text
        ) {
          this.close();
          return;
        }
        this.entries = searchEmoji(catalog, next.text, undefined, 8);
        this.status = 'ready';
        this.render();
      },
      () => {
        if (this.dead || generation !== this.generation || !this.query) return;
        this.status = 'error';
        this.render();
      },
    );
  }

  keydown(event: KeyboardEvent): boolean {
    if (
      !this.query ||
      event.isComposing ||
      event.keyCode === 229 ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      event.shiftKey
    )
      return false;
    if (event.key === 'Escape') {
      this.dismiss();
      return true;
    }
    if (!this.entries.length) return false;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      this.selected =
        (this.selected + (event.key === 'ArrowDown' ? 1 : -1) + this.entries.length) %
        this.entries.length;
      this.render();
      return true;
    }
    if (event.key === 'Enter' || (event.key === 'Tab' && !event.shiftKey)) {
      this.choose(this.selected);
      return true;
    }
    return false;
  }

  dismiss(): void {
    if (this.query) this.dismissed = `${this.query.from}:${this.query.to}:${this.query.text}`;
    this.close();
  }

  close(): void {
    this.generation++;
    this.query = null;
    this.entries = [];
    this.menu?.remove();
    this.menu = null;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.win.removeEventListener('scroll', this.schedulePosition, true);
    this.win.removeEventListener('resize', this.schedulePosition);
    this.win.removeEventListener('nomo:emoji-picker-open', this.onPickerOpen);
    if (this.frame) this.win.cancelAnimationFrame(this.frame);
    this.frame = 0;
    if (this.host.dom.getAttribute('aria-controls') === this.id) {
      this.host.dom.removeAttribute('aria-controls');
      this.host.dom.removeAttribute('aria-activedescendant');
    }
  }

  destroy(): void {
    this.dead = true;
    this.close();
  }

  private choose(index: number): void {
    const query = this.query;
    const current = this.host.read();
    const entry = this.entries[index];
    if (
      !query ||
      !current ||
      !entry ||
      query.from !== current.from ||
      query.to !== current.to ||
      query.text !== current.text
    ) {
      this.close();
      return;
    }
    this.close();
    this.host.insert(query, entry);
  }

  private render(): void {
    const doc = this.host.dom.ownerDocument;
    if (!this.menu) {
      this.menu = doc.createElement('div');
      this.menu.className = 'emoji-suggestions';
      this.menu.style.visibility = 'hidden';
      this.menu.id = this.id;
      this.menu.setAttribute('role', 'listbox');
      this.menu.setAttribute('aria-label', t.emojiSuggestions());
      this.menu.addEventListener('mousedown', (event) => event.preventDefault());
      this.menu.addEventListener('pointerdown', (event) => event.preventDefault());
      doc.body.appendChild(this.menu);
      this.win.addEventListener('scroll', this.schedulePosition, true);
      this.win.addEventListener('resize', this.schedulePosition);
      this.win.addEventListener('nomo:emoji-picker-open', this.onPickerOpen);
      this.unsubscribe = onInterfaceLocaleChanged(() => this.render());
    }
    this.menu.replaceChildren();
    for (const [index, entry] of this.entries.entries()) {
      const row = doc.createElement('button');
      row.type = 'button';
      row.className = `emoji-suggestion${index === this.selected ? ' active' : ''}`;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(index === this.selected));
      row.id = `${this.id}-${index}`;
      const glyph = doc.createElement('span');
      glyph.className = 'emoji-glyph';
      glyph.textContent = entry.unicode;
      const label = doc.createElement('span');
      label.textContent = doc.documentElement.lang.startsWith('zh') ? entry.zh : entry.en;
      const shortcode = doc.createElement('small');
      shortcode.textContent = `:${entry.shortcodes[0]}:`;
      row.append(glyph, label, shortcode);
      row.addEventListener('click', () => this.choose(index));
      this.menu.append(row);
    }
    this.host.dom.setAttribute('aria-controls', this.id);
    if (this.entries.length)
      this.host.dom.setAttribute('aria-activedescendant', `${this.id}-${this.selected}`);
    else this.host.dom.removeAttribute('aria-activedescendant');
    if (!this.entries.length) {
      const status = doc.createElement('div');
      status.className = 'emoji-status';
      status.setAttribute('role', 'status');
      status.textContent =
        this.status === 'loading'
          ? t.emojiLoading()
          : this.status === 'error'
            ? t.emojiLoadFailed()
            : t.emojiNoResults();
      this.menu.append(status);
      if (this.status === 'error') {
        const retry = doc.createElement('button');
        retry.type = 'button';
        retry.textContent = t.emojiRetry();
        retry.addEventListener('click', () => {
          const query = this.query;
          void loadEmojiCatalog(true).catch(() => undefined);
          this.query = null;
          if (query) this.sync(true);
        });
        this.menu.append(retry);
      }
    }
    this.schedulePosition();
  }

  private onPickerOpen = (): void => this.dismiss();
  private schedulePosition = (): void => {
    if (!this.frame)
      this.frame = this.win.requestAnimationFrame(() => {
        this.frame = 0;
        this.position();
      });
  };
  private position(): void {
    if (!this.menu) return;
    const rect = this.host.anchor();
    if (!rect) {
      this.close();
      return;
    }
    const box = this.menu.getBoundingClientRect();
    this.menu.style.left = `${Math.max(8, Math.min(rect.left, this.win.innerWidth - box.width - 8))}px`;
    const top =
      rect.bottom + 5 + box.height <= this.win.innerHeight - 8
        ? rect.bottom + 5
        : rect.top - box.height - 5;
    this.menu.style.top = `${Math.max(8, top)}px`;
    this.menu.style.visibility = 'visible';
    const row = this.menu.querySelector<HTMLElement>('[aria-selected="true"]');
    if (row) {
      if (row.offsetTop < this.menu.scrollTop) this.menu.scrollTop = row.offsetTop;
      else if (row.offsetTop + row.offsetHeight > this.menu.scrollTop + this.menu.clientHeight)
        this.menu.scrollTop = row.offsetTop + row.offsetHeight - this.menu.clientHeight;
    }
  }
}
