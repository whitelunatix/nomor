import { getDiagramTypeLabel, t } from '../../app/i18n';
import { DIAGRAM_TEMPLATES } from './diagramTemplates';
import type { EditorCommand } from './types';

export const DEFAULT_QUICK_INSERT_TRIGGER = '/';

/** 触发符号只接受一个标点或符号，避免普通文字输入频繁唤起菜单。 */
export function isQuickInsertTrigger(value: unknown): value is string {
  return typeof value === 'string' && /^[\p{P}\p{S}]$/u.test(value);
}

export type QuickInsertEditorCommand = Extract<
  EditorCommand,
  {
    type:
      | 'setHeading'
      | 'toggleBulletList'
      | 'toggleOrderedList'
      | 'toggleTaskList'
      | 'insertTable'
      | 'insertCodeBlock'
      | 'toggleBlockquote'
      | 'insertCallout'
      | 'insertDetails'
      | 'insertHorizontalRule'
      | 'insertMathBlock'
      | 'insertMathInline'
      | 'insertDiagramBlock'
      | 'insertCommentInline'
      | 'insertCommentBlock';
  }
>;

export type QuickInsertCommand =
  | QuickInsertEditorCommand
  | { type: 'chooseImage' }
  | { type: 'chooseEmoji' }
  | { type: 'chooseLink' };

export interface QuickInsertVariant {
  label: () => string;
  command: QuickInsertCommand;
}

export interface QuickInsertCategory {
  id: string;
  label: () => string;
  icon: string;
  defaultVariant?: number;
  variants: QuickInsertVariant[];
}

/** 每个类别只占一行；样式由左右键切换，不提供文字搜索。 */
export const QUICK_INSERT_CATEGORIES: QuickInsertCategory[] = [
  {
    id: 'heading',
    label: () => t.quickInsertHeading(),
    icon: 'heading',
    variants: ([1, 2, 3, 4, 5, 6] as const).map((level) => ({
      label: () => `H${level}`,
      command: { type: 'setHeading', level },
    })),
  },
  {
    id: 'list',
    label: () => t.quickInsertList(),
    icon: 'list',
    variants: [
      { label: () => t.quickInsertBullet(), command: { type: 'toggleBulletList' } },
      { label: () => t.quickInsertOrdered(), command: { type: 'toggleOrderedList' } },
      { label: () => t.quickInsertTask(), command: { type: 'toggleTaskList' } },
    ],
  },
  {
    id: 'table',
    label: () => t.quickInsertTable(),
    icon: 'table',
    defaultVariant: 1,
    variants: [
      [2, 2],
      [3, 2],
      [3, 3],
      [4, 3],
    ].map(([columns, rows]) => ({
      label: () => `${columns}×${rows}`,
      command: { type: 'insertTable', rows, columns },
    })),
  },
  {
    id: 'code',
    label: () => t.codeBlock(),
    icon: 'code',
    variants: ['', 'js', 'ts', 'python', 'json', 'bash'].map((language) => ({
      label: () =>
        language
          ? ({ js: 'JS', ts: 'TS', python: 'Python', json: 'JSON', bash: 'Bash' }[language] ??
            language)
          : t.quickInsertPlainText(),
      command: { type: 'insertCodeBlock', language },
    })),
  },
  {
    id: 'quote',
    label: () => t.quickInsertQuote(),
    icon: 'quote',
    variants: [{ label: () => '', command: { type: 'toggleBlockquote' } }],
  },
  {
    id: 'callout',
    label: () => t.quickInsertCallout(),
    icon: 'callout',
    variants: (['tip', 'note', 'important', 'warning', 'caution'] as const).map((calloutType) => ({
      label: () => t[`quickInsertCallout_${calloutType}`](),
      command: { type: 'insertCallout', calloutType },
    })),
  },
  {
    id: 'image',
    label: () => t.image(),
    icon: 'image',
    variants: [{ label: () => '', command: { type: 'chooseImage' } }],
  },
  {
    id: 'details',
    label: () => t.details(),
    icon: 'quote',
    variants: [{ label: () => '', command: { type: 'insertDetails' } }],
  },
  {
    id: 'link',
    label: () => t.link(),
    icon: 'link',
    variants: [{ label: () => '', command: { type: 'chooseLink' } }],
  },
  {
    id: 'math',
    label: () => t.quickInsertMath(),
    icon: 'math',
    variants: [
      { label: () => t.mathBlock(), command: { type: 'insertMathBlock', tex: '' } },
      { label: () => t.mathInline(), command: { type: 'insertMathInline' } },
    ],
  },
  {
    id: 'diagram',
    label: () => t.diagram(),
    icon: 'diagram',
    variants: DIAGRAM_TEMPLATES.map(({ type }) => ({
      label: () => getDiagramTypeLabel(type),
      command: { type: 'insertDiagramBlock', diagramType: type },
    })),
  },
  {
    id: 'comment',
    label: () => t.comment(),
    icon: 'comment',
    variants: [
      { label: () => t.quickInsertInline(), command: { type: 'insertCommentInline', content: '' } },
      { label: () => t.quickInsertBlock(), command: { type: 'insertCommentBlock', content: '' } },
    ],
  },
  {
    id: 'divider',
    label: () => t.horizontalRule(),
    icon: 'divider',
    variants: [{ label: () => '', command: { type: 'insertHorizontalRule' } }],
  },
  {
    id: 'emoji', label: () => t.emojiInsert(), icon: 'emoji',
    variants: [{ label: () => '', command: { type: 'chooseEmoji' } }],
  },
];
