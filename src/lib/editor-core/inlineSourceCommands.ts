import type { Mark, Node as PmNode } from 'prosemirror-model';
import { toggleMark } from 'prosemirror-commands';
import { TextSelection, type Command, type EditorState, type Transaction } from 'prosemirror-state';
import {
  analyzeInlineSource,
  analyzeInlineSourceText,
  inlineFormatDelimiters,
  escapeInlineSourceLiteral,
} from './InlineSourceCodec';
import {
  findEmptyInlineSourceTemplate,
  getEmptyInlineSourceTemplates,
  removeInlineSourceTemplateOrigin,
} from './plugins/inlineSourceEditing';

export type InlineSourceFormat =
  | 'strong'
  | 'em'
  | 'code'
  | 'strikethrough'
  | 'underline'
  | 'highlight'
  | 'superscript'
  | 'subscript';

const FORMATS: readonly InlineSourceFormat[] = [
  'strong',
  'em',
  'code',
  'strikethrough',
  'underline',
  'highlight',
  'superscript',
  'subscript',
];
type SourceSpan = ReturnType<typeof analyzeInlineSource>['spans'][number];
type TextEdit = {
  from: number;
  to: number;
  text: string;
  node?: PmNode;
  order?: number;
  marks?: readonly Mark[];
};
type SourceBlock = {
  node: PmNode;
  start: number;
  from: number;
  to: number;
  source: string;
  spans: SourceSpan[];
};

/** Commands and toolbar state use the same parsed source ranges as the display plugin. */
export function getActiveInlineSourceFormats(state: EditorState): Set<InlineSourceFormat> {
  const result = new Set<InlineSourceFormat>();
  if (inStandaloneHtmlBlock(state)) {
    for (const type of FORMATS) {
      const mark = state.schema.marks[type];
      if (
        state.selection.empty
          ? mark.isInSet(state.storedMarks ?? state.selection.$from.marks())
          : state.doc.rangeHasMark(state.selection.from, state.selection.to, mark)
      )
        result.add(type);
    }
    return result;
  }
  const blocks = selectedBlocks(state);
  for (const type of FORMATS) {
    const relevantBlocks =
      type === 'code' && !state.selection.empty ? blocks.filter(hasSelectedCodeText) : blocks;
    if (state.selection.empty) {
      if (
        blocks.some((block) =>
          block.spans.some(
            (span) => span.type === type && block.from > span.openFrom && block.from < span.closeTo,
          ),
        )
      )
        result.add(type);
    } else if (
      relevantBlocks.length &&
      relevantBlocks.every((block) => isSelectionFormatted(block, type))
    ) {
      result.add(type);
    }
  }
  for (const template of getEmptyInlineSourceTemplates(state)) {
    if (state.selection.from > template.from && state.selection.to < template.to) {
      result.add(template.type as InlineSourceFormat);
    }
  }
  return result;
}

/** Insert/remove real delimiters; no stored mark, fake caret position, or arrow-key interception. */
export function toggleInlineSourceFormat(type: InlineSourceFormat): Command {
  return (state, dispatch) => {
    if (inStandaloneHtmlBlock(state)) return toggleMark(state.schema.marks[type])(state, dispatch);
    let blocks = selectedBlocks(state).filter(
      (block) => type !== 'code' || state.selection.empty || hasSelectedCodeText(block),
    );
    if (!blocks.length) return false;
    const oppositeTemplateType = type === 'superscript' ? 'subscript' : type === 'subscript' ? 'superscript' : null;
    const oppositeTemplate = state.selection.empty && oppositeTemplateType
      ? findEmptyInlineSourceTemplate(state, oppositeTemplateType) : undefined;
    if (oppositeTemplate) {
      if (dispatch) {
        const pair = inlineFormatDelimiters(type);
        const { from, to } = oppositeTemplate;
        const tr = state.tr;
        removeInlineSourceTemplateOrigin(tr, oppositeTemplate);
        tr.replaceWith(from, to, state.schema.text(pair.open + pair.close, sourceMarksAt(state, from)));
        const cursor = from + pair.open.length;
        tr.setSelection(TextSelection.create(tr.doc, cursor));
        tr.setMeta('inlineSourceTemplate', { action: 'add', template: {
          from, to: from + pair.open.length + pair.close.length, cursor, type,
        } });
        dispatch(tr.scrollIntoView());
      }
      return true;
    }
    if (type !== 'code') {
      const aligned = blocks.map((block) => alignSelectionWithCode(block, type));
      if (aligned.some((block) => block === null)) return false;
      blocks = aligned as SourceBlock[];
    }
    const template = state.selection.empty ? findEmptyInlineSourceTemplate(state, type) : undefined;
    if (template) {
      if (dispatch) {
        const pair = inlineFormatDelimiters(type, '');
        const tr = state.tr;
        applyEdits(state, tr, [
          { from: template.from, to: template.from + pair.open.length, text: '' },
          { from: template.to - pair.close.length, to: template.to, text: '' },
        ]);
        tr.setMeta('inlineSourceTemplate', {
          action: 'remove',
          from: template.from,
          to: template.to,
        });
        restoreSelection(state, tr);
        dispatch(tr.scrollIntoView());
      }
      return true;
    }

    if (state.selection.empty) {
      const block = blocks[0];
      const opposite = type === 'superscript' ? 'subscript' : type === 'subscript' ? 'superscript' : null;
      const other = opposite && block.spans.find((span) =>
        span.type === opposite && block.from > span.openFrom && block.from < span.closeTo);
      if (other) {
        if (dispatch) {
          const pair = inlineFormatDelimiters(type, block.source.slice(other.from, other.to));
          const tr = state.tr;
          applyEdits(state, tr, [
            { from: block.start + other.openFrom, to: block.start + other.openTo, text: pair.open },
            { from: block.start + other.closeFrom, to: block.start + other.closeTo, text: pair.close },
          ]);
          restoreSelection(state, tr);
          dispatch(tr.scrollIntoView());
        }
        return true;
      }
      const span = block.spans
        .filter(
          (candidate) =>
            candidate.type === type &&
            block.from > candidate.openFrom &&
            block.from < candidate.closeTo,
        )
        .sort((a, b) => a.closeTo - a.openFrom - (b.closeTo - b.openFrom))[0];
      if (span) {
        if (dispatch) {
          const tr = state.tr;
          applyEdits(state, tr, removeFormatEdits({ ...block, spans: [span] }, type));
          restoreSelection(state, tr);
          dispatch(tr.scrollIntoView());
        }
        return true;
      }
      if (dispatch) {
        const { open, close } = inlineFormatDelimiters(type, '');
        const from = state.selection.from;
        const tr = state.tr;
        const link =
          type === 'code'
            ? state.selection.$from.marks().find((mark) => mark.type.name === 'link')
            : undefined;
        applyEdits(state, tr, [
          {
            from,
            to: from,
            text: open + close,
            marks: link ? codeMarks(state, from, link) : undefined,
          },
        ]);
        markSourceBlocks(tr, blocks);
        const cursor = from + open.length;
        tr.setSelection(TextSelection.create(tr.doc, cursor));
        tr.setMeta('inlineSourceTemplate', {
          action: 'add',
          template: { from, to: from + open.length + close.length, cursor, type },
        });
        dispatch(tr.scrollIntoView());
      }
      return true;
    }

    const remove = blocks.every((block) => isSelectionFormatted(block, type));
    const opposite = type === 'superscript' ? 'subscript' : type === 'subscript' ? 'superscript' : null;
    const edits = blocks.flatMap((block) =>
      remove ? removeFormatEdits(block, type) : [
        ...(opposite ? removeFormatEdits(block, opposite) : []),
        ...applyFormatEdits(block, type),
      ],
    );
    if (!edits.length) return false;
    if (dispatch) {
      const tr = state.tr;
      applyEdits(state, tr, edits);
      markSourceBlocks(tr, blocks);
      restoreSelection(state, tr);
      dispatch(tr.scrollIntoView());
    }
    return true;
  };
}

/** Append to the caller's transaction so clearing source + links/atoms stays one undo step. */
export function appendClearInlineSourceStyles(state: EditorState, tr: Transaction): boolean {
  const blocks = selectedBlocks(state);
  const edits = blocks.flatMap((block) =>
    FORMATS.flatMap((type) =>
      removeFormatEdits(
        type === 'code' ? block : (alignSelectionWithCode(block, type) ?? block),
        type,
      ),
    ),
  );
  for (const template of getEmptyInlineSourceTemplates(state)) {
    const { from, to, empty } = state.selection;
    if (
      (empty && from >= template.from && from <= template.to) ||
      (!empty && from <= template.from && to >= template.to)
    ) {
      edits.push({ from: template.from, to: template.to, text: '' });
    }
  }
  if (!edits.length) return false;
  applyEdits(state, tr, edits);
  return true;
}

function selectedBlocks(state: EditorState): SourceBlock[] {
  const result: SourceBlock[] = [];
  const { from, to } = state.selection;
  const add = (node: PmNode, start: number) => {
    if (!node.isTextblock || node.type.spec.code || node.type.name === 'html_block') return;
    const localFrom = Math.max(0, from - start);
    const localTo = Math.min(node.content.size, to - start);
    if (localFrom > localTo || (!state.selection.empty && localFrom === localTo)) return;
    const analysis = analyzeInlineSource(node);
    result.push({
      node,
      start,
      from: localFrom,
      to: localTo,
      source: analysis.source,
      spans: analysis.spans,
    });
  };
  if (state.selection.empty) {
    const { $from } = state.selection;
    add($from.parent, $from.start());
  } else {
    state.doc.nodesBetween(from, to, (node, pos) => {
      if (node.type.spec.code || node.type.name === 'html_block') return false;
      if (node.isTextblock) {
        add(node, pos + 1);
        return false;
      }
      return true;
    });
  }
  return result;
}

/** 外层格式覆盖完整代码片段；截断字面代码的选区保持不可执行。 */
function alignSelectionWithCode(block: SourceBlock, type: InlineSourceFormat): SourceBlock | null {
  let { from, to } = block;
  for (const span of block.spans.filter((candidate) => candidate.type === 'code')) {
    if (from === to) {
      if (
        from > span.openFrom &&
        from < span.closeTo &&
        !block.spans.some(
          (candidate) =>
            candidate.type === type && from > candidate.openFrom && from < candidate.closeTo,
        )
      )
        return null;
    } else if (from < span.to && to > span.from) {
      const positions = analyzeInlineSource(block.node).visiblePositions.filter(
        (position) => position >= span.from && position < span.to,
      );
      const bodyFrom = positions[0] ?? span.from;
      const bodyTo = /^<code\b/i.test(block.source.slice(span.openFrom, span.openTo))
        ? span.to
        : (positions[positions.length - 1] ?? span.to - 1) + 1;
      if (from > bodyFrom || to < bodyTo) return null;
      from = Math.min(from, span.openFrom);
      to = Math.max(to, span.closeTo);
    }
  }
  return from === block.from && to === block.to ? block : { ...block, from, to };
}

/** 代码正文的粘贴保持字面内容，并在同一事务中重选安全的反引号边界。 */
export function replaceInlineSourceCodeText(state: EditorState, text: string): Transaction | null {
  const { $from, $to } = state.selection;
  if (!$from.sameParent($to)) return null;
  const block = selectedBlocks(state)[0];
  const span = block?.spans.find(
    (candidate) =>
      candidate.type === 'code' && block.from >= candidate.from && block.to <= candidate.to,
  );
  if (!block || !span) return null;
  const tr = state.tr;
  const html = /^<code\b/i.test(block.source.slice(span.openFrom, span.openTo));
  const literal = text.replace(/\r\n?/g, '\n');
  const inserted = html
    ? literal.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    : literal.replace(/\n/g, ' ');
  const raw = block.source.slice(span.from, span.to);
  const padding =
    !html && /^ ([\s\S]+) $/.test(raw.replace(/\n/g, ' ')) && /[^ ]/.test(raw) ? 1 : 0;
  if (padding)
    applyEdits(state, tr, [
      { from: block.start + span.from, to: block.start + span.from + 1, text: '' },
      { from: block.start + span.to - 1, to: block.start + span.to, text: '' },
    ]);
  const from = tr.mapping.map(state.selection.from, 1);
  const to = tr.mapping.map(state.selection.to, -1);
  tr.replaceWith(
    from,
    Math.max(from, to),
    state.schema.text(inserted, codeBodyMarks(block, block.from)),
  );
  tr.setSelection(TextSelection.create(tr.doc, from + inserted.length));
  if (!html) {
    const left = block.source.slice(span.from + padding, Math.max(span.from + padding, block.from));
    const right = block.source.slice(Math.min(span.to - padding, block.to), span.to - padding);
    const pair = inlineFormatDelimiters('code', (left + inserted + right).replace(/\n/g, ' '));
    applyEdits(state, tr, [
      {
        from: block.start + span.openFrom,
        to: block.start + span.openTo,
        text: pair.open,
        marks: codeBodyMarks(block, span.openFrom),
      },
      {
        from: block.start + span.closeFrom,
        to: block.start + span.closeTo,
        text: pair.close,
        marks: codeBodyMarks(block, span.closeFrom),
      },
    ]);
  }
  return tr;
}

function codeBodyMarks(block: SourceBlock, position: number): readonly Mark[] {
  const source = block.node.type.schema.marks.inline_source;
  const marks = (block.node.childAfter(position).node?.marks ?? []).filter(
    (mark) =>
      mark.type.name !== 'inline_source' && !FORMATS.includes(mark.type.name as InlineSourceFormat),
  );
  return source.create().addToSet(marks);
}

/** 按实际可见代码正文释放字符；逐字符编辑保留链接身份及选区映射。 */
function releaseCodeTextEdits(
  block: SourceBlock,
  span: SourceSpan,
  from: number,
  to: number,
): TextEdit[] {
  const analysis = analyzeInlineSource(block.node);
  const units: Array<{ from: number; to: number; text: string }> = [];
  const html = /^<code\b/i.test(block.source.slice(span.openFrom, span.openTo));
  for (let index = 0; index < analysis.visiblePositions.length; index++) {
    const position = analysis.visiblePositions[index];
    if (position < span.from || position >= span.to) continue;
    const previous = units[units.length - 1];
    if (previous?.from === position) previous.text += analysis.visibleText[index];
    else {
      const entity = html
        ? /^&(?:#x[\da-f]+|#\d+|[a-z][a-z\d]+);/i.exec(block.source.slice(position))
        : null;
      units.push({
        from: position,
        to: position + (entity?.[0].length ?? 1),
        text: analysis.visibleText[index],
      });
    }
  }
  const edits: TextEdit[] = [];
  if (!html && units.length) {
    if (units[0].from > span.from)
      edits.push({ from: block.start + span.from, to: block.start + units[0].from, text: '' });
    const end = units[units.length - 1].to;
    if (end < span.to) edits.push({ from: block.start + end, to: block.start + span.to, text: '' });
  }
  const released = units.filter((unit) => unit.from >= from && unit.from < to);
  const literal = released.map((unit) => unit.text).join('');
  let offset = 0;
  for (const unit of released) {
    const child = block.node.childAfter(unit.from).node;
    if (!child?.isText && child?.type.name !== 'hard_break') {
      offset += unit.text.length;
      continue;
    }
    if (unit.text === '\n') {
      edits.push({
        from: block.start + unit.from,
        to: block.start + unit.to,
        text: '',
        node: block.node.type.schema.nodes.hard_break.create({ soft: false }),
      });
      offset += unit.text.length;
      continue;
    }
    // 实体的 & 需要观察后续正文；其它转义只取当前可见字符。
    const escaped =
      unit.text === '&' && /^&(?:#(?:x[\da-f]+|\d+);|[a-z][a-z\d]+;)/i.test(literal.slice(offset))
        ? '\\&'
        : escapeInlineSourceLiteral(unit.text);
    const raw = block.source.slice(unit.from, unit.to);
    if (escaped !== raw) {
      const marks = codeBodyMarks(block, unit.from);
      edits.push({
        from: block.start + unit.from,
        to: block.start + unit.to,
        text: escaped,
        marks,
      });
    }
    offset += unit.text.length;
  }
  return edits;
}

function inStandaloneHtmlBlock(state: EditorState): boolean {
  const { $from, $to } = state.selection;
  return $from.parent === $to.parent && $from.parent.type.name === 'html_block';
}

function hasSelectedCodeText(block: SourceBlock): boolean {
  let found = false;
  block.node.forEach((child, offset) => {
    if (
      (child.isText || child.type.name === 'hard_break') &&
      offset < block.to &&
      offset + child.nodeSize > block.from
    )
      found = true;
  });
  return found;
}

function isSelectionFormatted(block: SourceBlock, type: InlineSourceFormat): boolean {
  const formats = block.spans.filter((span) => span.type === type);
  let hasContent = false;
  for (let pos = block.from; pos < block.to; pos += 1) {
    const child = type === 'code' ? block.node.childAfter(pos).node : null;
    if (child && !child.isText && child.type.name !== 'hard_break') continue;
    if (
      block.spans.some(
        (span) =>
          (pos >= span.openFrom && pos < span.openTo) ||
          (pos >= span.closeFrom && pos < span.closeTo),
      )
    )
      continue;
    hasContent = true;
    if (!formats.some((span) => pos >= span.from && pos < span.to)) return false;
  }
  return hasContent;
}

function delimiterRemoval(start: number, span: SourceSpan): TextEdit[] {
  return [
    { from: start + span.openFrom, to: start + span.openTo, text: '' },
    { from: start + span.closeFrom, to: start + span.closeTo, text: '' },
  ];
}

function removeFormatEdits(block: SourceBlock, type: InlineSourceFormat): TextEdit[] {
  const edits: TextEdit[] = [];
  const cursor = block.from === block.to;
  for (const span of block.spans.filter((candidate) => candidate.type === type)) {
    if (
      cursor
        ? !(block.from >= span.openFrom && block.from <= span.closeTo)
        : !(block.from < span.closeTo && block.to > span.openFrom)
    )
      continue;
    edits.push(...delimiterRemoval(block.start, span));
    if (type === 'code') {
      edits.push(
        ...releaseCodeTextEdits(
          block,
          span,
          cursor ? span.from : block.from,
          cursor ? span.to : block.to,
        ),
      );
    }
    if (cursor) continue;
    const leftTo = Math.min(block.from, span.to);
    const rightFrom = Math.max(block.to, span.from);
    // Split only the selected format. HTML boundaries avoid ambiguous adjacent * runs.
    if (leftTo > span.from) {
      edits.push(...wrapEdits(block, type, span.from, leftTo, true, [], type === 'code'));
    }
    if (rightFrom < span.to) {
      edits.push(...wrapEdits(block, type, rightFrom, span.to, true, [], type === 'code'));
    }
  }
  return edits;
}

function applyFormatEdits(block: SourceBlock, type: InlineSourceFormat): TextEdit[] {
  let from = block.from;
  let to = block.to;
  const edits: TextEdit[] = [];
  // Merge intersecting same-format spans rather than nesting identical delimiters.
  const spans = block.spans.filter((span) => span.type === type);
  const merged = new Set<SourceSpan>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const span of spans) {
      if (merged.has(span) || span.openFrom >= to || span.closeTo <= from) continue;
      merged.add(span);
      from = Math.min(from, span.openFrom);
      to = Math.max(to, span.closeTo);
      edits.push(...delimiterRemoval(block.start, span));
      changed = true;
    }
  }
  return [...edits, ...wrapEdits(block, type, from, to, merged.size > 0, [...merged])];
}

function wrapEdits(
  block: SourceBlock,
  type: InlineSourceFormat,
  from: number,
  to: number,
  preferHtml = false,
  removedSpans: SourceSpan[] = [],
  preserveCodeBody = false,
): TextEdit[] {
  if (type === 'code') return wrapCodeEdits(block, from, to, removedSpans, preserveCodeBody);
  let { open, close } = inlineFormatDelimiters(type, block.source.slice(from, to));
  if (type === 'strong' || type === 'em' || type === 'strikethrough' || type === 'superscript' || type === 'subscript') {
    const candidate =
      block.source.slice(0, from) +
      open +
      block.source.slice(from, to) +
      close +
      block.source.slice(to);
    const valid =
      !preferHtml &&
      analyzeInlineSourceText(candidate).spans.some(
        (span) =>
          span.type === type &&
          span.openFrom === from &&
          span.openTo === from + open.length &&
          span.closeFrom === to + open.length,
      );
    if (!valid) {
      const tag = type === 'superscript' ? 'sup' : type === 'subscript' ? 'sub' : type === 'strong' ? 'strong' : type === 'em' ? 'em' : 'del';
      open = `<${tag}>`;
      close = `</${tag}>`;
    }
  }
  return [
    { from: block.start + from, to: block.start + from, text: open, order: 1 },
    { from: block.start + to, to: block.start + to, text: close, order: 0 },
  ];
}

type CodeSegment = {
  from: number;
  to: number;
  link?: Mark;
  parts: Array<{ from: number; to: number }>;
};

/** Markdown code cannot enclose a structured link/atom: keep each link identity and skip atoms. */
function wrapCodeEdits(
  block: SourceBlock,
  from: number,
  to: number,
  removedSpans: SourceSpan[],
  preserveCodeBody = false,
): TextEdit[] {
  const removed = removedSpans
    .flatMap((span) => [
      { from: span.openFrom, to: span.openTo },
      { from: span.closeFrom, to: span.closeTo },
    ])
    .sort((a, b) => a.from - b.from);
  const segments: CodeSegment[] = [];
  let interrupted = false;
  block.node.forEach((child, offset) => {
    const start = Math.max(from, offset);
    const end = Math.min(to, offset + child.nodeSize);
    if (start >= end) return;
    if (!child.isText && child.type.name !== 'hard_break') {
      interrupted = true;
      return;
    }
    const link = child.marks.find((mark) => mark.type.name === 'link');
    const parts: Array<{ from: number; to: number }> = [];
    let cursor = start;
    for (const range of removed) {
      if (range.to <= cursor || range.from >= end) continue;
      if (range.from > cursor) parts.push({ from: cursor, to: Math.min(range.from, end) });
      cursor = Math.max(cursor, range.to);
    }
    if (cursor < end) parts.push({ from: cursor, to: end });
    if (!parts.length) return;
    const previous = segments[segments.length - 1];
    const sameLink =
      (!previous?.link && !link) || Boolean(previous?.link && link && previous.link.eq(link));
    if (previous && !interrupted && sameLink) {
      previous.to = parts[parts.length - 1].to;
      previous.parts.push(...parts);
    } else {
      segments.push({ from: parts[0].from, to: parts[parts.length - 1].to, link, parts });
    }
    interrupted = false;
  });
  const edits: TextEdit[] = [];
  const sourceMark = block.node.type.schema.marks.inline_source.create();
  for (const segment of segments) {
    const inheritedHtml = block.spans.some(
      (span) =>
        span.type === 'code' &&
        span.from <= segment.from &&
        span.to >= segment.to &&
        /^<code\b/i.test(block.source.slice(span.openFrom, span.openTo)),
    );
    const analysis = preserveCodeBody ? analyzeInlineSource(block.node) : null;
    const text = analysis
      ? [...analysis.visiblePositions.entries()]
          .filter(([, position]) =>
            segment.parts.some((part) => position >= part.from && position < part.to),
          )
          .map(([index]) => analysis.visibleText[index])
          .join('')
      : segment.parts.map((part) => block.source.slice(part.from, part.to)).join('');
    if (preserveCodeBody && !text) continue;
    const pair = inheritedHtml
      ? { open: '<code>', close: '</code>' }
      : inlineFormatDelimiters('code', text);
    const marks = segment.link ? segment.link.addToSet([sourceMark]) : [sourceMark];
    edits.push({
      from: block.start + segment.from,
      to: block.start + segment.from,
      text: pair.open,
      // 同一端点的外层格式必须位于代码外，避免局部清除时标签落入代码正文。
      order: 2,
      marks,
    });
    edits.push({
      from: block.start + segment.to,
      to: block.start + segment.to,
      text: pair.close,
      order: -1,
      marks,
    });
  }
  return edits;
}

function codeMarks(state: EditorState, pos: number, link: Mark): readonly Mark[] {
  return link.addToSet(sourceMarksAt(state, pos));
}

function sourceMarksAt(state: EditorState, pos: number): readonly Mark[] {
  // A delimiter crossing a link boundary must serialize outside the link label;
  // otherwise `[a**b](url)c**` cannot round-trip as emphasis in Markdown.
  let marks: readonly Mark[] = state.doc
    .resolve(pos)
    .marks()
    .filter(
      (mark) =>
        mark.type.name !== 'link' && !FORMATS.includes(mark.type.name as InlineSourceFormat),
    );
  const source = state.schema.marks.inline_source;
  if (source) marks = source.create().addToSet(marks);
  return marks;
}

function applyEdits(state: EditorState, tr: Transaction, input: TextEdit[]): void {
  const unique = new Map<string, TextEdit>();
  for (const edit of input)
    unique.set(
      `${edit.from}:${edit.to}:${edit.text}:${edit.node ? JSON.stringify(edit.node.toJSON()) : ''}:${edit.order ?? 0}:${edit.marks?.map((mark) => JSON.stringify(mark.toJSON())).join(',') ?? ''}`,
      edit,
    );
  const edits = [...unique.values()];
  // 原子替换保留正文光标映射；纯删除先完成，再处理共享定界符端点的插入。
  for (const edit of edits.filter((edit) => edit.to > edit.from).sort((a, b) => b.from - a.from)) {
    const from = tr.mapping.map(edit.from, 1);
    const to = tr.mapping.map(edit.to, -1);
    if (to <= from) continue;
    if (edit.node) tr.replaceWith(from, to, edit.node);
    else if (edit.text)
      tr.replaceWith(
        from,
        to,
        state.schema.text(edit.text, edit.marks ?? sourceMarksAt(state, edit.from)),
      );
    else tr.delete(from, to);
  }
  const insertionMapping = tr.mapping.slice();
  for (const edit of edits
    .filter((edit) => edit.text && edit.from === edit.to)
    .sort((a, b) => b.from - a.from || (b.order ?? 0) - (a.order ?? 0))) {
    const position = insertionMapping.map(edit.from, 1);
    tr.insert(
      position,
      state.schema.text(edit.text, edit.marks ?? sourceMarksAt(state, edit.from)),
    );
  }
}

function markSourceBlocks(tr: Transaction, blocks: SourceBlock[]): void {
  const source = tr.doc.type.schema.marks.inline_source;
  if (!source) return;
  for (const block of blocks) {
    const from = tr.mapping.map(block.start, -1);
    const to = tr.mapping.map(block.start + block.node.content.size, 1);
    const ranges: Array<{ from: number; to: number }> = [];
    tr.doc.nodesBetween(from, to, (node, pos) => {
      if (node.isText && !source.isInSet(node.marks))
        ranges.push({ from: pos, to: pos + node.nodeSize });
    });
    for (const range of ranges) tr.addMark(range.from, range.to, source.create());
  }
}

function restoreSelection(state: EditorState, tr: Transaction): void {
  const { anchor, head } = state.selection;
  const mappedAnchor = tr.mapping.map(anchor, anchor <= head ? 1 : -1);
  const mappedHead = tr.mapping.map(head, anchor <= head ? -1 : 1);
  tr.setSelection(
    TextSelection.create(tr.doc, mappedAnchor, state.selection.empty ? mappedAnchor : mappedHead),
  );
}
