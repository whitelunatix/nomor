import { describe, expect, it } from 'vitest';
import { detectHtmlCssCompletion } from './htmlCssCompletion';

/** `|` 标记光标位置。 */
function complete(source: string) {
  const position = source.indexOf('|');
  return detectHtmlCssCompletion(source.replace('|', ''), position);
}

describe('detectHtmlCssCompletion', () => {
  it('补全 HTML 标签与属性', () => {
    const tag = complete('<di|');
    expect(tag?.kind).toBe('tag');
    expect(tag?.prefix).toBe('di');
    expect(tag?.from).toBe(1);
    expect(tag?.items.map((item) => item.label)).toEqual(['dialog', 'div']);

    expect(complete('<|')?.items.length).toBeGreaterThan(10);

    const attribute = complete('<div cla|');
    expect(attribute?.kind).toBe('attribute');
    expect(attribute?.items.map((item) => item.label)).toEqual(['class']);

    const afterValue = complete('<div class="card" da|');
    expect(afterValue?.kind).toBe('attribute');
    expect(afterValue?.items.map((item) => item.label)).toContain('datetime');

    expect(complete('</di|')).toMatchObject({ kind: 'tag', prefix: 'di' });
  });

  it('只在标签内部提示，不打扰普通正文、代码和引号内的值', () => {
    expect(complete('比较 a < b|')).toBeNull();
    expect(complete('正文 `代码 <di|`')).toBeNull();
    expect(complete('<div class="card|')).toBeNull();
    expect(complete('<div class="card">正文|')).toBeNull();
    expect(complete('<div data-id=|')).toBeNull();
  });

  it('补全 style 属性中的 CSS 属性与值', () => {
    const property = complete('<div style="col|');
    expect(property?.kind).toBe('css-property');
    expect(property?.from).toBe('<div style="'.length);
    expect(property?.items[0].label).toBe('color');

    const value = complete('<div style="color: re|');
    expect(value?.kind).toBe('css-value');
    expect(value?.items.map((item) => item.label)).toEqual(['red']);

    const secondProperty = complete('<div style="color: red; dis|');
    expect(secondProperty).toMatchObject({ kind: 'css-property', prefix: 'dis' });

    expect(complete('<div style="color: rgb(1, 2, 3)|')).toBeNull();
  });

  it('补全 <style> 块中的 CSS', () => {
    const property = complete('<style>\n.card { col|');
    expect(property?.kind).toBe('css-property');
    expect(property?.items[0].label).toBe('color');

    const value = complete('<style>\n.card { color: re|');
    expect(value?.kind).toBe('css-value');
    expect(value?.items.map((item) => item.label)).toEqual(['red']);

    expect(complete('<style>\n.card |')).toBeNull();
    expect(complete('<style>\n.card { color: red; }\n.other |')).toBeNull();
  });

  it('识别围栏代码块语言', () => {
    expect(complete('```html\n<div cla|')).toMatchObject({ kind: 'attribute', prefix: 'cla' });
    expect(complete('```css\n.card { col|')).toMatchObject({
      kind: 'css-property',
      prefix: 'col',
    });
    expect(complete('```js\nconst x = "<di|')).toBeNull();
    expect(complete('```html\n<div cla\n```\n正文 |')).toBeNull();
  });

  it('属性值补全在输入完整候选后不再弹出', () => {
    expect(complete('<div style="display: block|')).toBeNull();
    expect(complete('<div style="display: bl|')?.items.map((item) => item.label)).toEqual([
      'block',
    ]);
  });
});
