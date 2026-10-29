/** 不可见文档暂停增强；无 IntersectionObserver 的导出／测试宿主保持即时渲染。 */
export function observeRenderVisibility(element: HTMLElement, onChange: (visible: boolean) => void): () => void {
  let nearViewport = typeof IntersectionObserver !== 'function';
  const notify = () => onChange(nearViewport && !element.ownerDocument.hidden);
  const observer = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver(([entry]) => {
      if (!entry) return;
      nearViewport = entry.isIntersecting;
      notify();
    }, { rootMargin: '400px' }) : null;
  observer?.observe(element);
  element.ownerDocument.addEventListener('visibilitychange', notify);
  return () => {
    observer?.disconnect();
    element.ownerDocument.removeEventListener('visibilitychange', notify);
  };
}

/** 屏幕上方的占位换成图表时保持阅读位置；仅在增强结果提交时测量一次。 */
export function preserveRenderScrollAnchor(element: HTMLElement, update: () => void): void {
  const pane = element.closest<HTMLElement>('.semantic-pane');
  const before = pane && element.getBoundingClientRect();
  const above = pane && before && before.bottom <= pane.getBoundingClientRect().top;
  const scrollTop = pane?.scrollTop ?? 0;
  update();
  if (above && pane && before) pane.scrollTop = scrollTop + element.getBoundingClientRect().height - before.height;
}
