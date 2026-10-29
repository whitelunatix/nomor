/** Callout ProseMirror 节点定义 */

import type { NodeSpec } from 'prosemirror-model';

/**
 * callout 节点 spec
 * - group: block，可出现在任何 block 节点出现的位置
 * - content: block+，内部支持段落、列表、代码块、图片、表格等
 * - defining: true，保证 lift/unwrap 时保留内部结构
 * - attrs.type: callout 类型字符串
 * - attrs.title: 自定义标题，null 表示使用类型的本地化默认标题
 * - attrs.fold: `open` / `closed` 对应 `[!TYPE]+` / `[!TYPE]-`，null 表示普通展开
 */
export const calloutNodeSpec: NodeSpec = {
  group: 'block',
  content: 'block+',
  defining: true,
  attrs: {
    type: { default: 'note' },
    title: { default: null },
    fold: { default: null },
  },
  parseDOM: [
    {
      tag: 'div.callout-card',
      getAttrs(dom: string | Node) {
        if (typeof dom === 'string') return false;
        const el = dom as HTMLElement;
        return {
          type: el.dataset.calloutType ?? 'note',
          title: el.dataset.calloutTitle || null,
          fold: el.dataset.calloutFold === 'open' || el.dataset.calloutFold === 'closed'
            ? el.dataset.calloutFold
            : null,
        };
      },
    },
  ],
  toDOM(node) {
    const attrs: Record<string, string> = {
      class: 'callout-card',
      'data-callout-type': node.attrs.type,
    };
    if (node.attrs.title) attrs['data-callout-title'] = String(node.attrs.title);
    if (node.attrs.fold) attrs['data-callout-fold'] = String(node.attrs.fold);
    return ['div', attrs, 0]; // contentDOM 插槽
  },
};
