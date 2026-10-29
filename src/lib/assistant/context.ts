/** 工具结果进入上下文前的截断与 token 估算。 */

const CJK_PATTERN = /[㐀-䶿一-鿿豈-﫿぀-ヿ가-힯]/g;

/** 粗略估算：中日韩字符约 1 token/字，其余按 4 字符/token。只用于页脚展示与预算提示。 */
export function estimateTokens(text: string): number {
  if (!text) {
    return 0;
  }
  const cjk = text.match(CJK_PATTERN)?.length ?? 0;
  const rest = Math.max(0, text.length - cjk);
  return Math.max(1, cjk + Math.ceil(rest / 4));
}

export function truncateText(text: string, maxChars: number): string {
  if (maxChars <= 0 || text.length <= maxChars) {
    return text;
  }
  const head = Math.floor(maxChars * 0.7);
  const tail = maxChars - head;
  return `${text.slice(0, head)}\n\n…（已省略 ${text.length - maxChars} 个字符）…\n\n${text.slice(-tail)}`;
}

/** 工具返回值统一转成字符串再交给模型，避免嵌套对象被序列化成难读的一行。 */
export function stringifyToolOutput(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export const TOOL_OUTPUT_LIMIT = 8_000;

export function formatToolOutput(value: unknown): string {
  return truncateText(stringifyToolOutput(value), TOOL_OUTPUT_LIMIT);
}
