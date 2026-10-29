/**
 * `.docx.md` token 流绑定。
 *
 * 在 Nomo 恢复空行 token 之后运行：
 * 1. 识别连续的指令行（允许中间隔着空行）；
 * 2. 尾部可附着指令写入后续内容块的 `docxPrefix`；
 * 3. 前置结构指令合并成一个 `docx_meta` token；
 * 4. 指令行与目标之间的空行 token 被移除，避免指令被空行挡在内容之外。
 *
 * 原始指令行逐字保存在 token.meta 中，序列化时原样写回。
 */
import Token from 'markdown-it/lib/token.mjs';
import type { DocxMetaGroup, ParsedDocxDirective } from './model';

type ItemKind = 'directive' | 'emptyParagraph' | 'block';

interface Item {
  kind: ItemKind;
  tokens: Token[];
  startLine: number;
  endLine: number;
  directive?: ParsedDocxDirective;
}

interface RegionEntry {
  directive?: ParsedDocxDirective;
  blank?: true;
  startLine: number;
  endLine: number;
}

const EMPTY_TEXT_TOKENS = new Set(['inline', 'text']);

function readDirective(token: Token): ParsedDocxDirective | null {
  if (token.type !== 'docx_directive') return null;
  const directive = token.meta?.docxDirective as ParsedDocxDirective | undefined;
  return directive ?? null;
}

function isEmptyParagraph(tokens: Token[]): boolean {
  const open = tokens[0];
  const inline = tokens[1];
  const close = tokens[2];
  if (open?.type !== 'paragraph_open' || inline?.type !== 'inline' || close?.type !== 'paragraph_close') {
    return false;
  }
  if (inline.content !== '') return false;
  if ((inline.children ?? []).some((child) => !EMPTY_TEXT_TOKENS.has(child.type))) return false;
  return true;
}

/** 只分析顶层 token；容器内的指令保持为单行 meta 节点。 */
function toItems(tokens: Token[]): Item[] {
  const items: Item[] = [];
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index]!;
    if (token.level !== 0) {
      index += 1;
      continue;
    }
    const startLine = token.map?.[0] ?? 0;
    const endLine = token.map?.[1] ?? startLine + 1;
    if (token.nesting === 1) {
      // 表格单元格里的 paragraph token 被规范化为 level 0，不能靠 level 判断容器边界；
      // 用同名 open/close 配对分组，并统计同名嵌套深度。
      const closeType = `${token.type.replace(/_open$/, '')}_close`;
      const blockTokens: Token[] = [token];
      let depth = 1;
      index += 1;
      while (index < tokens.length) {
        const current = tokens[index]!;
        blockTokens.push(current);
        index += 1;
        if (current.type === token.type) depth += 1;
        else if (current.type === closeType) {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      items.push({
        kind: isEmptyParagraph(blockTokens) ? 'emptyParagraph' : 'block',
        tokens: blockTokens,
        startLine,
        endLine,
      });
      continue;
    }
    const directive = readDirective(token);
    items.push({
      kind: directive ? 'directive' : 'block',
      tokens: [token],
      startLine,
      endLine,
      directive: directive ?? undefined,
    });
    index += 1;
  }
  return items;
}

function trimBlankEdges(entries: RegionEntry[]): RegionEntry[] {
  let from = 0;
  let to = entries.length;
  while (from < to && entries[from]!.blank) from += 1;
  while (to > from && entries[to - 1]!.blank) to -= 1;
  return entries.slice(from, to);
}

function metaKindOf(directives: ParsedDocxDirective[]): DocxMetaGroup['kind'] {
  if (directives.some((directive) => directive.category === 'toc')) return 'toc';
  if (directives.some((directive) => directive.canonicalKeyword === 'global')) return 'global';
  const category = directives[0]?.category;
  switch (category) {
    case 'page':
      return 'page';
    case 'section':
      return 'section';
    case 'headerFooter':
      return 'headerFooter';
    case 'toc':
      return 'toc';
    case 'variable':
      return 'variable';
    case 'function':
      return 'function';
    case 'snippet':
      return 'snippet';
    case 'separator':
      return 'separator';
    case 'object':
      return 'object';
    case 'shape':
      return 'shape';
    case 'import':
      return 'import';
    default:
      return 'mixed';
  }
}

function createMetaToken(
  entries: RegionEntry[],
  kind: DocxMetaGroup['kind'],
  uniqueId: number,
  sectionIndex: number | null = null,
): Token {
  const meta = new Token('docx_meta', '', 0);
  const rawLines = entries.map((entry) => (entry.directive ? entry.directive.raw : ''));
  meta.content = rawLines.join('\n');
  meta.map = [entries[0]!.startLine, entries[entries.length - 1]!.endLine];
  meta.meta = {
    docxMetaLines: rawLines,
    docxMetaKind: kind,
    docxMetaId: uniqueId,
    docxSectionIndex: sectionIndex,
  };
  return meta;
}

export interface DocxTokenTransformResult {
  tokens: Token[];
  /** 每个内容块收到的前缀行数，便于测试与诊断。 */
  prefixBlocks: number;
}

export function transformDocxTokensDetailed(tokens: Token[]): DocxTokenTransformResult {
  const items = toItems(tokens);
  const output: Token[] = [];
  let index = 0;
  let metaId = 0;
  let prefixBlocks = 0;
  // 分节条显示“第 N 节”；编号只在文档顺序上累计，不写入源文件。
  let sectionCount = 0;

  while (index < items.length) {
    const item = items[index]!;
    if (item.kind !== 'directive') {
      output.push(...item.tokens);
      index += 1;
      continue;
    }

    const entries: RegionEntry[] = [];
    let cursor = index;
    let pendingBlanks: Item[] = [];
    while (cursor < items.length) {
      const current = items[cursor]!;
      if (current.kind === 'directive' && current.directive) {
        for (let count = 0; count < pendingBlanks.length; count += 1) {
          entries.push({ blank: true, startLine: current.startLine, endLine: current.startLine });
        }
        pendingBlanks = [];
        entries.push({
          directive: current.directive,
          startLine: current.startLine,
          endLine: current.endLine,
        });
        cursor += 1;
        continue;
      }
      if (current.kind === 'emptyParagraph') {
        pendingBlanks.push(current);
        cursor += 1;
        continue;
      }
      break;
    }
    // pendingBlanks 是指令与目标之间的空行；删除它们，避免序列化时空行出现在指令之前。
    pendingBlanks = [];

    const following = items[cursor];
    const hasFollowingContent = following != null && following.kind === 'block';

    // TOC 指令连同它前面的 font/paragraph/@toc.* 是一个独立的目录结构块；
    // 每个 TOC 结束当前 meta 段。剩余的最后一段才可能成为后续内容的前缀。
    const segments: RegionEntry[][] = [];
    let currentSegment: RegionEntry[] = [];
    for (const entry of entries) {
      // `global.*` 是文档属性，不和后面的字体/目录指令混成一个节点。
      const isGlobal = entry.directive?.canonicalKeyword === 'global';
      const segmentKeyword = currentSegment.find((item) => item.directive)?.directive?.canonicalKeyword;
      if (segmentKeyword && (segmentKeyword === 'global') !== isGlobal) {
        segments.push(currentSegment);
        currentSegment = [];
      }
      currentSegment.push(entry);
      if (entry.directive?.attach === 'toc') {
        segments.push(currentSegment);
        currentSegment = [];
      }
    }
    if (currentSegment.length) segments.push(currentSegment);

    let prefixEntries: RegionEntry[] = [];
    for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
      const segment = segments[segmentIndex]!;
      const isLast = segmentIndex === segments.length - 1;
      const endsWithToc = segment[segment.length - 1]?.directive?.attach === 'toc';
      let metaEntries = trimBlankEdges(segment);

      if (isLast && !endsWithToc) {
        const firstBlock = metaEntries.findIndex(
          (entry) => entry.directive?.attach === 'block',
        );
        if (firstBlock >= 0) {
          prefixEntries = trimBlankEdges(metaEntries.slice(firstBlock));
          metaEntries = trimBlankEdges(metaEntries.slice(0, firstBlock));
        }
      }

      const metaDirectives = metaEntries
        .map((entry) => entry.directive)
        .filter((directive): directive is ParsedDocxDirective => Boolean(directive));
      if (metaDirectives.length) {
        metaId += 1;
        const kind = metaKindOf(metaDirectives);
        if (kind === 'section') sectionCount += 1;
        output.push(
          createMetaToken(metaEntries, kind, metaId, kind === 'section' ? sectionCount : null),
        );
      }
    }

    if (!hasFollowingContent) {
      // 指令后没有内容可附着（尤其是文件末尾）：全部保留为 meta，绝不丢弃。
      if (prefixEntries.length) {
        metaId += 1;
        const kind = metaKindOf(
          prefixEntries
            .map((entry) => entry.directive)
            .filter((directive): directive is ParsedDocxDirective => Boolean(directive)),
        );
        if (kind === 'section') sectionCount += 1;
        output.push(
          createMetaToken(prefixEntries, kind, metaId, kind === 'section' ? sectionCount : null),
        );
        prefixEntries = [];
      }
    } else if (prefixEntries.length && following) {
      const prefixLines = prefixEntries.map((entry) => (entry.directive ? entry.directive.raw : ''));
      const target = following.tokens[0]!;
      target.meta = { ...target.meta, docxPrefix: prefixLines };
      prefixBlocks += 1;
    }

    index = cursor;
  }

  return { tokens: output, prefixBlocks };
}

export function transformDocxTokens(tokens: Token[]): Token[] {
  return transformDocxTokensDetailed(tokens).tokens;
}
