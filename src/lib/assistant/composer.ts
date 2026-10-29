import { truncateText } from './context';
import { wrapUntrusted } from './prompts';

/** composer 里 `@文档` / `@选区` 需要展开的实时上下文。 */
export interface ComposerContext {
  documentTitle: string | null;
  documentPath: string | null;
  selection: string | null;
}

const DOC_TOKEN = /@(文档|文件|doc(?:ument)?)/i;
const DOC_TOKEN_ALL = /@(文档|文件|doc(?:ument)?)/gi;
const SELECTION_TOKEN = /@(选区|選取|选取|sel(?:ection)?)/i;
const SELECTION_TOKEN_ALL = /@(选区|選取|选取|sel(?:ection)?)/gi;

/**
 * `@文档` / `@选区` 只在发送时展开，界面里仍保留用户输入的命令，方便再次编辑。
 * 展开内容只进入模型消息，不写回可见消息；重发时会按当时状态重新展开。
 */
export function expandComposerInput(text: string, context: ComposerContext): string {
  let content = text;
  if (DOC_TOKEN.test(content)) {
    const title = context.documentTitle?.trim() || '';
    const path = context.documentPath;
    content = content.replace(DOC_TOKEN_ALL, '').trim();
    content = [
      '[引用当前文档]',
      `标题：${title || '（未命名）'}`,
      `路径：${path ?? '（尚未保存到磁盘）'}`,
      '需要正文时请先调用 doc_outline 或 doc_read，不要凭空猜测内容。',
      '',
      content,
    ]
      .join('\n')
      .trim();
  }
  if (SELECTION_TOKEN.test(content)) {
    const selection = context.selection?.trim() ?? '';
    content = content.replace(SELECTION_TOKEN_ALL, '').trim();
    const quoted = selection
      ? wrapUntrusted('selection', truncateText(selection, 8_000))
      : '（当前没有选中文本）';
    content = `${content}\n\n[引用当前选区]\n${quoted}`.trim();
  }
  return content.trim() || text.trim();
}
