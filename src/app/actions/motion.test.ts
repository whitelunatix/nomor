import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gsap } from 'gsap';
import { modePaneMotion } from './motion';

vi.mock('gsap', () => ({
  gsap: {
    fromTo: vi.fn(),
    set: vi.fn(),
    to: vi.fn(() => ({ kill: vi.fn() })),
  },
}));

describe('modePaneMotion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    );
  });

  afterEach(() => vi.unstubAllGlobals());

  it('keeps the target hidden until split alignment is ready, then cross-fades opacity only', () => {
    const { grid, sourcePane, semanticPane, divider } = createGrid();
    const action = modePaneMotion(grid, { mode: 'semantic' });

    action.update({ mode: 'split' });
    expect(grid.getAttribute('aria-busy')).toBe('true');
    expect(sourcePane.inert).toBe(true);
    expect(semanticPane.inert).toBe(true);
    expect(gsap.to).not.toHaveBeenCalled();

    grid.dispatchEvent(new CustomEvent('nomo:mode-pane-ready', { detail: { mode: 'source' } }));
    expect(gsap.to).not.toHaveBeenCalled();
    grid.dispatchEvent(new CustomEvent('nomo:mode-pane-ready', { detail: { mode: 'split' } }));

    expect(gsap.to).toHaveBeenCalledTimes(1);
    const [targets, vars] = vi.mocked(gsap.to).mock.calls[0];
    expect(targets).toEqual([sourcePane, divider]);
    expect(vars).toMatchObject({ duration: 0.14, overwrite: true });
    expect(vars).not.toHaveProperty('x');
    expect(vars).not.toHaveProperty('y');
    expect(vars).not.toHaveProperty('scale');

    (vars as { onComplete: () => void }).onComplete();
    expect(grid.hasAttribute('aria-busy')).toBe(false);
    expect(sourcePane.inert).toBe(false);
    expect(semanticPane.inert).toBe(false);
    action.destroy();
  });

  it('kills a superseded tween and leaves only the latest mode interactive', () => {
    const { grid, sourcePane, semanticPane } = createGrid();
    const firstTween = { kill: vi.fn() };
    const secondTween = { kill: vi.fn() };
    vi.mocked(gsap.to)
      .mockReturnValueOnce(firstTween as never)
      .mockReturnValueOnce(secondTween as never);
    const action = modePaneMotion(grid, { mode: 'semantic' });

    action.update({ mode: 'source' });
    grid.dispatchEvent(new CustomEvent('nomo:mode-pane-ready', { detail: { mode: 'source' } }));
    action.update({ mode: 'split' });
    expect(firstTween.kill).toHaveBeenCalledTimes(1);

    grid.dispatchEvent(new CustomEvent('nomo:mode-pane-ready', { detail: { mode: 'split' } }));
    const latestVars = vi.mocked(gsap.to).mock.calls[1][1] as { onComplete: () => void };
    latestVars.onComplete();
    expect(sourcePane.inert).toBe(false);
    expect(semanticPane.inert).toBe(false);
    expect(grid.dataset.modeTransitionTo).toBeUndefined();
    action.destroy();
  });

  it('still waits for readiness but switches instantly with reduced motion', () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    );
    const { grid } = createGrid();
    const action = modePaneMotion(grid, { mode: 'semantic' });

    action.update({ mode: 'source' });
    expect(grid.getAttribute('aria-busy')).toBe('true');
    grid.dispatchEvent(new CustomEvent('nomo:mode-pane-ready', { detail: { mode: 'source' } }));

    expect(gsap.to).not.toHaveBeenCalled();
    expect(grid.hasAttribute('aria-busy')).toBe(false);
    action.destroy();
  });

  it('removes readiness listeners and temporary state on destroy', () => {
    const { grid } = createGrid();
    const action = modePaneMotion(grid, { mode: 'semantic' });
    action.update({ mode: 'source' });
    action.destroy();
    vi.mocked(gsap.to).mockClear();

    grid.dispatchEvent(new CustomEvent('nomo:mode-pane-ready', { detail: { mode: 'source' } }));
    expect(gsap.to).not.toHaveBeenCalled();
    expect(grid.hasAttribute('aria-busy')).toBe(false);
    expect(grid.dataset.modeTransitionFrom).toBeUndefined();
  });
});

function createGrid() {
  const grid = document.createElement('div');
  const sourcePane = document.createElement('section');
  const semanticPane = document.createElement('section');
  const divider = document.createElement('div');
  sourcePane.className = 'source-pane';
  semanticPane.className = 'semantic-pane';
  divider.className = 'split-divider';
  grid.append(sourcePane, divider, semanticPane);
  return { grid, sourcePane, semanticPane, divider };
}
