type PaintRect = { left: number; top: number; right: number; bottom: number };
type Background = { image: string; position: string; size: string; repeat: string; origin: string; clip: string };

const BLOCK_SELECTOR = 'p,li,td,th,h1,h2,h3,h4,h5,h6';
const ROOT_ATTRIBUTE = 'data-nomo-selection-root';
const ACTIVE_ATTRIBUTE = 'data-nomo-selection-active';
const MAX_PAINTED_BLOCKS = 128;
const stylesByDocument = new WeakMap<Document, { style: HTMLStyleElement; users: number }>();
let nextRootId = 0;

/** 模型选区可留给工具栏使用；只有从本正文起选的浏览器选区参与补色。 */
function selectionForRoot(root: HTMLElement): Selection | null {
  const document = root.ownerDocument;
  const selection = document.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount ||
    !root.contains(selection.anchorNode) || document.activeElement?.matches('input,textarea')) return null;
  return selection;
}

function retainStyle(document: Document) {
  let shared = stylesByDocument.get(document);
  if (!shared) {
    const style = document.createElement('style');
    document.head.append(style);
    shared = { style, users: 0 };
    stylesByDocument.set(document, shared);
  }
  shared.users++;
  const sheet = shared.style.sheet!;
  const index = sheet.insertRule('@media screen {}', sheet.cssRules.length);
  const group = sheet.cssRules[index] as CSSMediaRule;
  return { group, release() {
    for (let i = 0; i < sheet.cssRules.length; i++) {
      if (sheet.cssRules[i] === group) { sheet.deleteRule(i); break; }
    }
    if (--shared!.users === 0) {
      shared!.style.remove();
      stylesByDocument.delete(document);
    }
  } };
}

function blockSelector(root: HTMLElement, block: HTMLElement, scope: string) {
  const path: number[] = [];
  for (let element: HTMLElement | null = block; element && element !== root; element = element.parentElement) {
    let index = 1;
    for (let sibling = element.previousElementSibling; sibling; sibling = sibling.previousElementSibling) index++;
    path.unshift(index);
  }
  return scope + path.map((index) => ` > :nth-child(${index})`).join('');
}

function mergeRows(rectangles: readonly PaintRect[]): PaintRect[] {
  const rows: PaintRect[] = [];
  for (const rect of [...rectangles].sort((a, b) => a.top - b.top || a.left - b.left)) {
    const row = rows.find((row) => Math.min(row.bottom, rect.bottom) - Math.max(row.top, rect.top) > 1);
    if (row) {
      row.left = Math.min(row.left, rect.left);
      row.right = Math.max(row.right, rect.right);
      row.top = Math.min(row.top, rect.top);
      row.bottom = Math.max(row.bottom, rect.bottom);
    } else rows.push({ ...rect });
  }
  return rows;
}

/**
 * 合并每行选区，消除字体盒子差异和小数像素字距产生的白缝。
 * 每帧只读当前选区与可见段落几何；最多保留 128 个可见块，取消选择即释放。
 * 动态规则放在正文外的共享样式表，不修改段落 DOM，避免触发 ProseMirror 重解析。
 * 背景不参与排版，文字、断点、源码位置、复制内容和撤销历史保持不变。
 */
export function createLineSelectionPaint(root: HTMLElement) {
  const document = root.ownerDocument;
  const window = document.defaultView!;
  const { group, release } = retainStyle(document);
  const originalMarker = root.getAttribute(ROOT_ATTRIBUTE);
  const originalActive = root.getAttribute(ACTIVE_ATTRIBUTE);
  const rootId = String(++nextRootId);
  root.setAttribute(ROOT_ATTRIBUTE, rootId);
  const scope = `[${ROOT_ATTRIBUTE}="${rootId}"]`;
  let painted = new Map<HTMLElement, Background>();
  let rulesText = '';
  let frame: number | undefined;
  let destroyed = false;
  const writeRules = (rules: string[]) => {
    const text = rules.join('\n');
    if (text === rulesText) return;
    while (group.cssRules.length) group.deleteRule(group.cssRules.length - 1);
    for (const rule of rules) group.insertRule(rule, group.cssRules.length);
    rulesText = text;
  };
  const refresh = () => {
    frame = undefined;
    if (destroyed) return;
    const selection = selectionForRoot(root);
    root.toggleAttribute(ACTIVE_ATTRIBUTE, !!selection);
    const blocks = new Map<HTMLElement, { bounds: DOMRect; style: CSSStyleDeclaration; rectangles: PaintRect[] }>();
    if (selection) {
      const rootBounds = root.getBoundingClientRect();
      const pane = root.closest('.semantic-pane,.markdown-mini-large-preview');
      const clip = pane?.getBoundingClientRect() ?? rootBounds;
      const top = Math.max(0, clip.top);
      const bottom = Math.min(window.innerHeight, clip.bottom);
      const left = Math.max(0, rootBounds.left, clip.left);
      const right = Math.min(window.innerWidth, rootBounds.right, clip.right);
      let currentBlock: HTMLElement | undefined;
      // 先完成几何读取，再统一写背景，避免逐字符交替读写布局。
      for (let index = 0; index < selection.rangeCount; index++) {
        const range = selection.getRangeAt(index);
        if (range.collapsed || !range.intersectsNode(root)) continue;
        for (const rect of range.getClientRects()) {
          if (!rect.width || !rect.height || rect.bottom <= top || rect.top >= bottom || rect.right <= left || rect.left >= right) continue;
          const x = Math.max(left, rect.left) + Math.min(2, Math.min(right, rect.right) - Math.max(left, rect.left)) / 2;
          const y = (Math.max(top, rect.top) + Math.min(bottom, rect.bottom)) / 2;
          let block = currentBlock;
          const previous = block && blocks.get(block);
          if (!previous || x < previous.bounds.left || x >= previous.bounds.right || y < previous.bounds.top || y >= previous.bounds.bottom) {
            block = undefined;
            for (const [candidate, info] of blocks) {
              if (x >= info.bounds.left && x < info.bounds.right && y >= info.bounds.top && y < info.bounds.bottom) {
                block = candidate;
                break;
              }
            }
          }
          if (!block) {
            block = document.elementFromPoint(x, y)?.closest<HTMLElement>(BLOCK_SELECTOR) ?? undefined;
            if (!block || !root.contains(block) || block.closest('pre,figure,.code-card,.html-widget')) continue;
            // KP 字距可以稍微溢出段落边界；再次命中同一段落时不能丢掉已收集的行。
            if (!blocks.has(block)) {
              if (blocks.size >= MAX_PAINTED_BLOCKS) continue;
              blocks.set(block, { bounds: block.getBoundingClientRect(), style: window.getComputedStyle(block), rectangles: [] });
            }
          }
          currentBlock = block;
          const info = blocks.get(block)!;
          const lineHeight = parseFloat(info.style.lineHeight) || parseFloat(info.style.fontSize) * 1.8;
          // 多行容器本身的范围矩形不代表单行文字；只取其内部文本矩形。
          if (rect.height > lineHeight * 1.5) continue;
          const start = Math.max(rect.left, info.bounds.left);
          const end = Math.min(rect.right, info.bounds.right);
          if (start < end) info.rectangles.push({ left: start, right: end, top: rect.top, bottom: rect.bottom });
        }
      }
    }
    const next = new Map<HTMLElement, Background>();
    const rules: string[] = [];
    for (const [block, info] of blocks) {
      const fullRange = document.createRange();
      fullRange.selectNodeContents(block);
      const fullRects: PaintRect[] = [];
      const lineHeight = parseFloat(info.style.lineHeight) || parseFloat(info.style.fontSize) * 1.8;
      for (const rect of fullRange.getClientRects()) {
        if (rect.width && rect.height && rect.height <= lineHeight * 1.5 && rect.bottom > 0 && rect.top < window.innerHeight)
          fullRects.push({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom });
      }
      const fullRows = mergeRows(fullRects);
      const rows = mergeRows(info.rectangles).flatMap((row) => {
        const full = fullRows.find((line) => Math.min(line.bottom, row.bottom) - Math.max(line.top, row.top) > 1);
        if (!full) return [];
        // 跨块 Range 会包含整段容器，单行列表项尤其容易被误当成整行文字。
        // 用段内实际内容限制宽度，仍保留行内对象和显式空格占用的范围。
        const left = Math.max(row.left, full.left);
        const right = Math.min(row.right, full.right);
        return left < right ? [{ ...row, left, right, full }] : [];
      });
      if (!rows.length) continue;
      const layoutWidth = parseFloat(info.style.width) + (info.style.boxSizing === 'border-box' ? 0 : (parseFloat(info.style.paddingLeft) || 0) + (parseFloat(info.style.paddingRight) || 0) + (parseFloat(info.style.borderLeftWidth) || 0) + (parseFloat(info.style.borderRightWidth) || 0));
      const scale = layoutWidth > 0 ? info.bounds.width / layoutWidth : 1;
      const pixels = window.devicePixelRatio || 1;
      const positions: string[] = [];
      const sizes: string[] = [];
      for (const row of rows) {
        const { full } = row;
        // Range 返回字形框，原生选区和光标使用含行距的行框。保留上下半行距，
        // 避免首帧原生背景在下一帧被字形高度替换后突然变矮。
        const lineStart = Math.max(info.bounds.left, full.left);
        const hit = document.elementFromPoint(lineStart + 1, (full.top + full.bottom) / 2);
        const unit = hit?.closest('.kp-unit');
        const unitHeight = unit ? parseFloat(window.getComputedStyle(unit).lineHeight) || 0 : 0;
        const height = Math.max(Math.max(lineHeight, unitHeight) * scale, full.bottom - full.top);
        const rowTop = (full.top + full.bottom - height) / 2;
        const x = Math.floor(row.left * pixels) / pixels;
        const y = Math.round(rowTop * pixels) / pixels;
        const endX = Math.ceil(row.right * pixels) / pixels;
        const endY = Math.round((rowTop + height) * pixels) / pixels;
        positions.push(`${((x - info.bounds.left) / scale).toFixed(3)}px ${((y - info.bounds.top) / scale).toFixed(3)}px`);
        sizes.push(`${((endX - x) / scale).toFixed(3)}px ${((endY - y) / scale).toFixed(3)}px`);
      }
      const background = painted.get(block) ?? {
        image: info.style.backgroundImage, position: info.style.backgroundPosition,
        size: info.style.backgroundSize, repeat: info.style.backgroundRepeat,
        origin: info.style.backgroundOrigin, clip: info.style.backgroundClip,
      };
      next.set(block, background);
      const selector = blockSelector(root, block, scope);
      const color = 'var(--md-editor-text-selection-bg, color-mix(in srgb, var(--md-editor-accent, Highlight) 70%, var(--md-editor-document-bg, Canvas) 30%))';
      const image = rows.map(() => `linear-gradient(${color},${color})`).join(',');
      const append = (values: string[], original: string) => values.join(',') + (background.image === 'none' ? '' : `,${original}`);
      rules.push(`${selector} {
        background-image: ${append([image], background.image)} !important;
        background-position: ${append(positions, background.position)} !important;
        background-size: ${append(sizes, background.size)} !important;
        background-repeat: ${append(rows.map(() => 'no-repeat'), background.repeat)} !important;
        background-origin: ${append(rows.map(() => 'border-box'), background.origin)} !important;
        background-clip: ${append(rows.map(() => 'border-box'), background.clip)} !important;
      }`);
      rules.push(`${selector} .pm-inline-selection-bridge,
        ${selector} .pm-inline-code-selection-bridge { background: transparent !important; }`);
      rules.push(`${selector}::selection,
        ${selector} :not(input):not(textarea)::selection { background: transparent !important; color: inherit; }`);
      for (const code of block.querySelectorAll<HTMLElement>('code')) {
        if (code.closest('pre')) continue;
        let selected = false;
        for (let index = 0; selection && index < selection.rangeCount; index++) {
          if (selection.getRangeAt(index).intersectsNode(code)) { selected = true; break; }
        }
        if (selected) rules.push(`${blockSelector(root, code, scope)} {
          background: transparent !important; border-color: transparent !important; box-shadow: none !important;
        }`);
      }
      rules.push(`${selector} a:has(.pm-inline-atom-selection-bridge .image-node.is-badge) { box-shadow: none !important; }`);
    }
    // CSSOM 写入不会进入正文快照，也不触发编辑器的 DOMObserver。
    writeRules(rules);
    painted = next;
  };
  const schedule = () => {
    if (destroyed) return;
    const selection = selectionForRoot(root);
    // 同步撤掉桥接背景和行内对象的选中样式，避免下一帧只剩一条矮补色。
    root.toggleAttribute(ACTIVE_ATTRIBUTE, !!selection);
    if (!selection) {
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      frame = undefined;
      writeRules([]);
      painted.clear();
    } else if (frame === undefined) frame = window.requestAnimationFrame(refresh);
  };
  document.addEventListener('selectionchange', schedule);
  document.addEventListener('focusin', schedule);
  document.addEventListener('focusout', schedule);
  window.addEventListener('scroll', schedule, true);
  window.addEventListener('resize', schedule);
  schedule();
  return {
    schedule,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      document.removeEventListener('selectionchange', schedule);
      document.removeEventListener('focusin', schedule);
      document.removeEventListener('focusout', schedule);
      window.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', schedule);
      painted.clear();
      if (originalMarker === null) root.removeAttribute(ROOT_ATTRIBUTE);
      else root.setAttribute(ROOT_ATTRIBUTE, originalMarker);
      if (originalActive === null) root.removeAttribute(ACTIVE_ATTRIBUTE);
      else root.setAttribute(ACTIVE_ATTRIBUTE, originalActive);
      release();
    },
  };
}
