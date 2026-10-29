import type { Node as ProseMirrorNode, ResolvedPos } from 'prosemirror-model';
import { schema } from '../schema';
import { readTaskListMarker } from '../InlineSourceCodec';
import { Plugin, PluginKey, Selection, TextSelection, type EditorState } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';
import { changedTopLevelBlocks } from './changedBlocks';

const taskListPluginKey = new PluginKey('taskList');

type TaskMarkerRange = { from: number; to: number; checked: boolean };

export function taskListPlugin(): Plugin {
  let composing = false;
  return new Plugin({
    key: taskListPluginKey,
    appendTransaction(transactions, _oldState, state) {
      if (composing || transactions.some((tr) => tr.getMeta('composition') !== undefined)) return null;
      // 在 EditorView 更新和滚动定位前修正隐藏字符中的光标，不改变范围选区与文档。
      return normalizeTaskCursor(state);
    },
    state: {
      init(_, state) {
        return buildTaskDecorations(state.doc);
      },
      apply(tr, oldSet, _oldState, newState) {
        if (!tr.docChanged) return oldSet;
        const mapped = oldSet.map(tr.mapping, newState.doc);
        // 任务项只可能出现在改动到的列表里；普通段落输入平移旧装饰即可。
        const changed = changedTopLevelBlocks(tr);
        if (changed && !changed.some((block) => containsListItem(block.node))) return mapped;
        return buildTaskDecorations(newState.doc);
      },
    },
    view(view) {
      let editable = view.editable;
      let pending = false;
      const normalizeRestoredCursor = () => {
        if (pending || !view.editable || view.composing || !normalizeTaskCursor(view.state)) return;
        pending = true;
        // 初始化和缓存状态恢复不一定经过事务；避免在构造/更新视图时嵌套 dispatch。
        queueMicrotask(() => {
          pending = false;
          if (view.isDestroyed || !view.editable || view.composing) return;
          const tr = normalizeTaskCursor(view.state);
          if (tr) view.dispatch(tr);
        });
      };
      normalizeRestoredCursor();
      return {
        update() {
          normalizeRestoredCursor();
          if (editable === view.editable) return;
          editable = view.editable;
          for (const input of view.dom.querySelectorAll<HTMLInputElement>('.task-checkbox-widget input')) {
            input.disabled = !editable;
          }
        },
        destroy() {
          composing = false;
        },
      };
    },
    props: {
      decorations(state) {
        return this.getState(state);
      },
      handleKeyDown(view, event) {
        if (
          !view.editable || view.composing || event.isComposing ||
          event.ctrlKey || event.metaKey || event.altKey ||
          !['ArrowLeft', 'ArrowRight'].includes(event.key)
        ) return false;
        const { selection } = view.state;
        if (!(selection instanceof TextSelection) || (!selection.empty && !event.shiftKey)) return false;
        if (event.key === 'ArrowRight') {
          const { $head } = selection;
          if (!$head.parent.isTextblock || $head.parentOffset !== $head.parent.content.size) return false;
          const next = Selection.findFrom(view.state.doc.resolve($head.after()), 1);
          if (!(next instanceof TextSelection)) return false;
          const nextStart = taskContentStart(next.$head);
          if (nextStart === null) return false;
          // 阻止原生光标先进入方框前再由 selectionchange 纠正，直接落到可见正文。
          view.dispatch(view.state.tr.setSelection(TextSelection.create(
            view.state.doc, event.shiftKey ? selection.anchor : nextStart, nextStart,
          )).scrollIntoView());
          return true;
        }
        const start = taskContentStart(selection.$head);
        if (start === null || selection.head > start) return false;
        const previous = Selection.findFrom(
          view.state.doc.resolve(selection.$head.before()), -1, event.shiftKey,
        );
        if (previous) {
          const target = event.shiftKey
            ? TextSelection.create(view.state.doc, selection.anchor, previous.head)
            : previous;
          view.dispatch(view.state.tr.setSelection(target).scrollIntoView());
        }
        // 文档开头保持原位，不向隐藏标记移动，也不重复请求滚动。
        return true;
      },
      handleDOMEvents: {
        compositionstart() {
          composing = true;
          return false;
        },
        compositionend() {
          composing = false;
          return false;
        },
        mousedown(view, event) {
          const widget = findTaskWidget(event);
          if (!widget) return false;
          event.preventDefault();
          event.stopPropagation();
          const marker = readCurrentTaskMarker(view, widget);
          if (!marker) return true;
          if (!view.editable) {
            restoreCheckbox(widget, marker.checked);
            return true;
          }
          setTaskChecked(view, marker, !marker.checked);
          return true;
        },
        click(view, event) {
          const widget = findTaskWidget(event);
          if (!widget) return false;
          // mousedown 已提交；阻止浏览器再次切换原生 checkbox。
          event.preventDefault();
          event.stopPropagation();
          return true;
        },
        change(view, event) {
          const widget = findTaskWidget(event);
          if (!widget) return false;
          event.preventDefault();
          event.stopPropagation();
          const marker = readCurrentTaskMarker(view, widget);
          const input = widget.querySelector<HTMLInputElement>('input');
          if (!marker || !input) return true;
          if (!view.editable) {
            restoreCheckbox(widget, marker.checked);
            return true;
          }
          setTaskChecked(view, marker, input.checked);
          return true;
        },
      },
    },
  });
}

function taskContentStart($pos: ResolvedPos): number | null {
  if (
    $pos.depth < 2 ||
    $pos.node($pos.depth - 1).type !== schema.nodes.list_item ||
    $pos.index($pos.depth - 1) !== 0
  ) return null;
  const marker = readTaskListMarker($pos.parent);
  return marker ? $pos.start() + marker.text.length : null;
}

function normalizeTaskCursor(state: EditorState) {
  const { selection } = state;
  if (!(selection instanceof TextSelection) || !selection.empty) return null;
  const start = taskContentStart(selection.$head);
  if (start === null || selection.head >= start) return null;
  return state.tr
    .setSelection(TextSelection.create(state.doc, start))
    .setMeta('addToHistory', false);
}

function findTaskWidget(event: Event): HTMLElement | null {
  return event.target instanceof Element
    ? event.target.closest<HTMLElement>('[data-task-from]')
    : null;
}

function readCurrentTaskMarker(view: EditorView, widget: HTMLElement): TaskMarkerRange | null {
  if (!view.dom.contains(widget)) return null;
  const from = Number(widget.dataset.taskFrom);
  const to = Number(widget.dataset.taskTo);
  if (!Number.isInteger(from) || to !== from + 3 || from < 0 || to > view.state.doc.content.size) {
    return null;
  }
  const $from = view.state.doc.resolve(from);
  if (
    $from.depth < 2 || $from.parentOffset !== 0 ||
    $from.node($from.depth - 1).type !== schema.nodes.list_item ||
    $from.index($from.depth - 1) !== 0
  ) return null;
  const marker = readTaskListMarker($from.parent);
  return marker ? { from, to, checked: marker.checked } : null;
}

function setTaskChecked(view: EditorView, marker: TaskMarkerRange, checked: boolean): void {
  // 提交时再次读取 editable，避免控件事件跨越运行时只读切换。
  if (!view.editable || marker.checked === checked) return;
  const firstText = view.state.doc.nodeAt(marker.from);
  view.dispatch(
    view.state.tr.replaceWith(marker.from, marker.to, schema.text(checked ? '[x]' : '[ ]', firstText?.marks)),
  );
}

function restoreCheckbox(widget: HTMLElement, checked: boolean): void {
  const input = widget.querySelector<HTMLInputElement>('input');
  if (input) input.checked = checked;
}

function containsListItem(node: ProseMirrorNode): boolean {
  if (node.type === schema.nodes.list_item) return true;
  if (node.isTextblock) return false;
  let found = false;
  node.descendants((child) => {
    if (found) return false;
    if (child.type === schema.nodes.list_item) found = true;
    return !found;
  });
  return found;
}

function buildTaskDecorations(doc: ProseMirrorNode): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type !== schema.nodes.list_item) return true;
    const paragraph = node.firstChild;
    const marker = paragraph ? readTaskListMarker(paragraph) : null;
    if (!marker) return true;
    // 仅装饰当前 item 的直接首段；继续遍历以保留真正的嵌套任务项。
    const bracketStart = pos + 2;
    const bracketEnd = bracketStart + 3;
    // 挂在隐藏括号之后，让无正文/无分隔空格的任务项也有可见控件后的光标落点。
    decorations.push(Decoration.widget(bracketEnd, (view) =>
      createTaskCheckboxWidget(marker.checked, bracketStart, bracketEnd, view),
      { side: -1 },
    ));
    decorations.push(
      Decoration.inline(
        bracketStart,
        bracketEnd,
        { style: 'display: none;' },
        { inclusiveStart: false, inclusiveEnd: false },
      ),
    );
    return true;
  });
  return DecorationSet.create(doc, decorations);
}

function createTaskCheckboxWidget(
  checked: boolean,
  from: number,
  to: number,
  view: EditorView,
): HTMLElement {
  const span = document.createElement('span');
  span.className = 'task-checkbox-widget';
  span.setAttribute('contenteditable', 'false');
  span.dataset.taskFrom = String(from);
  span.dataset.taskTo = String(to);
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = checked;
  input.disabled = !view.editable;
  input.setAttribute('tabindex', '-1');
  span.appendChild(input);
  return span;
}
