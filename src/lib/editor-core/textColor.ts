/** 文字颜色：只接受可安全写入 inline style 的 CSS 颜色值。 */

export const TEXT_COLOR_PRESETS = [
  '#e11d48',
  '#f97316',
  '#eab308',
  '#16a34a',
  '#0d9488',
  '#2563eb',
  '#9333ea',
  '#64748b',
] as const;

const HEX_COLOR = /^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i;
const FUNCTIONAL_COLOR =
  /^(?:rgb|rgba|hsl|hsla)\(\s*[\d.%\s,/+-]+\)$/i;
// 常用 CSS 颜色名；范围有限，避免把任意标识符写进 style。
const NAMED_COLORS = new Set([
  'black', 'silver', 'gray', 'grey', 'white', 'maroon', 'red', 'purple', 'fuchsia', 'magenta',
  'green', 'lime', 'olive', 'yellow', 'navy', 'blue', 'teal', 'aqua', 'cyan', 'orange',
  'pink', 'brown', 'gold', 'indigo', 'violet', 'crimson', 'coral', 'salmon', 'tomato',
]);

/** 规范化用户输入；不认识的值返回 null，调用方必须回退而不是照抄。 */
export function normalizeTextColor(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const color = value.trim();
  if (!color) return null;
  if (HEX_COLOR.test(color) || FUNCTIONAL_COLOR.test(color)) return color;
  if (NAMED_COLORS.has(color.toLowerCase())) return color.toLowerCase();
  return null;
}

/** 从 `style` 属性中提取 color 声明；只读取第一处。 */
export function readTextColorFromStyle(style: string | null | undefined): string | null {
  if (!style) return null;
  const match = /(?:^|;)\s*color\s*:\s*([^;]+)/i.exec(style);
  return match ? normalizeTextColor(match[1]) : null;
}

/**
 * 仅当 style 只包含一条合法的 color 声明时返回规范化颜色。
 *
 * 可编辑 HTML 块没有通用 style 载体，只有这种单一声明能无损往返；
 * 混入其它声明时保留原文回退，避免保存后悄悄丢样式。
 */
export function colorFromStyleOnly(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const style = value.trim().replace(/;+\s*$/, '');
  const match = /^color\s*:\s*([^;]+)$/i.exec(style);
  return match ? normalizeTextColor(match[1]) : null;
}

/** 导出 Word 需要 6 位十六进制（无 `#`）；无法无损转换时返回 null。 */
export function textColorToHex(value: unknown): string | null {
  const color = normalizeTextColor(value);
  if (!color) return null;
  const hex = /^#([\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.exec(color);
  if (hex) {
    let digits = hex[1]!;
    // #RGB / #RGBA 展开成 6 位，透明度在 Word 文本颜色里没有对应值，直接丢弃。
    if (digits.length <= 4) digits = digits.slice(0, 3).split('').map((digit) => digit + digit).join('');
    return digits.slice(0, 6).toUpperCase();
  }
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(color);
  if (!rgb) return null;
  return (
    '#' +
    rgb
      .slice(1, 4)
      .map((part) => Math.max(0, Math.min(255, Math.round(Number(part)))).toString(16).padStart(2, '0'))
      .join('')
  )
    .slice(1)
    .toUpperCase();
}

export function textColorOpenTag(color: string): string {
  return `<span style="color: ${color}">`;
}

export function textColorCloseTag(): string {
  return '</span>';
}

/** 读取完整的 `<span style="color: ...">` 开始标签。 */
export function parseTextColorOpenTag(source: string): string | null {
  const match = /^<span\b([^>]*)>$/i.exec(source);
  if (!match) return null;
  const style = /\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(match[1]!);
  return style ? readTextColorFromStyle(style[1] ?? style[2]) : null;
}

export function isTextColorCloseTag(source: string): boolean {
  return /^<\/span\s*>$/i.test(source);
}

/** 判断标签是否为文字颜色 span；是则返回颜色。 */
export function textColorFromHtmlTag(source: string): { color: string; closing: boolean } | null {
  if (isTextColorCloseTag(source)) return { color: '', closing: true };
  const color = parseTextColorOpenTag(source);
  return color ? { color, closing: false } : null;
}
