/**
 * 跨 NodeView 的编辑态协调注册表
 *
 * 行内代码、行公式等使用 <input> 编辑态的 NodeView 共享此注册表，
 * 每篇文档分别协调编辑态，组合标签的另一篇文档不会被误提交。
 */

import type { EditorView } from 'prosemirror-view';

type ExitEditFn = () => void;

interface ActiveEditComposition {
  isComposing?: () => boolean;
  waitForCompositionEnd?: () => Promise<void>;
}

interface ActiveEdit {
  exit: ExitEditFn;
  commit?: () => void;
  composition?: ActiveEditComposition;
}

const activeEdits = new WeakMap<EditorView, ActiveEdit[]>();

/** 注册退出回调；组字中的旧输入保留到真正退出，避免保存漏等。 */
export function registerActiveEdit(
  view: EditorView,
  exitFn: ExitEditFn,
  commitFn?: () => void,
  composition?: ActiveEditComposition,
): void {
  const previous = activeEdits.get(view)?.at(-1);
  if (previous && previous.exit !== exitFn) {
    previous.exit();
    if (!previous.composition?.isComposing?.()) unregisterActiveEdit(view, previous.exit);
  }
  const remaining = (activeEdits.get(view) ?? []).filter((edit) => edit.exit !== exitFn);
  activeEdits.set(view, [...remaining, { exit: exitFn, commit: commitFn, composition }]);
}

/** 注销一个编辑对象；不会影响正在组字或新进入的其它节点。 */
export function unregisterActiveEdit(view: EditorView, exitFn: ExitEditFn): void {
  const remaining = (activeEdits.get(view) ?? []).filter((edit) => edit.exit !== exitFn);
  if (remaining.length > 0) activeEdits.set(view, remaining);
  else activeEdits.delete(view);
}

/** 保存或快照只提交临时输入；切换模式时可明确要求结束编辑态。 */
export function commitActiveEdit(view: EditorView, exitEditing = false): void {
  for (const active of [...(activeEdits.get(view) ?? [])]) {
    if (active.composition?.isComposing?.()) continue;
    if (!exitEditing && active.commit) {
      active.commit();
    } else {
      unregisterActiveEdit(view, active.exit);
      active.exit();
    }
  }
}

/** 等待当前文档所有未结束的节点组字，销毁和只读取消也会释放等待。 */
export async function awaitActiveEditCompositionEnd(view: EditorView): Promise<void> {
  while (true) {
    const composing = (activeEdits.get(view) ?? []).filter(
      (edit) => edit.composition?.isComposing?.() && edit.composition.waitForCompositionEnd,
    );
    if (composing.length === 0) return;
    await Promise.all(composing.map((edit) => edit.composition!.waitForCompositionEnd!()));
  }
}

export function isActiveEditComposing(view: EditorView): boolean {
  return (activeEdits.get(view) ?? []).some((edit) => edit.composition?.isComposing?.());
}

/** 已切换为只读时退出所有旧输入；节点按 view.editable 丢弃临时内容。 */
export function cancelActiveEdit(view: EditorView): void {
  const edits = activeEdits.get(view) ?? [];
  activeEdits.delete(view);
  for (const active of edits) active.exit();
}
