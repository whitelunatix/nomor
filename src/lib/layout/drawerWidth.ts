/**
 * 右侧抽屉的通用宽度偏好。
 *
 * 文档大纲/属性抽屉与 AI 助手抽屉都贴在卡片右侧，交互一致：
 * 拖动左边缘改变宽度、双击恢复默认、方向键微调。两者各自保存一份偏好，
 * 但共用同一套「夹取值域 + 写入 localStorage + 同步根元素变量」的逻辑。
 */

export interface DrawerWidthOptions {
  /** localStorage 键。 */
  storageKey: string;
  /** 根元素上的宽度自定义属性，抽屉与正文预留空间共用。 */
  cssVariable: string;
  minWidth: number;
  maxWidth: number;
  /** 数值非法（NaN）时的兜底宽度。 */
  defaultWidth: number;
}

export interface DrawerWidthPreference {
  readonly storageKey: string;
  readonly cssVariable: string;
  readonly minWidth: number;
  readonly maxWidth: number;
  readonly defaultWidth: number;
  clamp(value: number): number;
  parse(raw: string | null | undefined): number | null;
  read(storage?: StorageLike | null): number | null;
  write(width: number | null, storage?: StorageLike | null): void;
  apply(width: number | null, root?: HTMLElement | null): void;
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function defaultStorage(): StorageLike | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    return localStorage;
  } catch {
    return null;
  }
}

export function createDrawerWidthPreference(options: DrawerWidthOptions): DrawerWidthPreference {
  const { storageKey, cssVariable, minWidth, maxWidth, defaultWidth } = options;

  function clamp(value: number): number {
    if (!Number.isFinite(value)) return defaultWidth;
    return Math.min(maxWidth, Math.max(minWidth, Math.round(value)));
  }

  function parse(raw: string | null | undefined): number | null {
    if (!raw) return null;
    const value = Number.parseFloat(raw);
    return Number.isFinite(value) ? clamp(value) : null;
  }

  function read(storage: StorageLike | null = defaultStorage()): number | null {
    if (!storage) return null;
    try {
      return parse(storage.getItem(storageKey));
    } catch {
      return null;
    }
  }

  function write(width: number | null, storage: StorageLike | null = defaultStorage()): void {
    if (!storage) return;
    try {
      if (width == null) storage.removeItem(storageKey);
      else storage.setItem(storageKey, String(clamp(width)));
    } catch {
      // 隐私模式或配额受限时只保留本次会话的宽度。
    }
  }

  function apply(
    width: number | null,
    root: HTMLElement | null = typeof document === 'undefined' ? null : document.documentElement,
  ): void {
    if (!root) return;
    if (width == null) root.style.removeProperty(cssVariable);
    else root.style.setProperty(cssVariable, `${clamp(width)}px`);
  }

  return {
    storageKey,
    cssVariable,
    minWidth,
    maxWidth,
    defaultWidth,
    clamp,
    parse,
    read,
    write,
    apply,
  };
}
