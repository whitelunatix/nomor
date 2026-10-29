import type { Node as ProseMirrorNode } from 'prosemirror-model';
import { createLinkAttrs } from '../link';
import { escapeHtmlAttr } from '../markdownTokenizer';
import { serializeHtmlAnchorOpen } from './htmlAnchor';

/** 将 html_block 节点的全部允许行内内容序列化为可再次编辑的 HTML。 */
export function serializeHtmlBlock(node: ProseMirrorNode): string {
  const tag = node.attrs.tag === 'section' ? 'section' : 'div';
  const attrStr = buildAttrString(node.attrs.class, node.attrs.id);
  const parts: string[] = [];
  node.forEach((child) => parts.push(wrapWithMarks(child, serializeInlineNode(child))));
  return '<' + tag + attrStr + '>' + parts.join('') + '</' + tag + '>';
}

/** 表格 HTML 回退复用相同的行内 marks/atoms 编码，不依赖 DOM。 */
export function serializeHtmlInlineContent(node: ProseMirrorNode): string {
  const parts: string[] = [];
  node.forEach((child) => parts.push(wrapWithMarks(child, serializeInlineNode(child))));
  return parts.join('');
}

function buildAttrString(cls?: string | null, id?: string | null): string {
  const parts: string[] = [];
  if (cls != null) parts.push('class="' + escapeHtmlAttr(cls) + '"');
  if (id != null) parts.push('id="' + escapeHtmlAttr(id) + '"');
  return parts.length > 0 ? ' ' + parts.join(' ') : '';
}

function serializeInlineNode(node: ProseMirrorNode): string {
  if (node.isText) return escapeHtml(node.text ?? '');
  switch (node.type.name) {
    case 'html_anchor':
      return serializeHtmlAnchorOpen(node.attrs) + '</a>';
    case 'hard_break':
      return node.attrs.soft ? '<br data-nomo-break="soft">' : '<br>';
    case 'image': {
      const attrs: string[] = [];
      for (const name of ['src', 'alt', 'title', 'width', 'align']) {
        if (node.attrs[name] != null) attrs.push(name + '="' + escapeHtmlAttr(String(node.attrs[name])) + '"');
      }
      return '<img ' + attrs.join(' ') + '>';
    }
    case 'math_inline': {
      const tex = String(node.attrs.tex ?? '');
      return '<span class="math-inline" data-tex="' + escapeHtmlAttr(tex) + '">' + escapeHtml('$' + tex + '$') + '</span>';
    }
    case 'comment_inline': {
      const content = String(node.attrs.content ?? '');
      return '<span class="comment-inline" data-comment="' + escapeHtmlAttr(content) + '">' + escapeHtml(content) + '</span>';
    }
    case 'footnote_ref': {
      const id = String(node.attrs.id ?? '');
      return '<sup class="footnote-ref" data-footnote-id="' + escapeHtmlAttr(id) + '">' + escapeHtml(id) + '</sup>';
    }
    default:
      throw new RangeError('Unsupported HTML inline node: ' + node.type.name);
  }
}

function wrapWithMarks(node: ProseMirrorNode, content: string): string {
  for (const mark of node.marks) {
    switch (mark.type.name) {
      case 'strong':
        content = '<strong>' + content + '</strong>';
        break;
      case 'em':
        content = '<em>' + content + '</em>';
        break;
      case 'code':
        content = '<code>' + content + '</code>';
        break;
      case 'strikethrough':
        content = '<s>' + content + '</s>';
        break;
      case 'underline':
        content = '<u>' + content + '</u>';
        break;
      case 'superscript':
        content = '<sup>' + content + '</sup>';
        break;
      case 'subscript':
        content = '<sub>' + content + '</sub>';
        break;
      case 'highlight':
        content = '<mark>' + content + '</mark>';
        break;
      case 'link': {
        if (mark.attrs.html) {
          content = serializeHtmlAnchorOpen(mark.attrs) + content + '</a>';
          break;
        }
        const attrs = createLinkAttrs(mark.attrs.href, mark.attrs.title);
        if (!attrs) break;
        const title = attrs.title ? ' title="' + escapeHtmlAttr(attrs.title) + '"' : '';
        content = '<a href="' + escapeHtmlAttr(attrs.href) + '"' + title + '>' + content + '</a>';
        break;
      }
    }
  }
  return content;
}

function escapeHtml(text: string): string {
  // 保持整块在同一个 Markdown HTML token 内，空白行不能提前结束块。
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\r/g, '&#13;').replace(/\n/g, '&#10;');
}
