import MarkdownIt from 'markdown-it';
import { t } from '../../app/i18n';

/**
 * 聊天消息用的轻量 Markdown 渲染。
 * 关闭原始 HTML（消息来自模型，不能信任），图片不渲染（模型无法插入本地图片），
 * 外链统一新窗口打开。
 */
const renderer = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
});

renderer.renderer.rules.image = () => '';

const defaultLinkOpen =
  renderer.renderer.rules.link_open ??
  ((tokens, index, opts, _env, self) => self.renderToken(tokens, index, opts));

renderer.renderer.rules.link_open = (tokens, index, opts, env, self) => {
  const token = tokens[index]!;
  token.attrSet('target', '_blank');
  token.attrSet('rel', 'noopener noreferrer');
  return defaultLinkOpen(tokens, index, opts, env, self);
};

// 代码块带一个复制按钮；点击事件由消息组件代理，避免给不可信 HTML 绑定脚本。
renderer.renderer.rules.fence = (tokens, index) => {
  const token = tokens[index]!;
  const info = token.info.trim().split(/\s+/)[0] ?? '';
  const language = info ? ` language-${renderer.utils.escapeHtml(info)}` : '';
  const code = renderer.utils.escapeHtml(token.content);
  return [
    '<div class="ai-code-block">',
    `<button type="button" class="ai-code-copy">${t.aiCodeCopy()}</button>`,
    `<pre><code class="${language.trim()}">${code}</code></pre>`,
    '</div>',
  ].join('');
};

export function renderAssistantMarkdown(text: string): string {
  return renderer.render(text);
}
