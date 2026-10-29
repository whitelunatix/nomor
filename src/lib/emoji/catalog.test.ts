import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { buildEmojiCatalog, findEmojiQuery, searchEmoji } from './catalog';
import { SourceEmojiContext } from './sourceContext';
import { fixture } from './catalog.fixture';

describe('emoji search and trigger', () => {
  const catalog = buildEmojiCatalog(fixture);
  it('searches Chinese and English names, tags and shortcode aliases with categories', () => {
    expect(searchEmoji(catalog, '开心')[0].unicode).toBe('😄');
    expect(searchEmoji(catalog, ':SMILE:')[0].unicode).toBe('😄');
    expect(searchEmoji(catalog, 'red heart')[0].unicode).toBe('❤️');
    expect(searchEmoji(catalog, '宠物', 3)[0].unicode).toBe('🐱');
    expect(searchEmoji(catalog, 'cat', 0)).toEqual([]);
    expect(searchEmoji(catalog, '', undefined, 2)).toHaveLength(2);
    expect(searchEmoji(catalog, 'not found')).toEqual([]);
  });
  it.each([':smi', 'hello :开心', '（:cat', ':smile:'])('recognizes %s', (value) => {
    const query = findEmojiQuery(value, value.length);
    expect(query).not.toBeNull();
    expect(value.slice(query!.from, query!.to)).toMatch(/^:/);
  });
  it.each([':', '12:30', 'https://host', 'C:\\path', 'word:smile', '::smile', '：smile'])(
    'ignores %s',
    (value) => {
      expect(findEmojiQuery(value, value.length)).toBeNull();
    },
  );
});

describe('incremental source context', () => {
  it.each([
    '```js\n:smi\n```',
    '- ```js\n  :smi\n  ```',
    '~~~\n:smi\n~~~',
    '$$\n:smi\n$$',
    '` :smi`',
    '`line\n:smi`',
    '$x :smi$',
    '[label](:smi)',
    '<a href=":smi">',
    '    :smi',
  ])('excludes literals in %s', (value) => {
    const state = EditorState.create({ doc: value });
    expect(new SourceEmojiContext().allows(state.doc, value.indexOf(':smi') + 4)).toBe(false);
  });
  it('maps fence positions and rescans changed lines after insertion, deletion and undo', () => {
    let state = EditorState.create({ doc: '```\n:smi\n```\n:smi' });
    const context = new SourceEmojiContext();
    expect(context.allows(state.doc, state.doc.length)).toBe(true);
    const change = (from: number, to: number, insert: string) => {
      const tr = state.update({ changes: { from, to, insert } });
      context.update(state.doc, tr.state.doc, tr.changes);
      state = tr.state;
    };
    change(9, 12, '');
    expect(context.allows(state.doc, state.doc.length)).toBe(false);
    change(9, 9, '```');
    expect(context.allows(state.doc, state.doc.length)).toBe(true);
    change(0, 0, 'intro\n');
    expect(context.allows(state.doc, state.doc.length)).toBe(true);
    change(0, state.doc.length, ':开心');
    expect(context.allows(state.doc, state.doc.length)).toBe(true);
  });
  it('resets inline literal context at paragraph and fenced-block boundaries', () => {
    for (const value of ['`literal\n\n:smi', '~~~js\n`literal\n~~~\n:smi']) {
      const state = EditorState.create({ doc: value });
      expect(new SourceEmojiContext().allows(state.doc, state.doc.length)).toBe(true);
    }
  });
  it('recovers after replacing a document that exceeded the context budget', () => {
    const state = EditorState.create({ doc: '```\n```\n'.repeat(2100) + ':smi' });
    const context = new SourceEmojiContext();
    expect(context.allows(state.doc, state.doc.length)).toBe(false);
    const changed = state.update({ changes: { from: 0, to: state.doc.length, insert: ':smi' } });
    context.update(state.doc, changed.state.doc, changed.changes);
    expect(context.allows(changed.state.doc, changed.state.doc.length)).toBe(true);
  });
});
