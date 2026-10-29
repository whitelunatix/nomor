/**
 * 源码模式的行号。
 *
 * 行号放在一个独立的左列（CodeMirror gutter）里，而不是正文流中的内联
 * widget：数字位数变化只影响列内文字，正文左缘始终不动。列宽由
 * `editor-source.css` 固定，空白行与指令行不生成元素，因此不会有
 * 「这一行多一列、下一行少一列」的跳动。
 *
 * 只给「有内容且不是指令」的行编号：空行和 `<!-- @... -->` 指令行
 * 不显示数字。
 *
 * 编号是「第几条有效行」，不是文件里的物理行号：空行和指令行不占号，
 * 所以连续的正文行一定是 1、2、3……渲染区按同一套编号标注每个块的起始行，
 * 两个面板的数字因此能对上。
 */

import type { Extension, Text } from '@codemirror/state';
import { GutterMarker, gutter, gutters } from '@codemirror/view';
import { isDocxDirectiveSourceLine, isInvalidDirectiveSourceLine } from './sourceDecorations';

/** 该行是否显示行号；空行与（docx 模式下）指令行不编号。 */
export function shouldShowSourceLineNumber(text: string, docxMode: boolean): boolean {
  if (!text.trim()) return false;
  if (docxMode && (isDocxDirectiveSourceLine(text) || isInvalidDirectiveSourceLine(text))) {
    return false;
  }
  return true;
}

/**
 * 逐行算出「第几条有效行」。
 *
 * 返回数组下标就是物理行号（1 起），值是该行之前（含该行）出现的有效行条数；
 * 空行与指令行的值与前一行相同，用来给渲染区取同一个编号。
 */
export function buildEffectiveLineNumbers(
  lines: readonly string[],
  docxMode: boolean,
): number[] {
  const numbers: number[] = new Array(lines.length + 1).fill(0);
  let total = 0;
  for (let index = 0; index < lines.length; index += 1) {
    if (shouldShowSourceLineNumber(lines[index] ?? '', docxMode)) total += 1;
    numbers[index + 1] = total;
  }
  return numbers;
}

/**
 * 同一份文档只扫一次：`lineMarker` 会对每个可见行各调用一次，
 * 缓存按代码文档对象区分，文档一变自然失效。
 */
const effectiveNumbersCache = new WeakMap<Text, { docxMode: boolean; numbers: number[] }>();

function effectiveNumbersForDoc(doc: Text, docxMode: boolean): number[] {
  const cached = effectiveNumbersCache.get(doc);
  if (cached && cached.docxMode === docxMode) return cached.numbers;
  const lines = doc.toString().split('\n');
  const numbers = buildEffectiveLineNumbers(lines, docxMode);
  effectiveNumbersCache.set(doc, { docxMode, numbers });
  return numbers;
}

class SourceLineNumberMarker extends GutterMarker {
  constructor(readonly label: string) {
    super();
  }

  eq(other: SourceLineNumberMarker): boolean {
    return other.label === this.label;
  }

  toDOM(): Node {
    return document.createTextNode(this.label);
  }
}

/**
 * `docxMode` 变化时由外部 compartment 重建，因此这里直接捕获布尔值，
 * 不在视图更新里反复读取配置。
 */
export function sourceLineNumbers(docxMode: boolean): Extension {
  return [
    // 非 fixed：gutter 跟随正文一起横向滚动，位置由 CSS 的
    // `margin-left` 决定（对齐居中正文的左缘），而不是贴住窗格左边缘。
    gutters({ fixed: false }),
    gutter({
      class: 'cm-source-line-numbers',
      renderEmptyElements: false,
      lineMarker(view, line) {
        const docLine = view.state.doc.lineAt(line.from);
        if (!shouldShowSourceLineNumber(docLine.text, docxMode)) return null;
        const numbers = effectiveNumbersForDoc(view.state.doc, docxMode);
        return new SourceLineNumberMarker(String(numbers[docLine.number] ?? 0));
      },
      // 文档变化时行内容可能变成/不再是指令，重算可见行号。
      lineMarkerChange: (update) => update.docChanged,
    }),
  ];
}
