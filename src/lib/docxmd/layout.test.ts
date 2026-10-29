import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { EditorState, Plugin } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { describe, expect, it } from 'vitest';
import { parseMarkdown } from '../editor-core/markdown';
import { buildDocxDecorations } from './presentation';

/**
 * 排版核对：默认读取仓库内的全功能样例，也可以用 `DOCXMD_LAYOUT_FILE`
 * 指向一份真实 `.docx.md` 做额外检查。
 *
 * 只核对行内标记层是否把每个逻辑段落拆成独立的块级 span（`display: block`
 * 由 `editor-docx.css` 提供，jsdom 不加载样式表，因此这里检查结构）。
 */
const layoutFile =
  process.env.DOCXMD_LAYOUT_FILE ?? resolve(__dirname, '__fixtures__/all_features.docx.md');
const source = readFileSync(layoutFile, 'utf8');

describe('docx real-document layout', () => {
  it('wraps every paragraph group in its own span and keeps empty groups as spacers', () => {
    const doc = parseMarkdown(source, { docx: true });
    const decorations = buildDocxDecorations(doc);
    const host = document.body.appendChild(document.createElement('div'));
    const view = new EditorView(host, {
      state: EditorState.create({
        doc,
        plugins: [new Plugin({ props: { decorations: () => decorations } })],
      }),
    });

    const groups = Array.from(host.querySelectorAll('.docx-inline-paragraph-group'));
    const spacers = Array.from(host.querySelectorAll('.docx-inline-paragraph-spacer'));
    const blockMarkers = Array.from(host.querySelectorAll('.docx-inline-block-marker'));
    console.log(
      `[docx layout] paragraph groups: ${groups.length}, spacers: ${spacers.length}, `
        + `block markers: ${blockMarkers.length}`,
    );

    expect(groups.every((element) => element.tagName === 'SPAN')).toBe(true);
    // 零长度段落组不能丢，否则单元格里会少掉一段垂直间距。
    expect(spacers.every((element) => element.tagName === 'SPAN')).toBe(true);
    // 正文里出现段落组时至少要渲染出一个；论文这类没有行内段落组的文档保持 0 个。
    if (/\[\[[A-Z]+ \| & (?:use )?paragraph/.test(source)) {
      expect(groups.length).toBeGreaterThan(0);
      // 每个段落组的左右边界各有一个块级零高标记。
      expect(blockMarkers.length).toBeGreaterThanOrEqual(groups.length * 2);
    }

    view.destroy();
    host.remove();
  });
});
