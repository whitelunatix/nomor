import { writable } from 'svelte/store';

export interface OutlinePanelPosition {
  /** 编辑区内的偏移，不包含标题栏、侧栏或屏幕坐标。 */
  left: number;
  top: number;
}

const STORAGE_KEY = 'newmd.outline.position.v1';

function parsePosition(value: string | null): OutlinePanelPosition | null {
  try {
    const position = JSON.parse(value ?? 'null');
    return position && Number.isFinite(position.left) && Number.isFinite(position.top)
      ? { left: position.left, top: position.top }
      : null;
  } catch {
    return null;
  }
}

const position = writable<OutlinePanelPosition | null>(null, (set) => {
  if (typeof window === 'undefined') return;
  try {
    set(parsePosition(window.localStorage.getItem(STORAGE_KEY)));
  } catch {
    // 本地存储不可用时仍允许在当前窗口拖动。
  }
  const handleStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY || event.key === null) {
      set(parsePosition(event.newValue));
    }
  };
  window.addEventListener('storage', handleStorage);
  return () => window.removeEventListener('storage', handleStorage);
});

export const outlinePanelPosition = { subscribe: position.subscribe };

export function saveOutlinePanelPosition(value: OutlinePanelPosition) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // 位置保存失败不影响编辑或拖动。
  }
  position.set(value);
}

export function resetOutlinePanelPosition() {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // 即使持久化不可用，也恢复当前窗口的默认布局。
  }
  position.set(null);
}
