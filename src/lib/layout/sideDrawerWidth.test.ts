import { describe, expect, it, vi } from 'vitest';
import {
  SIDE_DRAWER_MAX_WIDTH,
  SIDE_DRAWER_MIN_WIDTH,
  SIDE_DRAWER_STORAGE_KEY,
  applySideDrawerWidth,
  clampSideDrawerWidth,
  parseStoredSideDrawerWidth,
  readStoredSideDrawerWidth,
  writeStoredSideDrawerWidth,
} from './sideDrawerWidth';

function createStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => void values.set(key, value)),
    removeItem: vi.fn((key: string) => void values.delete(key)),
  };
}

describe('sideDrawerWidth', () => {
  it('clamps widths into the draggable range', () => {
    expect(clampSideDrawerWidth(120)).toBe(SIDE_DRAWER_MIN_WIDTH);
    expect(clampSideDrawerWidth(900)).toBe(SIDE_DRAWER_MAX_WIDTH);
    expect(clampSideDrawerWidth(333.6)).toBe(334);
    expect(clampSideDrawerWidth(Number.NaN)).toBe(360);
  });

  it('parses persisted values and ignores corrupted entries', () => {
    expect(parseStoredSideDrawerWidth('420')).toBe(420);
    expect(parseStoredSideDrawerWidth('9999')).toBe(SIDE_DRAWER_MAX_WIDTH);
    expect(parseStoredSideDrawerWidth('wide')).toBeNull();
    expect(parseStoredSideDrawerWidth(null)).toBeNull();
  });

  it('round-trips through storage and clears the preference for the default width', () => {
    const storage = createStorage();

    writeStoredSideDrawerWidth(412.4, storage);
    expect(storage.setItem).toHaveBeenCalledWith(SIDE_DRAWER_STORAGE_KEY, '412');
    expect(readStoredSideDrawerWidth(storage)).toBe(412);

    writeStoredSideDrawerWidth(null, storage);
    expect(storage.removeItem).toHaveBeenCalledWith(SIDE_DRAWER_STORAGE_KEY);
    expect(readStoredSideDrawerWidth(storage)).toBeNull();
  });

  it('writes the shared custom property so the drawer and its reserved space stay in sync', () => {
    const root = document.createElement('div');

    applySideDrawerWidth(480, root);
    expect(root.style.getPropertyValue('--side-drawer-width')).toBe('480px');

    applySideDrawerWidth(null, root);
    expect(root.style.getPropertyValue('--side-drawer-width')).toBe('');
  });
});
