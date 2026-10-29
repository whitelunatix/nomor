/**
 * GFM 裸链接识别：`https://…`、`www.…` 与邮箱。
 *
 * 解析时生成普通 link token，因此编辑器、保存和导出复用同一套链接模型；
 * 原文不加 `[]()`，由序列化器在文本仍与地址一致时原样写回。
 */
import type MarkdownIt from 'markdown-it';
import { createLinkAttrs } from './link';

export interface BareLinkMatch {
  /** 原文中实际显示的文本。 */
  text: string;
  /** 规范化后的链接地址。 */
  href: string;
  /** 匹配结束位置（相对传入的 src）。 */
  end: number;
}

const EMAIL_RE =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,}/;
const URL_RE = /^https?:\/\/[^\s<>"']+/i;
const WWW_RE = /^www\.[^\s<>"']+/i;
/** 主机名带端口，或 localhost，或 IPv4。 */
const HOST_RE =
  /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,}$|^localhost$|^(?:\d{1,3}\.){3}\d{1,3}$/;
/** 前面是这些字符时视为词内片段，不单独识别。 */
const BLOCKING_PREVIOUS = /[A-Za-z0-9_%+.-]/;
const TRAILING_PUNCTUATION = /[.,:;!?*_~'"»”’]/;

/**
 * 在 src 的 pos 处尝试匹配一个裸链接。
 * 只匹配完整地址；调用方负责保证 pos 位于词边界。
 */
export function matchBareLinkAt(src: string, pos: number): BareLinkMatch | null {
  if (pos < 0 || pos >= src.length) return null;
  if (pos > 0 && BLOCKING_PREVIOUS.test(src[pos - 1]!)) return null;

  const rest = src.slice(pos);
  const urlMatch = URL_RE.exec(rest) ?? WWW_RE.exec(rest);
  if (urlMatch) {
    const text = trimTrailingPunctuation(urlMatch[0]);
    if (!text) return null;
    const href = createLinkAttrs(/^www\./i.test(text) ? `http://${text}` : text);
    if (!href || !isAcceptableHost(readHost(href.href))) return null;
    return { text, href: href.href, end: pos + text.length };
  }

  const emailMatch = EMAIL_RE.exec(rest);
  if (emailMatch) {
    const href = createLinkAttrs(`mailto:${emailMatch[0]}`);
    if (!href) return null;
    return { text: emailMatch[0], href: href.href, end: pos + emailMatch[0].length };
  }

  return null;
}

/** 文本整体就是一个裸链接时返回应有的 href，供序列化器判断能否省略括号。 */
export function bareLinkHrefForText(text: string): string | null {
  const match = matchBareLinkAt(text, 0);
  return match && match.end === text.length ? match.href : null;
}

/**
 * 在行内规则表里注册裸链接识别，位于 text 规则之前。
 *
 * markdown-it 的 text 规则会一次性吞掉整段非终止字符，只在这些字符处
 * 才轮到其它规则；因此本规则还要负责把光标推进到同一段文字里的网址起点。
 */
export function registerBareLinkRule(markdown: MarkdownIt): void {
  markdown.inline.ruler.before('text', 'nomo_bare_link', (state, silent) => {
    const found = findBareLinkStart(state.src, state.pos, state.posMax);
    if (!found) return false;

    if (found.start > state.pos) {
      if (!silent) state.pending += state.src.slice(state.pos, found.start);
      state.pos = found.start;
      return true;
    }

    if (silent) {
      state.pos = found.match.end;
      return true;
    }

    const open = state.push('link_open', 'a', 1);
    open.attrSet('href', found.match.href);
    // 保存时据此判断是否还原成裸链接原文。
    open.meta = { autoLink: true };
    const text = state.push('text', '', 0);
    text.content = found.match.text;
    state.push('link_close', 'a', -1);
    state.pos = found.match.end;
    return true;
  });
}

/**
 * 在下一段普通文字内寻找裸链接起点。
 * 遇到 markdown-it 的终止字符立即停止，保证其它行内规则仍能接管。
 */
function findBareLinkStart(
  src: string,
  pos: number,
  posMax: number,
): { start: number; match: BareLinkMatch } | null {
  if (pos < posMax && isTerminatorChar(src.charCodeAt(pos))) return null;
  for (let start = pos; start < posMax; start++) {
    if (start > pos && isTerminatorChar(src.charCodeAt(start))) return null;
    const match = matchBareLinkAt(src, start);
    if (match) return { start, match };
  }
  return null;
}

/** 与 markdown-it 内联 text 规则保持一致的终止字符表。 */
function isTerminatorChar(code: number): boolean {
  switch (code) {
    case 0x0a: case 0x21: case 0x23: case 0x24: case 0x25: case 0x26:
    case 0x2a: case 0x2b: case 0x2d: case 0x3a: case 0x3c: case 0x3d:
    case 0x3e: case 0x40: case 0x5b: case 0x5c: case 0x5d: case 0x5e:
    case 0x5f: case 0x60: case 0x7b: case 0x7d: case 0x7e:
      return true;
    default:
      return false;
  }
}

function readHost(href: string): string {
  const withoutScheme = href.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '');
  return (withoutScheme.split(/[/?#]/, 1)[0] ?? '').replace(/:\d+$/, '');
}

function isAcceptableHost(host: string): boolean {
  return HOST_RE.test(host);
}

/**
 * 去掉句末标点与不成对的右括号。
 * 维基百科的 `Foo_(bar)` 这类地址括号成对，必须保留。
 */
function trimTrailingPunctuation(value: string): string {
  let end = value.length;
  while (end > 0 && TRAILING_PUNCTUATION.test(value[end - 1]!)) end--;
  while (end > 0 && value[end - 1] === ')') {
    const candidate = value.slice(0, end);
    if (countChar(candidate, '(') >= countChar(candidate, ')')) break;
    end--;
  }
  return value.slice(0, end);
}

function countChar(value: string, character: string): number {
  let count = 0;
  for (const entry of value) if (entry === character) count++;
  return count;
}
