import { DOMParser, Fragment, type NodeSpec, type Schema } from 'prosemirror-model';

/** HTML 导入只使用一次局部 parser，正文仍属于主编辑文档。 */
export function parseDetailsHtml(element: HTMLElement, schema: Schema): Fragment {
  const parser = new DOMParser(schema, [{ tag: 'pre', node: 'code_block', preserveWhitespace: 'full',
    getAttrs: dom => ({ params: ((dom as HTMLElement).querySelector('code')?.className ?? '').replace(/^language-/, '') }),
  }, ...DOMParser.fromSchema(schema).rules]);
  const normalize = (node: import('prosemirror-model').Node): import('prosemirror-model').Node => {
    let attrs = node.attrs;
    if (node.type.name === 'image') attrs = { ...attrs, alt: attrs.alt ?? '' };
    if (['bullet_list', 'ordered_list'].includes(node.type.name) && node.childCount === 1) attrs = { ...attrs, tight: true };
    return node.isText ? node : node.type.create(attrs, Fragment.fromArray(Array.from({ length: node.childCount }, (_, i) => normalize(node.child(i)))), node.marks);
  };
  return normalize(parser.parse(element)).content;
}

export const detailsNodes: Record<string, NodeSpec> = {
  details: {
    group: 'block', content: 'details_summary details_body', defining: true, isolating: true,
    attrs: { defaultOpen: { default: false } },
    parseDOM: [{ tag: 'details', getAttrs: dom => ({ defaultOpen: (dom as HTMLElement).hasAttribute('open') }),
      getContent(dom, schema) {
        const element = dom as HTMLElement;
        const summary = Array.from(element.children).find(child => child.tagName === 'SUMMARY');
        const title = document.createElement('p');
        title.innerHTML = summary?.innerHTML ?? '';
        const titleRoot = document.createElement('div');
        titleRoot.append(title);
        const inline = DOMParser.fromSchema(schema).parse(titleRoot, { preserveWhitespace: true }).firstChild?.content ?? Fragment.empty;
        const body = document.createElement('div');
        for (const child of Array.from(element.childNodes)) {
          if (child === summary) continue;
          if (child instanceof HTMLElement && child.hasAttribute('data-nomo-details-body')) {
            for (const nested of Array.from(child.childNodes)) body.append(nested.cloneNode(true));
          } else body.append(child.cloneNode(true));
        }
        const content = parseDetailsHtml(body, schema);
        return Fragment.fromArray([
          schema.nodes.details_summary.create(null, inline.content.filter(node => node.isText)),
          schema.nodes.details_body.create(null, content.size ? content : schema.nodes.paragraph.create()),
        ]);
      } }],
    toDOM: node => ['details', node.attrs.defaultOpen ? { open: '' } : {}, 0],
  },
  details_summary: {
    content: 'text*', defining: true,
    parseDOM: [{ tag: 'summary' }], toDOM: () => ['summary', 0],
  },
  details_body: {
    content: 'block+', defining: true,
    parseDOM: [{ tag: 'div[data-nomo-details-body]' }],
    toDOM: () => ['div', { 'data-nomo-details-body': '' }, 0],
  },
};
