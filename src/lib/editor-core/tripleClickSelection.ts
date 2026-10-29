import { NodeSelection, Selection, TextSelection } from 'prosemirror-state';
import type { Node as ProseMirrorNode } from 'prosemirror-model';
import type { EditorView } from 'prosemirror-view';

/**
 * 三击要选中的块：从点击位置向外找最近的文本块（选中其全部内容），或可选中的块节点。
 * 与 prosemirror-view 内置三击行为一致。
 *
 * @param inside posAtCoords 返回的 inside；-1 表示点在顶层节点之间，此时不处理。
 * @returns 目标选区；找不到可选目标时返回 null。
 */
export function tripleClickSelectionAt(doc: ProseMirrorNode, inside: number): Selection | null {
  if (inside < 0) return null;
  const $pos = doc.resolve(inside);
  for (let depth = $pos.depth + 1; depth > 0; depth--) {
    const node = depth > $pos.depth ? $pos.nodeAfter : $pos.node(depth);
    if (!node) continue;
    const nodePos = $pos.before(depth);
    if (node.inlineContent)
      return TextSelection.create(doc, nodePos + 1, nodePos + 1 + node.content.size);
    if (NodeSelection.isSelectable(node)) return NodeSelection.create(doc, nodePos);
  }
  return null;
}

/**
 * 按浏览器的点击计数（event.detail）处理三击，代替 ProseMirror 自身的计时判定。
 *
 * ProseMirror 要求相邻两次按下间隔 < 500ms 且距离 < 10px 才认作三击；macOS 的连击判定更宽松，
 * 点得稍慢或略有移动时系统已按三击处理而 ProseMirror 没识别，三击就落到 WebKit 原生段落选择：
 * 精细排版用原生 <br> 投影软换行，原生选择只选中一行或带出跨块的残留选区。
 *
 * @returns 已处理并阻止默认行为时返回 true；非左键三击、带修饰键或点在块之间时返回 false。
 */
export function handleTripleClickByDetail(view: EditorView, event: MouseEvent): boolean {
  if (event.button !== 0 || event.detail < 3) return false;
  if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return false;
  const coords = view.posAtCoords({ left: event.clientX, top: event.clientY });
  if (!coords) return false;
  const selection = tripleClickSelectionAt(view.state.doc, coords.inside);
  if (!selection) return false;
  event.preventDefault();
  if (!view.hasFocus()) view.focus();
  view.dispatch(view.state.tr.setSelection(selection).setMeta('pointer', true));
  return true;
}
