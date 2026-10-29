import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDomTypography } from './dom';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); document.body.replaceChildren(); });

describe('readonly typography image lifecycle', () => {
  it('已解码图片的克隆加载事件不重复失效，真实尺寸改变仍重新排版', async () => {
    vi.useFakeTimers();
    let width = 100;
    vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(true);
    vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockImplementation(() => width);
    vi.spyOn(HTMLImageElement.prototype, 'naturalHeight', 'get').mockReturnValue(80);
    const root = document.createElement('article');
    root.innerHTML = '<p>内嵌图片 <img src="data:image/png;base64,AA=="></p>';
    document.body.append(root);
    const controller = createDomTypography(root, { enabled: false, profile: 'zh-CN', hanging: true });
    try {
      await controller.flush();
      const image = root.querySelector('img')!;
      image.dispatchEvent(new Event('load'));
      await vi.advanceTimersByTimeAsync(200);
      expect(root.querySelector('img')).toBe(image);
      width = 200;
      image.dispatchEvent(new Event('load'));
      await vi.advanceTimersByTimeAsync(200);
      await controller.flush();
      expect(root.querySelector('img')).not.toBe(image);
      const next = root.querySelector('img')!;
      next.dispatchEvent(new Event('load'));
      await vi.advanceTimersByTimeAsync(200);
      expect(root.querySelector('img')).toBe(next);
    } finally { controller.destroy(); }
  });
});
