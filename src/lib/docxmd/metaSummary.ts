/**
 * 结构指令的摘要文本。
 *
 * NodeView（编辑器内标记条）与属性面板（文档面板）共用同一套摘要，
 * 避免两处对同一条分节/页眉页脚给出不同说法。
 */
import { parseDirectiveLine } from './directiveGrammar';
import type { ParsedDocxDirective } from './model';

export const DOCX_META_KIND_LABELS: Record<string, string> = {
  global: '文档全局',
  page: '页面',
  section: '分节',
  headerFooter: '页眉页脚',
  toc: '目录',
  variable: '变量',
  function: '函数',
  snippet: '片段',
  separator: '分隔',
  object: '对象',
  shape: '形状',
  import: '导入',
  mixed: '指令',
};

function normalize(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, '');
}

function readField(directive: ParsedDocxDirective, ...names: string[]): string | null {
  const wanted = new Set(names.map(normalize));
  for (const group of directive.groups) {
    for (const field of group.fields) {
      if (wanted.has(normalize(field.canonicalName || field.rawName))) {
        const value = field.value.trim();
        if (value) return value;
      }
    }
  }
  return null;
}

function readBodyName(directive: ParsedDocxDirective): string | null {
  const equals = directive.body.indexOf('=');
  const name = (equals >= 0 ? directive.body.slice(0, equals) : directive.body).trim();
  return name || null;
}

function shorten(value: string, limit = 24): string {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function sectionLabel(value: string | null): string | null {
  if (!value) return null;
  switch (value.toLowerCase()) {
    case 'nextpage':
    case 'next-page':
      return '下一页';
    case 'continuous':
      return '连续';
    case 'oddpage':
    case 'odd-page':
      return '奇数页';
    case 'evenpage':
    case 'even-page':
      return '偶数页';
    default:
      return value;
  }
}

function numberFormatLabel(value: string | null): string | null {
  if (!value) return null;
  switch (value.toLowerCase()) {
    case 'upperroman':
      return '大写罗马数字';
    case 'lowerroman':
      return '小写罗马数字';
    case 'upperletter':
    case 'upperalpha':
      return '大写字母';
    case 'lowerletter':
    case 'loweralpha':
      return '小写字母';
    case 'decimal':
      return '阿拉伯数字';
    default:
      return value;
  }
}

function tocLabel(directive: ParsedDocxDirective): string {
  const type = (readField(directive, 'type') ?? 'headings').toLowerCase();
  const levels = readField(directive, 'levels');
  const base =
    type === 'figures'
      ? '图目录'
      : type === 'tables'
        ? '表目录'
        : type === 'equations'
          ? '公式目录'
          : '标题目录';
  return levels ? `${base} · ${levels} 级` : base;
}

function headerFooterLabel(directive: ParsedDocxDirective): string {
  const role = directive.canonicalKeyword === 'footer' ? '页脚' : '页眉';
  const enabled = readField(directive, 'enabled');
  if (enabled && /^(false|0|no|off)$/i.test(enabled)) return `无${role}`;
  const parts = [role];
  const scope = readField(directive, 'scope');
  if (scope) {
    parts.push(scope.toLowerCase() === 'odd' ? '奇数页' : scope.toLowerCase() === 'even' ? '偶数页' : '全部');
  }
  const position = readField(directive, 'position');
  if (position) {
    const map: Record<string, string> = {
      left: '左',
      center: '居中',
      centre: '居中',
      right: '右',
    };
    parts.push(map[position.toLowerCase()] ?? position);
  }
  const content = readField(directive, 'content');
  if (content) parts.push(shorten(content));
  return parts.join(' · ');
}

function pageLabel(directive: ParsedDocxDirective): string | null {
  const parts: string[] = [];
  const size = readField(directive, 'size');
  if (size) parts.push(shorten(size, 10));
  const orientation = readField(directive, 'orientation');
  if (orientation) parts.push(orientation.toLowerCase() === 'landscape' ? '横向' : '纵向');
  const columns = readField(directive, 'columns.count');
  if (columns && Number(columns) > 1) parts.push(`${columns} 栏`);
  const gutter = readField(directive, 'gutter');
  if (gutter && gutter !== '0cm' && gutter !== '0') parts.push(`装订线 ${gutter}`);
  if (directive.inlineDecorators.some((decorator) => decorator.keyword === '@page.gutter')) {
    parts.push('可见装订线');
  }
  const gridType = readField(directive, 'grid.type');
  if (gridType && gridType !== 'default') parts.push(`网格 ${gridType}`);
  const format = numberFormatLabel(readField(directive, 'page.number.format'));
  if (format) parts.push(format);
  const start = readField(directive, 'page.number.start');
  if (start) parts.push(`从 ${start} 起`);
  return parts.length ? parts.join(' · ') : null;
}

function summarizeDirectives(
  kind: string,
  directives: ParsedDocxDirective[],
  sectionIndex: number | null,
): string {
  if (kind === 'separator') return '';
  const parts: string[] = [];
  for (const directive of directives) {
    switch (directive.canonicalKeyword) {
      case 'section': {
        const start = sectionLabel(readField(directive, 'start'));
        const head = sectionIndex ? `第 ${sectionIndex} 节` : '分节';
        parts.push(start ? `${head} · ${start}` : head);
        break;
      }
      case 'page': {
        const label = pageLabel(directive);
        if (label) parts.push(label);
        break;
      }
      case 'header':
      case 'footer':
        parts.push(headerFooterLabel(directive));
        break;
      case 'toc':
        parts.push(`${tocLabel(directive)}（由 Word 生成）`);
        break;
      case 'global': {
        if (directive.globalTarget === 'page') {
          const label = pageLabel(directive);
          if (label) {
            parts.push(label);
            break;
          }
        }
        parts.push(`全局 ${directive.globalTarget ?? directive.groups[0]?.canonicalKeyword ?? ''}`.trim());
        break;
      }
      case 'var':
      case 'fun': {
        const name = readBodyName(directive);
        parts.push(`${directive.canonicalKeyword === 'var' ? '变量' : '函数'} ${name ?? ''}`.trim());
        break;
      }
      case 'snippet':
      case '/snippet': {
        const name = directive.body.trim();
        parts.push(name ? `片段 ${name}` : '片段');
        break;
      }
      case 'shape': {
        const preset = readField(directive, 'preset');
        const id = readField(directive, 'id');
        parts.push(
          [preset ? `形状 ${preset}` : '形状', id ? `#${id}` : null]
            .filter(Boolean)
            .join(' · '),
        );
        break;
      }
      case 'object': {
        const type = readField(directive, 'type');
        const value = readField(directive, 'value');
        parts.push(
          [type ? `对象 ${type}` : '对象/域', value ? shorten(value, 16) : null]
            .filter(Boolean)
            .join(' · '),
        );
        break;
      }
      case 'import': {
        const match = /^\s*"([^"]+)"(?:\s+as\s+([A-Za-z_]\w*))?/.exec(directive.body);
        const alias = match?.[2] ?? match?.[1];
        parts.push(alias ? `导入 ${shorten(alias, 20)}` : '导入');
        break;
      }
      default:
        break;
    }
  }
  if (parts.length === 0) {
    return directives.length ? `${directives.length} 条指令` : '';
  }
  // 连续同类项去重，避免一行一个的页眉页脚重复刷屏。
  return Array.from(new Set(parts)).join(' · ');
}

export function summarizeDirectiveLines(
  kind: string,
  lines: readonly string[],
  sectionIndex: number | null = null,
): string {
  const directives = lines
    .map((line) => parseDirectiveLine(String(line)))
    .filter((directive): directive is ParsedDocxDirective => Boolean(directive));
  return summarizeDirectives(kind, directives, sectionIndex);
}
