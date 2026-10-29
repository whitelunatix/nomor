import {
  outlinePanelPosition,
  saveOutlinePanelPosition,
  type OutlinePanelPosition,
} from '../services/outlinePanelPosition';

const MARGIN = 8;
const DRAG_THRESHOLD = 5;

/** 顶部区域移动面板；章节列表继续使用 EditorWorkspace 自己的拖拽状态机。 */
export function outlinePanelDrag(node: HTMLElement) {
  const grid = node.closest<HTMLElement>('.editor-grid')!;
  const dragRegion = node.querySelector<HTMLElement>('.content-outline-header')!;
  let saved: OutlinePanelPosition | null = null;
  let frame = 0;
  let destroyed = false;
  let drag: {
    pointerId: number;
    x: number;
    y: number;
    origin: OutlinePanelPosition;
    current: OutlinePanelPosition;
    maxLeft: number;
    maxTop: number;
    moved: boolean;
  } | null = null;

  function constrain(value: OutlinePanelPosition): OutlinePanelPosition {
    return {
      left: Math.min(
        Math.max(MARGIN, value.left),
        Math.max(MARGIN, grid.clientWidth - node.offsetWidth - MARGIN),
      ),
      top: Math.min(
        Math.max(MARGIN, value.top),
        Math.max(MARGIN, grid.clientHeight - node.offsetHeight - MARGIN),
      ),
    };
  }

  function place(value: OutlinePanelPosition) {
    node.style.left = `${value.left}px`;
    node.style.top = `${value.top}px`;
  }

  function restore() {
    node.classList.remove('outline-panel-moving');
    node.toggleAttribute('data-floating', saved !== null);
    node.toggleAttribute('data-positioned', saved !== null);
    if (saved) {
      place(constrain(saved));
    } else {
      node.style.removeProperty('left');
      node.style.removeProperty('top');
    }
  }

  function scheduleConstraint() {
    if (frame || destroyed || !saved) return;
    frame = window.requestAnimationFrame(() => {
      frame = 0;
      // 窄窗口、后台标签和隐藏工作区不覆盖记忆位置，重新可见后再约束。
      if (saved && !drag && grid.clientWidth > 0 && node.offsetWidth > 0) restore();
    });
  }

  function stopDrag() {
    const previous = drag;
    drag = null;
    window.removeEventListener('pointermove', handleMove);
    window.removeEventListener('pointerup', handleUp);
    window.removeEventListener('pointercancel', handlePointerCancel);
    window.removeEventListener('blur', cancel);
    window.removeEventListener('keydown', handleKeydown);
    if (previous && dragRegion.hasPointerCapture?.(previous.pointerId)) {
      dragRegion.releasePointerCapture(previous.pointerId);
    }
    return previous;
  }

  function cancel() {
    stopDrag();
    restore();
  }

  function handlePointerCancel(event: PointerEvent) {
    if (drag?.pointerId === event.pointerId) cancel();
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    cancel();
  }

  function handleDown(event: PointerEvent) {
    if (
      event.button !== 0 ||
      !event.isPrimary ||
      drag ||
      (event.target as HTMLElement).closest('button') ||
      node.classList.contains('outline-dragging')
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    const panelRect = node.getBoundingClientRect();
    const gridRect = grid.getBoundingClientRect();
    const origin = { left: panelRect.left - gridRect.left, top: panelRect.top - gridRect.top };
    drag = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      origin,
      current: origin,
      maxLeft: Math.max(MARGIN, grid.clientWidth - node.offsetWidth - MARGIN),
      maxTop: Math.max(MARGIN, grid.clientHeight - node.offsetHeight - MARGIN),
      moved: false,
    };
    dragRegion.setPointerCapture?.(event.pointerId);
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', handlePointerCancel);
    window.addEventListener('blur', cancel);
    window.addEventListener('keydown', handleKeydown);
  }

  function handleMove(event: PointerEvent) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    event.preventDefault();
    drag.moved = true;
    drag.current = {
      left: Math.min(Math.max(MARGIN, drag.origin.left + dx), drag.maxLeft),
      top: Math.min(Math.max(MARGIN, drag.origin.top + dy), drag.maxTop),
    };
    // 只更新面板坐标；拖动状态和保存位置均不参与正文布局。
    node.setAttribute('data-positioned', '');
    node.classList.add('outline-panel-moving');
    place(drag.current);
  }

  function handleUp(event: PointerEvent) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const completed = stopDrag();
    if (completed?.moved) {
      saveOutlinePanelPosition({
        left: Math.round(completed.current.left),
        top: Math.round(completed.current.top),
      });
    } else {
      restore();
    }
  }

  function handleResize() {
    if (drag) cancel();
    scheduleConstraint();
  }

  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(handleResize);
  const unsubscribe = outlinePanelPosition.subscribe((value) => {
    stopDrag();
    saved = value;
    restore();
    observer?.disconnect();
    if (saved) {
      observer?.observe(grid);
      observer?.observe(node);
      scheduleConstraint();
    }
  });
  dragRegion.addEventListener('pointerdown', handleDown);
  dragRegion.addEventListener('lostpointercapture', handlePointerCancel);
  window.addEventListener('resize', handleResize);

  return {
    destroy() {
      destroyed = true;
      stopDrag();
      unsubscribe();
      observer?.disconnect();
      if (frame) window.cancelAnimationFrame(frame);
      dragRegion.removeEventListener('pointerdown', handleDown);
      dragRegion.removeEventListener('lostpointercapture', handlePointerCancel);
      window.removeEventListener('resize', handleResize);
    },
  };
}
