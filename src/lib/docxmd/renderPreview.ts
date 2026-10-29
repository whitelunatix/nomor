/**
 * Quick Look、大文件预览和测试共用的 `.docx.md` 渲染入口。
 *
 * 顺序固定为“预处理 → markdown-it → sanitize → KaTeX”，原始指令和 DrawingML
 * 在进入 HTML 之前已经移除。正文渲染仍复用 Quick Look 的 sanitizer，避免
 * 为 docx 预览另建一套安全边界。
 */
import {
  renderMarkdownPreview,
  renderMarkdownPreviewBody,
  type QuickLookPreviewOptions,
} from '../../quicklook/preview';
import { isDocxMarkdownSource, prepareDocxPreviewMarkdown } from './previewMarkdown';

function prepare(markdown: string, options: QuickLookPreviewOptions): string {
  return isDocxMarkdownSource(markdown, options.fileName)
    ? prepareDocxPreviewMarkdown(markdown)
    : markdown;
}

/** 只返回安全过滤后的正文 HTML。 */
export function renderPreview(
  markdown: string,
  options: QuickLookPreviewOptions = {},
): string {
  return renderMarkdownPreviewBody(prepare(markdown, options), options);
}

/** 返回带 Quick Look 外壳的完整预览 HTML。 */
export function renderPreviewDocument(
  markdown: string,
  options: QuickLookPreviewOptions = {},
): string {
  return renderMarkdownPreview(prepare(markdown, options), options);
}
