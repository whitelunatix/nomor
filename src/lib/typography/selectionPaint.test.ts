import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLineSelectionPaint } from './selectionPaint';

let frames: Map<number, FrameRequestCallback>;
let hitDescriptor: PropertyDescriptor | undefined;
const painters: ReturnType<typeof createLineSelectionPaint>[] = [];
beforeEach(() => {
  frames = new Map();
  hitDescriptor = Object.getOwnPropertyDescriptor(document, 'elementFromPoint');
  let id = 0;
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => { frames.set(++id, fn); return id; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
});
afterEach(() => {
  for (const painter of painters.splice(0)) painter.destroy();
  document.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
  if (hitDescriptor) Object.defineProperty(document, 'elementFromPoint', hitDescriptor);
  else Reflect.deleteProperty(document, 'elementFromPoint');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function root(html = '<p style="line-height:24px;font-size:16px;width:400px;background-image:none">正文 code 文本</p>') {
  const element = document.createElement('div');
  element.innerHTML = html;
  document.body.append(element);
  const painter = createLineSelectionPaint(element);
  painters.push(painter);
  return { element, painter, text: element.firstChild!.firstChild! };
}
function select(text: Node) {
  document.getSelection()!.setBaseAndExtent(text, 0, text, 5);
  document.dispatchEvent(new Event('selectionchange'));
}
function flush() {
  const pending = [...frames.values()];
  frames.clear();
  for (const fn of pending) fn(0);
}
function ruleCount() {
  return [...document.styleSheets].reduce((sum, sheet) => sum + [...sheet.cssRules].reduce((count, rule) =>
    count + ('cssRules' in rule ? (rule as CSSMediaRule).cssRules.length : 1), 0), 0);
}

function paintedStyle(block: Element) {
  // jsdom 不应用 @media screen 内的动态 CSSOM；直接检查实际交给浏览器的背景规则。
  for (const sheet of document.styleSheets) {
    for (const group of sheet.cssRules) {
      if (!('cssRules' in group)) continue;
      for (const rule of (group as CSSMediaRule).cssRules) {
        const styleRule = rule as CSSStyleRule;
        if (styleRule.style?.getPropertyValue('background-size') && block.matches(styleRule.selectorText))
          return styleRule.style;
      }
    }
  }
}

describe('selection paint content bounds', () => {
  it.each(['paragraph', 'ul', 'ol'].flatMap((kind) => [false, true].map((reverse) => ({ kind, reverse }))))(
    'does not paint trailing blank space across $kind blocks (reverse: $reverse)',
    ({ kind, reverse }) => {
      const paragraphs = '<p>正文 code 文本</p><p>最后一段未全部选中</p>';
      const content = kind === 'paragraph' ? paragraphs
        : `<${kind}><li><p>正文 code 文本</p></li><li><p>最后一段未全部选中</p></li></${kind}>`;
      const { element } = root(`<h2>标题</h2>${content}`);
      const blocks = [...element.querySelectorAll<HTMLElement>('h2,p')];
      const widths = [50, 80, 140];
      vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 400, 120));
      blocks.forEach((block, index) => {
        block.style.cssText = 'line-height:24px;font-size:16px;width:400px;background-image:none';
        vi.spyOn(block, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, index * 40, 400, 24));
      });
      vi.spyOn(Range.prototype, 'getClientRects').mockImplementation(function (this: Range) {
        const index = blocks.indexOf(this.startContainer as HTMLElement);
        // selectNodeContents 只返回行内内容；跨块选区还会返回完整的段落容器。
        return (index >= 0 ? [new DOMRect(0, index * 40 + 2, widths[index], 20)] : [
          new DOMRect(0, 2, 50, 20),
          new DOMRect(0, 40, 400, 24),
          new DOMRect(0, 42, 80, 20),
          new DOMRect(0, 82, 35, 20),
        ]) as unknown as DOMRectList;
      });
      Object.defineProperty(document, 'elementFromPoint', {
        configurable: true, value: (_x: number, y: number) => blocks[Math.floor(y / 40)],
      });
      const start = blocks[0].firstChild!, end = blocks[2].firstChild!;
      document.getSelection()!.setBaseAndExtent(reverse ? end : start, reverse ? 2 : 0, reverse ? start : end, reverse ? 0 : 2);
      document.dispatchEvent(new Event('selectionchange'));
      flush();

      expect(paintedStyle(blocks[0])?.getPropertyValue('background-size')).toBe('50.000px 24.000px');
      expect(paintedStyle(blocks[1])?.getPropertyValue('background-size')).toBe('80.000px 24.000px');
      expect(paintedStyle(blocks[2])?.getPropertyValue('background-size')).toBe('35.000px 24.000px');
      document.getSelection()!.collapse(end, 2);
      document.dispatchEvent(new Event('selectionchange'));
      expect(paintedStyle(blocks[1])).toBeUndefined();
      expect(getComputedStyle(blocks[1]).backgroundImage).toBe('none');
    },
  );

  it('keeps partially selected wrapped rows inside their own content boundaries', () => {
    const { element, text } = root();
    const paragraph = element.firstElementChild!;
    vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 400, 100));
    vi.spyOn(paragraph, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 400, 48));
    vi.spyOn(Range.prototype, 'getClientRects').mockImplementation(function (this: Range) {
      return (this.startContainer === paragraph
        ? [new DOMRect(0, 2, 180, 20), new DOMRect(0, 26, 100, 20)]
        : [new DOMRect(40, 2, 140, 20), new DOMRect(0, 26, 35, 20)]) as unknown as DOMRectList;
    });
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => paragraph });
    select(text);
    flush();
    const style = paintedStyle(paragraph);
    expect(style?.getPropertyValue('background-size')).toBe('140.000px 24.000px,35.000px 24.000px');
    expect(style?.getPropertyValue('background-position')).toBe('40.000px 0.000px,0.000px 24.000px');
  });
});

describe('selection paint ownership and lifetime', () => {
  it('removes row painting and bridge validity immediately when DOM selection collapses', () => {
    const initialRules = ruleCount();
    const { element, text } = root();
    const paragraph = element.firstElementChild!;
    vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 400, 100));
    vi.spyOn(paragraph, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 400, 24));
    vi.spyOn(Range.prototype, 'getClientRects').mockReturnValue([new DOMRect(0, 0, 80, 20)] as unknown as DOMRectList);
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => paragraph });
    select(text);
    expect(element.hasAttribute('data-nomo-selection-active')).toBe(true);
    flush();
    expect(ruleCount()).toBeGreaterThan(initialRules);
    document.getSelection()!.collapse(text, 2);
    document.dispatchEvent(new Event('selectionchange'));
    expect(element.hasAttribute('data-nomo-selection-active')).toBe(false);
    expect(ruleCount()).toBe(initialRules);
    expect(frames.size).toBe(0);
  });

  it('paints only the selection owner and relinquishes it to native inputs inside or outside the editor', () => {
    const first = root(), second = root();
    select(first.text);
    expect(first.element.hasAttribute('data-nomo-selection-active')).toBe(true);
    expect(second.element.hasAttribute('data-nomo-selection-active')).toBe(false);
    for (const parent of [first.element, document.body]) {
      const input = document.createElement('textarea');
      parent.append(input);
      input.focus();
      // 原生输入可保留后台正文 Range；此时即使未触发 selectionchange 也不能补色。
      document.getSelection()!.setBaseAndExtent(first.text, 0, first.text, 5);
      document.dispatchEvent(new Event('focusin'));
      expect(first.element.hasAttribute('data-nomo-selection-active')).toBe(false);
      expect(document.getSelection()!.isCollapsed).toBe(false);
      input.remove();
      document.dispatchEvent(new Event('focusin'));
    }
    select(second.text);
    expect(first.element.hasAttribute('data-nomo-selection-active')).toBe(false);
    expect(second.element.hasAttribute('data-nomo-selection-active')).toBe(true);
  });

  it('preserves the range for toolbar operations and window blur, and supports dragging beyond the root', () => {
    const { element, text } = root();
    const toolbar = document.createElement('button');
    toolbar.textContent = '加粗';
    document.body.append(toolbar);
    toolbar.focus();
    select(text);
    window.dispatchEvent(new Event('blur'));
    expect(document.getSelection()!.isCollapsed).toBe(false);
    expect(element.hasAttribute('data-nomo-selection-active')).toBe(true);
    document.getSelection()!.extend(toolbar.firstChild!, 1);
    document.dispatchEvent(new Event('selectionchange'));
    expect(element.hasAttribute('data-nomo-selection-active')).toBe(true);
  });

  it('releases listeners, pending frames, markers and shared styles through 20 mount/unmount cycles', () => {
    const sheets = document.styleSheets.length;
    const added = vi.spyOn(document, 'addEventListener');
    const removed = vi.spyOn(document, 'removeEventListener');
    for (let i = 0; i < 20; i++) {
      const { element, painter, text } = root();
      select(text);
      expect(frames.size).toBe(1);
      painter.destroy();
      painter.destroy();
      expect(frames.size).toBe(0);
      expect(element.hasAttribute('data-nomo-selection-root')).toBe(false);
      expect(element.hasAttribute('data-nomo-selection-active')).toBe(false);
      element.remove();
      expect(document.styleSheets.length).toBe(sheets);
    }
    for (const [name, listener] of added.mock.calls) {
      if (['selectionchange', 'focusin', 'focusout'].includes(name))
        expect(removed).toHaveBeenCalledWith(name, listener);
    }
  });
});
