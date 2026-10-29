import { describe, expect, it } from 'vitest';
import { classifyPrintBlocks, preparePrintDocument, promotePrintTableHeaders } from './exportPrint';

it('opens every details level before print measurements', () => {
  const root = document.createElement('div');
  root.innerHTML = '<details><summary>outer</summary><details><summary>inner</summary><p>body</p></details></details>';
  preparePrintDocument(root, 170);
  expect([...root.querySelectorAll('details')].every(node => node.open)).toBe(true);
  expect(root.textContent).toContain('body');
});

function table(html: string) {
  const container = document.createElement('div');
  container.innerHTML = `<table>${html}</table>`;
  return container.firstElementChild as HTMLTableElement;
}

describe('PDF print preparation', () => {
  it('提升连续前置表头，同时保留合并列和正文行', () => {
    const target = table('<tr><th colspan="2">Header</th></tr><tr><td>A</td><td>B</td></tr>');
    promotePrintTableHeaders(target);
    expect(target.tHead?.rows).toHaveLength(1);
    expect(target.tHead?.rows[0].cells[0].colSpan).toBe(2);
    expect(target.tBodies[0].rows).toHaveLength(1);
    promotePrintTableHeaders(target);
    expect(target.tHead?.rows).toHaveLength(1);
  });

  it('rowspan 穿越表头边界时保持原始表格结构', () => {
    for (const span of ['0', '2']) {
      const target = table(`<tr><th rowspan="${span}">H</th><th>H2</th></tr><tr><td>B</td></tr>`);
      const before = target.outerHTML;
      promotePrintTableHeaders(target);
      expect(target.outerHTML).toBe(before);
    }
  });

  it('准备目标版心与媒体尺寸，并区分短块和跨页长块', () => {
    const root = document.createElement('article');
    root.innerHTML = '<img><div class="code-card"></div><div class="math-block"></div>';
    const code = root.querySelector<HTMLElement>('.code-card')!;
    code.getBoundingClientRect = () => ({ height: 1200 } as DOMRect);
    preparePrintDocument(root, 170, 257);
    classifyPrintBlocks(root, 257);
    expect(root.style.width).toBe('170mm');
    expect(root.querySelector('img')?.style.maxHeight).not.toBe('');
    expect(code.classList.contains('nomo-print-split')).toBe(true);
    expect(root.querySelector('.math-block')?.classList.contains('nomo-print-keep')).toBe(true);
    expect(() => preparePrintDocument(root, -1, 257)).toThrow('Invalid print dimensions');
  });
});
