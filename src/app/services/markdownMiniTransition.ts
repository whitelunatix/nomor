import {
  beginTypographyInteraction,
  notifyTypographyGeometryChange,
} from '../../lib/typography/interaction';

/** 保持窗口和正文可见，只协调目标布局就绪与精细排版恢复。 */
export function prepareMarkdownMiniTransition() {
  let disposed = false;
  let finishPending: (() => void) | undefined;
  const releaseTypography = beginTypographyInteraction('window-mode');
  notifyTypographyGeometryChange('window-mode');

  return {
    get disposed() {
      return disposed;
    },
    waitForLayout(contentReady: () => boolean) {
      if (disposed) return Promise.resolve();
      return new Promise<void>((resolve) => {
        let frame = 0;
        let previousSize = '';
        let stableFrames = 0;
        const finish = () => {
          cancelAnimationFrame(frame);
          clearTimeout(timeout);
          finishPending = undefined;
          resolve();
        };
        // 失焦或销毁时 rAF 可能暂停，不能一直锁住输入和精细排版。
        const timeout = setTimeout(finish, 250);
        finishPending = finish;
        const inspect = () => {
          const size = `${window.innerWidth}:${window.innerHeight}`;
          stableFrames = size === previousSize && contentReady() ? stableFrames + 1 : 0;
          previousSize = size;
          if (stableFrames >= 2) finish();
          else frame = requestAnimationFrame(inspect);
        };
        frame = requestAnimationFrame(inspect);
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      finishPending?.();
      releaseTypography();
    },
  };
}
