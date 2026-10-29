import { gsap } from 'gsap';
import type { TransitionConfig } from 'svelte/transition';

type MotionKind = 'micro' | 'popover' | 'panel' | 'row' | 'mode';

const durationByKind: Record<MotionKind, number> = {
  micro: 0.12,
  popover: 0.16,
  panel: 0.22,
  row: 0.18,
  mode: 0.14,
};

const reducedDurationByKind: Record<MotionKind, number> = {
  micro: 0.08,
  popover: 0.09,
  panel: 0.1,
  row: 0.09,
  mode: 0.08,
};

const ease = 'power2.out';
const reducedMotionQuery = '(prefers-reduced-motion: reduce)';

function getMotionQuery(): MediaQueryList | null {
  if (typeof window === 'undefined' || !window.matchMedia) {
    return null;
  }
  return window.matchMedia(reducedMotionQuery);
}

function prefersReducedMotion(): boolean {
  return getMotionQuery()?.matches ?? false;
}

function motionDuration(kind: MotionKind = 'micro'): number {
  return prefersReducedMotion() ? reducedDurationByKind[kind] : durationByKind[kind];
}

export function transitionDuration(kind: MotionKind = 'micro'): number {
  return Math.round(motionDuration(kind) * 1000);
}

export function outlinePanelTransition(node: HTMLElement): TransitionConfig {
  const duration = transitionDuration('popover');
  const style = getComputedStyle(node);
  const baseTransform = style.transform === 'none' ? '' : style.transform;

  return {
    duration,
    css: (t, u) => `
      opacity: ${t};
      transform: ${baseTransform} translateY(${u * -4}px) scale(${0.98 + t * 0.02});
      visibility: ${t === 0 ? 'hidden' : 'visible'};
    `,
  };
}

export function outlineRowTransition(node: HTMLElement): TransitionConfig {
  const duration = transitionDuration('row');
  const style = getComputedStyle(node);
  const height = node.offsetHeight;
  const marginBottom = parseFloat(style.marginBottom) || 0;
  const opacity = parseFloat(style.opacity) || 1;

  return {
    duration,
    css: (t, u) => `
      height: ${t * height}px;
      min-height: 0;
      margin-bottom: ${t * marginBottom}px;
      opacity: ${t * opacity};
      overflow: hidden;
      transform: translateY(${u * -3}px);
    `,
  };
}

type MotionInOptions = {
  kind?: MotionKind;
  y?: number;
  x?: number;
  scale?: number;
  delay?: number;
};

export function motionIn(node: HTMLElement, options: MotionInOptions = {}) {
  const {
    kind = 'popover',
    y = kind === 'row' ? -4 : 6,
    x = 0,
    scale = kind === 'popover' ? 0.98 : 1,
    delay = 0,
  } = options;
  let tween: gsap.core.Tween | null = null;

  const reduced = prefersReducedMotion();
  tween = gsap.fromTo(
    node,
    { autoAlpha: reduced ? 0.78 : 0, x: reduced ? 0 : x, y: reduced ? 0 : y, scale: 1 },
    {
      autoAlpha: 1,
      x: 0,
      y: 0,
      scale: 1,
      duration: motionDuration(kind),
      delay,
      ease,
      overwrite: 'auto',
      clearProps: 'transform,visibility',
    },
  );

  return {
    destroy() {
      tween?.kill();
    },
  };
}

export function pulseOnChange(node: HTMLElement, value: unknown) {
  let previous = value;
  let initialized = false;
  let tween: gsap.core.Tween | null = null;

  function pulse() {
    tween?.kill();
    tween = gsap.fromTo(
      node,
      { scale: prefersReducedMotion() ? 0.98 : 0.94 },
      {
        scale: 1,
        duration: motionDuration('micro'),
        ease: 'back.out(1.7)',
        overwrite: true,
        clearProps: 'transform',
      },
    );
  }

  return {
    update(nextValue: unknown) {
      if (!initialized) {
        initialized = true;
        previous = nextValue;
        return;
      }
      if (nextValue !== previous) {
        previous = nextValue;
        pulse();
      }
    },
    destroy() {
      tween?.kill();
    },
  };
}

type SidebarParams = {
  focusMode: boolean;
  isResizing: boolean;
  disabled?: boolean;
};

// 曲线与时长沿用原 GSAP 版本：power2.inOut，完整展开 280ms、收起 240ms；中途反向按剩余距离等比缩短。
const SIDEBAR_EXPAND_MS = 280;
const SIDEBAR_COLLAPSE_MS = 240;
const SIDEBAR_EASING = 'cubic-bezier(0.45, 0, 0.55, 1)';

// 正文定位锚点：各窗格 .document-layout 中决定文字水平位置的列。
const CONTENT_ANCHOR_SELECTOR = ':scope > .prosemirror-host, :scope > .source-editor';

type ContentShift = {
  layout: HTMLElement;
  /** 完全展开时需补偿的水平位移（px）= 正文在展开布局与铺满布局下相对编辑区左缘的位置差；位移随进度线性变化。 */
  distance: number;
};

type SidebarSlide = {
  animations: Animation[];
  /** 侧栏动画，用于识别是否已被反向切换取代。 */
  railAnimation: Animation;
  /** 动画开始时测得的侧栏宽度（px），反向衔接时沿用。 */
  railWidth: number;
  shifts: ContentShift[];
};

/**
 * 侧栏收展动画（推挤式）：收展期间网格列归零，侧栏浮于左侧、编辑区铺满，
 * 两者用 Web Animations 同步平移 transform，编辑区左缘始终贴住侧栏右缘。
 * 编辑区宽度只在动画起止各变一次，居中正文因此产生的位移由 .document-layout 的反向平移补偿，
 * 使正文全程连续移动。全部为 transform 动画，由合成器执行，低电量模式下主线程被节流也不掉帧。
 */
export function workspaceSidebarMotion(node: HTMLElement, params: SidebarParams) {
  let currentParams = params;
  let slide: SidebarSlide | null = null;

  function getParts() {
    const rail = node.querySelector<HTMLElement>(':scope > .rail');
    const editor = node.querySelector<HTMLElement>(':scope > .editor-shell');
    if (!rail || !editor || typeof rail.animate !== 'function') return null;
    return { rail, editor };
  }

  // 撤销平移并回到静态布局；与删除 data-sidebar-animating 同步执行，避免中间帧错位。
  function stopSlide() {
    slide?.animations.forEach((animation) => animation.cancel());
    slide = null;
    delete node.dataset.sidebarAnimating;
    delete node.dataset.sidebarMeasureExpanded;
  }

  // 读取各窗格正文锚点相对编辑区左缘的水平位置；会强制同步布局，只在动画开始时调用。
  function measureContentOffsets(editor: HTMLElement) {
    const editorLeft = editor.getBoundingClientRect().left;
    const offsets = new Map<HTMLElement, number>();
    editor.querySelectorAll<HTMLElement>('.document-layout').forEach((layout) => {
      const anchor = layout.querySelector<HTMLElement>(CONTENT_ANCHOR_SELECTOR) ?? layout;
      const rect = anchor.getBoundingClientRect();
      if (rect.width > 0) offsets.set(layout, rect.left - editorLeft);
    });
    return offsets;
  }

  // 展开进度：0 为收起，1 为展开。须在撤销旧动画前调用，读到的是侧栏当前动画帧的位置。
  function readProgress(rail: HTMLElement, railWidth: number) {
    const x = new DOMMatrixReadOnly(getComputedStyle(rail).transform).m41;
    return Math.min(1, Math.max(0, 1 + x / railWidth));
  }

  /**
   * 切到动画布局并测量侧栏宽度与正文补偿量。update 可能先于父级 focus-mode 类名生效，
   * 所以不依赖当前布局：用 data-sidebar-measure-expanded 显式强制展开态测量，再切到铺满态测量。
   * 共强制两次布局，仅在每次收展开始时发生。
   */
  function prepareLayout(rail: HTMLElement, editor: HTMLElement) {
    node.dataset.sidebarMeasureExpanded = '';
    const expandedOffsets = measureContentOffsets(editor);
    delete node.dataset.sidebarMeasureExpanded;
    node.dataset.sidebarAnimating = '';
    const fullOffsets = measureContentOffsets(editor);
    const shifts: ContentShift[] = [];
    expandedOffsets.forEach((expandedOffset, layout) => {
      const fullOffset = fullOffsets.get(layout);
      if (fullOffset === undefined) return;
      const distance = expandedOffset - fullOffset;
      // 左对齐内容两种布局下位置一致，不必创建动画。
      if (Math.abs(distance) >= 0.5) shifts.push({ layout, distance });
    });
    return { railWidth: rail.getBoundingClientRect().width, shifts };
  }

  function startSlide(expand: boolean) {
    const parts = getParts();
    if (!parts) {
      stopSlide();
      return;
    }
    const { rail, editor } = parts;
    const previous = slide;
    const { railWidth, shifts } = previous ?? prepareLayout(rail, editor);
    if (railWidth <= 0) {
      stopSlide();
      return;
    }
    const from = previous ? readProgress(rail, railWidth) : expand ? 0 : 1;
    const to = expand ? 1 : 0;
    previous?.animations.forEach((animation) => animation.cancel());

    const timing: KeyframeAnimationOptions = {
      duration: (expand ? SIDEBAR_EXPAND_MS : SIDEBAR_COLLAPSE_MS) * Math.abs(to - from),
      // 中途反向时已有速度，用 ease-out 衔接，避免再从静止加速。
      easing: previous ? 'ease-out' : SIDEBAR_EASING,
      fill: 'forwards',
    };
    const slideX = (element: HTMLElement, fromX: number, toX: number) =>
      element.animate(
        [{ transform: `translateX(${fromX}px)` }, { transform: `translateX(${toX}px)` }],
        timing,
      );

    const railAnimation = slideX(rail, (from - 1) * railWidth, (to - 1) * railWidth);
    const animations = [
      railAnimation,
      slideX(editor, from * railWidth, to * railWidth),
      ...shifts.map(({ layout, distance }) => slideX(layout, from * distance, to * distance)),
    ];
    slide = { animations, railAnimation, railWidth, shifts };

    railAnimation.onfinish = () => {
      // 已被反向切换或撤销的旧动画不再处理。
      if (slide?.railAnimation === railAnimation) stopSlide();
    };
  }

  function sync(nextParams: SidebarParams, immediate = false) {
    const visibilityChanged = currentParams.focusMode !== nextParams.focusMode;
    const disabledChanged = currentParams.disabled !== nextParams.disabled;
    currentParams = nextParams;
    node.toggleAttribute('data-sidebar-motion', !nextParams.disabled);

    if (
      immediate ||
      prefersReducedMotion() ||
      nextParams.isResizing ||
      nextParams.disabled ||
      disabledChanged
    ) {
      stopSlide();
      return;
    }
    if (!visibilityChanged) return;
    startSlide(!nextParams.focusMode);
  }

  sync(currentParams, true);

  return {
    update(nextParams: SidebarParams) {
      sync(nextParams);
    },
    destroy() {
      stopSlide();
      delete node.dataset.sidebarMotion;
    },
  };
}

type ToolbarVisibilityParams = {
  hidden: boolean;
};

export function toolbarVisibilityMotion(node: HTMLElement, params: ToolbarVisibilityParams) {
  let previousHidden = params.hidden;
  let initialized = false;
  let tween: gsap.core.Tween | null = null;

  function sync(nextParams: ToolbarVisibilityParams) {
    const hidden = nextParams.hidden;

    if (initialized && hidden === previousHidden) return;

    tween?.kill();
    if (!initialized || prefersReducedMotion()) {
      if (hidden) {
        gsap.set(node, { autoAlpha: 0, y: -6 });
      } else {
        gsap.set(node, { clearProps: 'transform,opacity,visibility,willChange' });
      }
      initialized = true;
      previousHidden = hidden;
      return;
    }

    tween = gsap.to(node, {
      autoAlpha: hidden ? 0 : 1,
      y: hidden ? -6 : 0,
      willChange: 'transform, opacity',
      duration: motionDuration('panel'),
      ease,
      overwrite: true,
      ...(hidden
        ? {
            onComplete: () => gsap.set(node, { clearProps: 'willChange' }),
          }
        : {
            clearProps: 'transform,opacity,visibility,willChange',
          }),
    });
    previousHidden = hidden;
  }

  sync(params);

  return {
    update(nextParams: ToolbarVisibilityParams) {
      sync(nextParams);
    },
    destroy() {
      tween?.kill();
      gsap.set(node, { clearProps: 'transform,opacity,visibility,willChange' });
    },
  };
}

export type TabIndicatorGeometry = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type TabIndicatorParams = {
  activeTabId: string;
  visibleStart: number;
  visibleEnd: number;
  layoutKey: string;
  onGeometry?: (geometry: TabIndicatorGeometry | null) => void;
};

export function tabIndicator(node: HTMLElement, params: TabIndicatorParams) {
  let frame = 0;
  let initialized = false;
  let tween: gsap.core.Tween | null = null;
  let currentParams = params;
  const position = { x: 0, width: 0 };
  let originX = 0;
  let originY = 0;
  let indicatorHeight = 0;
  const shell = node.closest<HTMLElement>('.editor-shell');
  const motionQuery = getMotionQuery();

  function publishGeometry(indicator: HTMLElement) {
    gsap.set(indicator, { x: position.x, width: position.width });
    currentParams.onGeometry?.({
      x: originX + position.x,
      y: originY,
      width: position.width,
      height: indicatorHeight,
    });
  }

  function measure(animate: boolean) {
    frame = 0;
    const indicator = node.querySelector<HTMLElement>('.tab-active-indicator');
    const activeTab = node.querySelector<HTMLElement>('.doc-tab.active');
    if (!indicator || !activeTab) {
      tween?.kill();
      node.dataset.indicatorReady = 'false';
      initialized = false;
      currentParams.onGeometry?.(null);
      return;
    }

    const containerBounds = node.getBoundingClientRect();
    const activeBounds = activeTab.getBoundingClientRect();
    const shellBounds = (shell ?? node).getBoundingClientRect();
    const x = activeBounds.left - containerBounds.left;
    const width = activeBounds.width;
    indicatorHeight = indicator.getBoundingClientRect().height;
    originX = containerBounds.left - shellBounds.left;
    originY = containerBounds.bottom - shellBounds.top - indicatorHeight;

    tween?.kill();
    if (width <= 0 || indicatorHeight <= 0) {
      node.dataset.indicatorReady = 'false';
      initialized = false;
      currentParams.onGeometry?.(null);
      return;
    }
    if (!initialized || !animate || prefersReducedMotion()) {
      gsap.set(position, { x, width });
      publishGeometry(indicator);
    } else {
      // 填充、描边和阴影共用当前插值，动画帧不再读取 DOM 布局。
      tween = gsap.to(position, {
        x,
        width,
        duration: motionDuration('row'),
        ease,
        overwrite: true,
        onUpdate: () => publishGeometry(indicator),
      });
    }

    node.dataset.indicatorReady = 'true';
    initialized = true;
  }

  function queue(animate: boolean) {
    if (frame) cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => measure(animate));
  }

  const resizeObserver = new ResizeObserver(() => queue(false));
  const onMotionPreferenceChange = () => queue(false);
  resizeObserver.observe(node);
  if (node.parentElement) resizeObserver.observe(node.parentElement);
  if (shell) resizeObserver.observe(shell);
  motionQuery?.addEventListener('change', onMotionPreferenceChange);
  queue(false);

  return {
    update(nextParams: TabIndicatorParams) {
      const activeTabChanged = nextParams.activeTabId !== currentParams.activeTabId;
      const visibleRangeUnchanged =
        nextParams.visibleStart === currentParams.visibleStart &&
        nextParams.visibleEnd === currentParams.visibleEnd;
      currentParams = nextParams;
      queue(initialized && activeTabChanged && visibleRangeUnchanged);
    },
    destroy() {
      if (frame) cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      motionQuery?.removeEventListener('change', onMotionPreferenceChange);
      tween?.kill();
      currentParams.onGeometry?.(null);
    },
  };
}

type ExplorerSelectionIndicatorParams = {
  activePath: string;
  top: number | null;
  layoutKey: string;
  renderKey: string;
};

export function explorerSelectionIndicator(
  node: HTMLElement,
  params: ExplorerSelectionIndicatorParams,
) {
  let frame = 0;
  let initialized = false;
  let tween: gsap.core.Tween | null = null;
  let currentParams = params;

  function measure(nextParams: ExplorerSelectionIndicatorParams, animate: boolean) {
    frame = 0;
    const indicator = node.querySelector<HTMLElement>('.explorer-selection-indicator');
    const selectedRow = node.querySelector<HTMLElement>('.tree-file.selected');
    if (!indicator || !selectedRow || nextParams.top === null) {
      tween?.kill();
      node.dataset.selectionReady = 'false';
      initialized = false;
      return;
    }

    const viewportRect = node.getBoundingClientRect();
    const selectedRect = selectedRow.getBoundingClientRect();
    const paddingLeft = Number.parseFloat(getComputedStyle(selectedRow).paddingLeft) || 0;
    const x = Math.max(8, selectedRect.left - viewportRect.left + paddingLeft - 10);
    const y =
      selectedRect.top -
      viewportRect.top +
      (selectedRect.height - indicator.offsetHeight) / 2;
    tween?.kill();
    if (!initialized || !animate || prefersReducedMotion()) {
      gsap.set(indicator, { x, y });
    } else {
      tween = gsap.to(indicator, {
        x,
        y,
        duration: motionDuration('row'),
        ease,
        overwrite: true,
      });
    }

    node.dataset.selectionReady = 'true';
    initialized = true;
  }

  function queue(nextParams: ExplorerSelectionIndicatorParams, animate: boolean) {
    if (frame) cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => measure(nextParams, animate));
  }

  queue(params, false);

  return {
    update(nextParams: ExplorerSelectionIndicatorParams) {
      const activePathChanged = nextParams.activePath !== currentParams.activePath;
      const layoutUnchanged = nextParams.layoutKey === currentParams.layoutKey;
      currentParams = nextParams;
      queue(nextParams, initialized && activePathChanged && layoutUnchanged);
    },
    destroy() {
      if (frame) cancelAnimationFrame(frame);
      tween?.kill();
    },
  };
}

type ModeSwitchParams = {
  mode: string;
};

export function modeSwitchIndicator(node: HTMLElement, params: ModeSwitchParams) {
  let previousMode = params.mode;
  let initialized = false;
  let tween: gsap.core.Tween | null = null;

  function sync(nextParams: ModeSwitchParams) {
    const activeButton = node.querySelector<HTMLElement>('button.active');
    if (!activeButton) return;

    const x = activeButton.offsetLeft;
    const width = activeButton.offsetWidth;

    tween?.kill();
    if (!initialized || prefersReducedMotion()) {
      gsap.set(node, {
        '--mode-indicator-x': `${x}px`,
        '--mode-indicator-width': `${width}px`,
      });
      initialized = true;
      previousMode = nextParams.mode;
      return;
    }

    if (previousMode !== nextParams.mode) {
      tween = gsap.to(node, {
        '--mode-indicator-x': `${x}px`,
        '--mode-indicator-width': `${width}px`,
        duration: motionDuration('mode'),
        ease,
        overwrite: true,
      });
      previousMode = nextParams.mode;
    }
  }

  requestAnimationFrame(() => sync(params));

  return {
    update(nextParams: ModeSwitchParams) {
      requestAnimationFrame(() => sync(nextParams));
    },
    destroy() {
      tween?.kill();
    },
  };
}

type ModePaneParams = {
  mode: string;
  disabled?: boolean;
};

export function modePaneMotion(node: HTMLElement, params: ModePaneParams) {
  let previousMode = params.mode;
  let tween: gsap.core.Tween | null = null;
  let transitionSequence = 0;
  let pendingTransition: {
    sequence: number;
    mode: string;
    fadeIn: HTMLElement[];
    fadeOut: HTMLElement[];
  } | null = null;

  const sourcePane = node.querySelector<HTMLElement>('.source-pane');
  const semanticPane = node.querySelector<HTMLElement>('.semantic-pane');
  const divider = node.querySelector<HTMLElement>('.split-divider');

  function getPane(mode: string) {
    return mode === 'source' ? sourcePane : semanticPane;
  }

  function setRestingInteractivity(mode: string) {
    const split = mode === 'split';
    if (sourcePane) {
      sourcePane.inert = !split && mode !== 'source';
      sourcePane.setAttribute('aria-hidden', String(!split && mode !== 'source'));
    }
    if (semanticPane) {
      semanticPane.inert = !split && mode !== 'semantic';
      semanticPane.setAttribute('aria-hidden', String(!split && mode !== 'semantic'));
    }
  }

  function clearTransitionStyles() {
    const targets = [sourcePane, semanticPane, divider].filter((target): target is HTMLElement =>
      Boolean(target),
    );
    if (targets.length > 0) {
      gsap.set(targets, { clearProps: 'display,opacity,visibility,pointerEvents' });
    }
  }

  function finishTransition(sequence: number, mode: string) {
    if (!pendingTransition || pendingTransition.sequence !== sequence) return;
    tween = null;
    pendingTransition = null;
    clearTransitionStyles();
    node.removeAttribute('aria-busy');
    delete node.dataset.modeTransitionFrom;
    delete node.dataset.modeTransitionTo;
    setRestingInteractivity(mode);
    node.dispatchEvent(new CustomEvent('nomo:mode-pane-transition-complete'));
  }

  function cancelTransition(nextMode: string) {
    transitionSequence += 1;
    tween?.kill();
    tween = null;
    pendingTransition = null;
    clearTransitionStyles();
    node.removeAttribute('aria-busy');
    delete node.dataset.modeTransitionFrom;
    delete node.dataset.modeTransitionTo;
    setRestingInteractivity(nextMode);
  }

  function prepareTransition(fromMode: string, nextMode: string) {
    cancelTransition(nextMode);
    const sequence = transitionSequence;
    const fadeIn: HTMLElement[] = [];
    const fadeOut: HTMLElement[] = [];
    node.setAttribute('aria-busy', 'true');
    node.dataset.modeTransitionFrom = fromMode;
    node.dataset.modeTransitionTo = nextMode;

    if (sourcePane) sourcePane.inert = true;
    if (semanticPane) semanticPane.inert = true;

    if (fromMode === 'split' && nextMode !== 'split') {
      const targetPane = getPane(nextMode);
      const discardedPane = targetPane === sourcePane ? semanticPane : sourcePane;
      if (targetPane) gsap.set(targetPane, { display: 'block', autoAlpha: 1 });
      if (discardedPane) {
        gsap.set(discardedPane, { display: 'block', autoAlpha: 1 });
        fadeOut.push(discardedPane);
      }
      if (divider) {
        gsap.set(divider, { display: 'block', autoAlpha: 1 });
        fadeOut.push(divider);
      }
    } else if (fromMode !== 'split' && nextMode === 'split') {
      const stablePane = getPane(fromMode);
      const joiningPane = stablePane === sourcePane ? semanticPane : sourcePane;
      if (stablePane) gsap.set(stablePane, { display: 'block', autoAlpha: 1 });
      if (joiningPane) {
        gsap.set(joiningPane, { display: 'block', autoAlpha: 0 });
        fadeIn.push(joiningPane);
      }
      if (divider) {
        gsap.set(divider, { display: 'block', autoAlpha: 0 });
        fadeIn.push(divider);
      }
    } else {
      const outgoingPane = getPane(fromMode);
      const incomingPane = getPane(nextMode);
      if (outgoingPane) {
        gsap.set(outgoingPane, { display: 'block', autoAlpha: 1 });
        fadeOut.push(outgoingPane);
      }
      if (incomingPane) {
        gsap.set(incomingPane, { display: 'block', autoAlpha: 0 });
        fadeIn.push(incomingPane);
      }
    }

    pendingTransition = { sequence, mode: nextMode, fadeIn, fadeOut };
  }

  function revealPreparedPane(event: Event) {
    const detail = (event as CustomEvent<{ mode?: string }>).detail;
    const transition = pendingTransition;
    if (!transition || detail?.mode !== transition.mode) return;

    const targets = [...transition.fadeOut, ...transition.fadeIn];
    if (targets.length === 0 || prefersReducedMotion()) {
      if (transition.fadeOut.length > 0) gsap.set(transition.fadeOut, { autoAlpha: 0 });
      if (transition.fadeIn.length > 0) gsap.set(transition.fadeIn, { autoAlpha: 1 });
      finishTransition(transition.sequence, transition.mode);
      return;
    }

    tween?.kill();
    tween = gsap.to(targets, {
      autoAlpha: (index) => (index < transition.fadeOut.length ? 0 : 1),
      duration: motionDuration('mode'),
      ease,
      overwrite: true,
      onComplete: () => finishTransition(transition.sequence, transition.mode),
    });
  }

  function sync(nextParams: ModePaneParams) {
    if (nextParams.disabled) {
      cancelTransition(nextParams.mode);
      previousMode = nextParams.mode;
      return;
    }
    if (previousMode === nextParams.mode) return;
    prepareTransition(previousMode, nextParams.mode);
    previousMode = nextParams.mode;
  }

  node.addEventListener('nomo:mode-pane-ready', revealPreparedPane);
  setRestingInteractivity(params.mode);

  return {
    update(nextParams: ModePaneParams) {
      sync(nextParams);
    },
    destroy() {
      node.removeEventListener('nomo:mode-pane-ready', revealPreparedPane);
      tween?.kill();
      clearTransitionStyles();
      node.removeAttribute('aria-busy');
      delete node.dataset.modeTransitionFrom;
      delete node.dataset.modeTransitionTo;
    },
  };
}
