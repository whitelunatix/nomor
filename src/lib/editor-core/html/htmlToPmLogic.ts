import type { Schema, Mark } from 'prosemirror-model';
import { INLINE_TAG_TO_MARK } from './htmlPolicy';
import { createLinkAttrs } from '../link';
import { createHtmlAnchorAttrs } from './htmlAnchor';
import { readHtmlInlineAtom } from './htmlClassifier';

type HtmlParseState = {
  openMark(mark: unknown): void;
  closeMark(markType: unknown): void;
  addText(text: string): void;
  openNode(type: unknown, attrs?: Record<string, unknown>): void;
  closeNode(): void;
};

/** 遍历已分类为可表示的 HTML 子树，恢复全部允许的行内节点和格式。 */
export function parseHtmlContent(state: HtmlParseState, innerHTML: string, schema: Schema): void {
  const template = document.createElement('template');
  template.innerHTML = innerHTML;
  walkDOMFragment(state, template.content, schema, []);
}

function walkDOMFragment(
  state: HtmlParseState,
  parent: Node,
  schema: Schema,
  activeMarks: readonly Mark[],
): void {
  for (const child of Array.from(parent.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      state.addText(child.textContent ?? '');
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;

    const el = child as HTMLElement;
    const tag = el.tagName.toLowerCase();
    const htmlAttrs = Object.fromEntries(Array.from(el.attributes, (attr) => [attr.name, attr.value]));
    const atom = readHtmlInlineAtom(tag, htmlAttrs);
    if (atom && schema.nodes[atom.type]) {
      state.openNode(schema.nodes[atom.type], atom.attrs);
      state.closeNode();
      continue;
    }

    if (tag === 'a' && !el.childNodes.length) {
      const attrs = createHtmlAnchorAttrs(
        el.getAttribute('href'), el.getAttribute('title'), el.getAttribute('id'), el.getAttribute('name'),
      );
      if (attrs) {
        state.openNode(schema.nodes.html_anchor, attrs);
        state.closeNode();
      }
      continue;
    }

    const markType = schema.marks[INLINE_TAG_TO_MARK[tag]];
    if (markType) {
      const attrs = markType.name === 'link'
        ? el.hasAttribute('href') && !el.hasAttribute('id') && !el.hasAttribute('name')
          ? createLinkAttrs(el.getAttribute('href'), el.getAttribute('title'))
          : createHtmlAnchorAttrs(
            el.getAttribute('href'), el.getAttribute('title'), el.getAttribute('id'), el.getAttribute('name'),
          )
        : null;
      if (markType.name === 'link' && !attrs) {
        walkDOMFragment(state, el, schema, activeMarks);
        continue;
      }
      const mark = markType.create(attrs);
      state.openMark(mark);
      walkDOMFragment(state, el, schema, mark.addToSet(activeMarks));
      state.closeMark(markType);
      // 同类嵌套和 code 的排斥规则可能移除外层格式，离开子元素后恢复完整进入状态。
      for (const outerMark of activeMarks) state.openMark(outerMark);
      continue;
    }
    walkDOMFragment(state, el, schema, activeMarks);
  }
}
