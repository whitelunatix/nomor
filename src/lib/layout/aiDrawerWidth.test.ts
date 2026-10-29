import { describe, expect, it, vi } from 'vitest';
import {
  AI_DRAWER_MAX_WIDTH,
  AI_DRAWER_MIN_WIDTH,
  AI_DRAWER_STORAGE_KEY,
  applyAiDrawerWidth,
  clampAiDrawerWidth,
  parseStoredAiDrawerWidth,
  readStoredAiDrawerWidth,
  writeStoredAiDrawerWidth,
} from './aiDrawerWidth';

function createStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => void values.set(key, value)),
    removeItem: vi.fn((key: string) => void values.delete(key)),
  };
}

describe('aiDrawerWidth', () => {
  it('clamps into the AI drawer range', () => {
    expect(clampAiDrawerWidth(100)).toBe(AI_DRAWER_MIN_WIDTH);
    expect(clampAiDrawerWidth(2400)).toBe(AI_DRAWER_MAX_WIDTH);
    expect(clampAiDrawerWidth(512.4)).toBe(512);
    expect(clampAiDrawerWidth(Number.NaN)).toBe(430);
  });

  it('parses and ignores corrupted values', () => {
    expect(parseStoredAiDrawerWidth('500')).toBe(500);
    expect(parseStoredAiDrawerWidth('9000')).toBe(AI_DRAWER_MAX_WIDTH);
    expect(parseStoredAiDrawerWidth('narrow')).toBeNull();
    expect(parseStoredAiDrawerWidth(null)).toBeNull();
  });

  it('uses its own storage key so the two drawers remember separate widths', () => {
    const storage = createStorage();

    writeStoredAiDrawerWidth(600.2, storage);
    expect(storage.setItem).toHaveBeenCalledWith(AI_DRAWER_STORAGE_KEY, '600');
    expect(readStoredAiDrawerWidth(storage)).toBe(600);

    writeStoredAiDrawerWidth(null, storage);
    expect(storage.removeItem).toHaveBeenCalledWith(AI_DRAWER_STORAGE_KEY);
    expect(readStoredAiDrawerWidth(storage)).toBeNull();
  });

  it('writes the AI drawer custom property and clears it for the CSS default', () => {
    const root = document.createElement('div');

    applyAiDrawerWidth(540, root);
    expect(root.style.getPropertyValue('--ai-drawer-width')).toBe('540px');

    applyAiDrawerWidth(null, root);
    expect(root.style.getPropertyValue('--ai-drawer-width')).toBe('');
  });
});
