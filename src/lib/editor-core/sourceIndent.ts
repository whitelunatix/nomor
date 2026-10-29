/**
 * 源码区的 Tab / Shift+Tab 缩进。
 *
 * CodeMirror 默认按键表不含 Tab（浏览器保留给焦点切换），所以双栏源码区
 * 之前按 Tab 只会跳走焦点。这里补两条命令：
 * - Tab：光标不选中任何内容时在光标处插入一级缩进；有选区时把选区覆盖的
 *   整行右移一级；
 * - Shift+Tab：把选区（或光标所在行）覆盖的整行左移一级，行首不足一级
 *   的空白直接清掉。
 *
 * 缩进单位固定为两个空格：与 Markdown 列表的常见写法和本项目的保存格式
 * 一致，也不会在文件里混入 Tab 字符。
 */

import type { EditorState, Extension } from '@codemirror/state';
import { EditorSelection } from '@codemirror/state';
import { keymap, type EditorView } from '@codemirror/view';

export const SOURCE_INDENT_UNIT = '  ';

/** 选区（或光标）覆盖到的行号，1 起；跨选区重叠的行只算一次。 */
export function selectedLineNumbers(state: EditorState): number[] {
  const numbers = new Set<number>();
  for (const range of state.selection.ranges) {
    const startLine = state.doc.lineAt(range.from);
    let endNumber = state.doc.lineAt(range.to).number;
    // 选区刚好停在下一行行首时，那一行不算被选中。
    if (endNumber > startLine.number && range.to === state.doc.lineAt(range.to).from) {
      endNumber -= 1;
    }
    for (let number = startLine.number; number <= endNumber; number += 1) {
      numbers.add(number);
    }
  }
  return [...numbers].sort((a, b) => a - b);
}

/** 行首可以去掉的空白长度，最多一级缩进。 */
export function outdentWidth(text: string): number {
  if (text.startsWith('\t')) return 1;
  const spaces = /^ {1,2}/.exec(text);
  return spaces ? spaces[0].length : 0;
}

/** Tab：空选区插入缩进，有选区整行缩进。返回是否处理了该按键。 */
export function indentSourceLines(view: EditorView): boolean {
  const { state } = view;
  if (state.readOnly) return false;

  const onlyCarets = state.selection.ranges.every((range) => range.empty);
  if (onlyCarets) {
    view.dispatch(
      state.changeByRange((range) => ({
        changes: { from: range.from, to: range.to, insert: SOURCE_INDENT_UNIT },
        range: EditorSelection.cursor(range.from + SOURCE_INDENT_UNIT.length),
      })),
      { userEvent: 'input.indent', scrollIntoView: true },
    );
    return true;
  }

  const changes = selectedLineNumbers(state).map((number) => ({
    from: state.doc.line(number).from,
    insert: SOURCE_INDENT_UNIT,
  }));
  if (changes.length === 0) return false;
  const changeSet = state.changes(changes);
  view.dispatch({
    changes: changeSet,
    selection: state.selection.map(changeSet, 1),
    userEvent: 'input.indent',
    scrollIntoView: true,
  });
  return true;
}

/** Shift+Tab：整行左移一级；行首没有缩进时返回 false，交给其它处理器。 */
export function outdentSourceLines(view: EditorView): boolean {
  const { state } = view;
  if (state.readOnly) return false;

  const changes = [];
  for (const number of selectedLineNumbers(state)) {
    const line = state.doc.line(number);
    const width = outdentWidth(line.text);
    if (width > 0) changes.push({ from: line.from, to: line.from + width });
  }
  if (changes.length === 0) return false;

  const changeSet = state.changes(changes);
  view.dispatch({
    changes: changeSet,
    selection: state.selection.map(changeSet, -1),
    userEvent: 'input.dedent',
    scrollIntoView: true,
  });
  return true;
}

/** 挂在源码编辑器扩展里，必须排在默认按键表之前才能先拿到 Tab。 */
export function sourceIndentKeymap(): Extension {
  return keymap.of([
    { key: 'Tab', run: indentSourceLines },
    { key: 'Shift-Tab', run: outdentSourceLines },
  ]);
}
