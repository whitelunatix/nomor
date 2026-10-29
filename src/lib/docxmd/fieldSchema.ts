/**
 * `.docx.md` 属性面板的字段控件元数据。
 *
 * 官方字段表只提供字段名与别名，枚举/单位/默认值来自
 * `instructions_gen.md`；这里只收录编辑器需要的常用项，未知字段保留为文本输入。
 */

export type DocxFieldControl =
  | 'enum'
  | 'color'
  | 'length'
  | 'boolean'
  | 'number'
  | 'position'
  | 'tokens'
  | 'text';

export interface DocxFieldOption {
  value: string;
  label: string;
}

export interface DocxFieldSchema {
  control: DocxFieldControl;
  options?: DocxFieldOption[];
  placeholder?: string;
  unit?: string;
}

function options(...values: string[]): DocxFieldOption[] {
  return values.map((value) => ({ value, label: value }));
}

function optionPairs(pairs: Array<[string, string]>): DocxFieldOption[] {
  return pairs.map(([value, label]) => ({ value, label }));
}

const ALIGN = optionPairs([
  ['left', '左对齐'],
  ['center', '居中'],
  ['right', '右对齐'],
  ['justify', '两端对齐'],
  ['both', '分散对齐'],
]);

const VERTICAL = optionPairs([
  ['top', '顶端'],
  ['center', '居中'],
  ['bottom', '底端'],
]);

const NUMBER_FORMATS = optionPairs([
  ['decimal', '阿拉伯数字'],
  ['upperRoman', '大写罗马数字'],
  ['lowerRoman', '小写罗马数字'],
  ['upperLetter', '大写字母'],
  ['lowerLetter', '小写字母'],
  ['chineseCounting', '中文数字'],
]);

const BORDER_STYLES = optionPairs([
  ['single', '单线'],
  ['double', '双线'],
  ['dash', '虚线'],
  ['dot', '点线'],
  ['none', '无'],
]);

const BORDER_SIDES = optionPairs([
  ['top', '上'],
  ['bottom', '下'],
  ['left', '左'],
  ['right', '右'],
  ['insideH', '内部横线'],
  ['insideV', '内部竖线'],
  ['all', '全部'],
]);

const FIELD_LABELS: Record<string, string> = {
  align: '对齐',
  alignment: '对齐',
  bg: '背景色',
  background: '背景色',
  bold: '加粗',
  color: '颜色',
  'col.width': '列宽',
  content: '内容',
  enabled: '启用',
  fit: '适配',
  font: '字体',
  format: '编号格式',
  height: '高度',
  highlight: '高亮',
  id: '标识',
  'indent.firstLine': '首行缩进',
  'indent.hanging': '悬挂缩进',
  'indent.left': '左缩进',
  'indent.right': '右缩进',
  italic: '斜体',
  level: '级别',
  'line.spacing': '行距',
  'layout.align': '对齐',
  'layout.fit': '适配',
  'layout.wrap': '环绕',
  margins: '页边距',
  mix: '字体',
  name: '名称',
  number: '编号',
  ordered: '有序标记',
  orientation: '方向',
  'page.number.format': '页码格式',
  'page.number.start': '起始页码',
  position: '位置',
  restart: '重新编号',
  scope: '范围',
  size: '纸张',
  'size.height': '高度',
  'size.width': '宽度',
  'space.after': '段后',
  'space.before': '段前',
  special: '缩进方式',
  'special.by': '缩进量',
  start: '起始值',
  strike: '删除线',
  style: '样式',
  'border.color': '边框颜色',
  'border.style': '边框线型',
  'border.thickness': '边框线宽',
  'border.visible': '边框位置',
  'row.height': '行高',
  'row.valign': '垂直对齐',
  'row.oddBg': '奇数行背景',
  'row.evenBg': '偶数行背景',
  'row.oddColor': '奇数行文字色',
  'row.evenColor': '偶数行文字色',
  text: '编号文本',
  type: '类型',
  underline: '下划线',
  unordered: '无序标记',
};

export function docxFieldLabel(name: string): string {
  return FIELD_LABELS[name] ?? name;
}

function normalized(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, '');
}

/** 按关键字 + 字段名给出控件；关键字用于区分 `position` 等重名字段。 */
export function docxFieldSchema(keyword: string, rawName: string): DocxFieldSchema {
  const name = normalized(rawName);
  const lowerKeyword = keyword.toLowerCase();

  if (name === 'align' || name === 'alignment') return { control: 'enum', options: ALIGN };
  if (name === 'level') {
    return {
      control: 'enum',
      options: options('h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'h7', 'h8', 'h9'),
    };
  }
  if (name === 'special') {
    return {
      control: 'enum',
      options: optionPairs([
        ['first', '首行缩进'],
        ['hanging', '悬挂缩进'],
        ['none', '无'],
      ]),
    };
  }
  if (name === 'line.spacing') return { control: 'length', unit: '倍', placeholder: '1.25 或 22pt' };
  if (name === 'ordered') return { control: 'enum', options: NUMBER_FORMATS };
  if (name === 'unordered') {
    return {
      control: 'enum',
      options: optionPairs([
        ['disc', '圆点'],
        ['circle', '空心圆'],
        ['square', '方块'],
      ]),
    };
  }
  if (name === 'format' && /numbering/.test(lowerKeyword)) {
    return { control: 'enum', options: NUMBER_FORMATS };
  }
  if (name === 'position') {
    if (lowerKeyword === '@table.cell' || lowerKeyword === '@table.paragraph') {
      return { control: 'position', placeholder: '(row, col)' };
    }
    if (lowerKeyword === 'break') {
      return {
        control: 'enum',
        options: optionPairs([
          ['before', '之前'],
          ['after', '之后'],
        ]),
      };
    }
    return {
      control: 'enum',
      options: optionPairs([
        ['left', '左'],
        ['center', '居中'],
        ['right', '右'],
      ]),
    };
  }
  if (name === 'type') {
    if (lowerKeyword === 'caption') {
      return {
        control: 'enum',
        options: optionPairs([
          ['figure', '图'],
          ['table', '表'],
        ]),
      };
    }
    if (lowerKeyword === 'break') {
      return {
        control: 'enum',
        options: optionPairs([
          ['page', '分页'],
          ['column', '分栏'],
          ['line', '换行'],
        ]),
      };
    }
    if (lowerKeyword === 'toc') {
      return {
        control: 'enum',
        options: optionPairs([
          ['headings', '标题'],
          ['figures', '图'],
          ['tables', '表'],
          ['equations', '公式'],
        ]),
      };
    }
  }
  if (name === 'scope') {
    return {
      control: 'enum',
      options: optionPairs([
        ['all', '全部'],
        ['odd', '奇数页'],
        ['even', '偶数页'],
        ['first', '首页'],
      ]),
    };
  }
  if (name === 'start' && lowerKeyword === 'section') {
    return {
      control: 'enum',
      options: optionPairs([
        ['nextPage', '下一页'],
        ['continuous', '连续'],
        ['oddPage', '奇数页'],
        ['evenPage', '偶数页'],
      ]),
    };
  }
  if (name === 'size') {
    // `page | size: A4` 是纸张，`font | size: 12pt` 是字号。
    return lowerKeyword === 'page' || lowerKeyword === 'section'
      ? { control: 'enum', options: options('A4', 'A3', 'A5', 'Letter', 'Legal') }
      : { control: 'length' };
  }
  if (name === 'orientation') {
    return {
      control: 'enum',
      options: optionPairs([
        ['portrait', '纵向'],
        ['landscape', '横向'],
      ]),
    };
  }
  if (name === 'page.number.format') return { control: 'enum', options: NUMBER_FORMATS };
  if (name === 'row.valign' || name === 'valign' || name === 'vertical.align') {
    return { control: 'enum', options: VERTICAL };
  }
  if (name === 'border.visible') return { control: 'tokens', options: BORDER_SIDES };
  if (name === 'border.style') return { control: 'enum', options: BORDER_STYLES };
  if (name.startsWith('border.')) return { control: 'length' };
  if (name === 'layout.wrap' || name === 'wrap') {
    return {
      control: 'enum',
      options: optionPairs([
        ['inline', '嵌入'],
        ['square', '方形环绕'],
        ['tight', '紧密环绕'],
        ['through', '穿越环绕'],
        ['topAndBottom', '上下环绕'],
      ]),
    };
  }
  if (name === 'layout.fit' || name === 'fit') {
    return { control: 'text', placeholder: 'max / contain / cover' };
  }
  if (/(color|bg|background|highlight)/.test(name)) return { control: 'color' };
  if (/(width|height|indent\.|space\.|thickness|spacing|distance|gutter)/.test(name)) {
    return { control: 'length' };
  }
  if (/(bold|italic|underline|strike|superscript|subscript|nowrap|fittext|enabled)/.test(name)) {
    return { control: 'boolean' };
  }
  if (name === 'start' || name === 'page.number.start' || name === 'nest') {
    return { control: 'number' };
  }
  if (name === 'col.width') return { control: 'tokens', placeholder: '4.2cm 4.2cm' };
  return { control: 'text' };
}

/** 颜色字段允许 `#D9E2F3`、`red`、`rgb(...)`，不接受空值。 */
export function normalizeColorValue(value: string): string {
  return value.trim();
}
