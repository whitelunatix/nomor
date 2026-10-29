import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseMarkdown, serializeMarkdown } from '../editor-core/markdown';
import { Selection } from 'prosemirror-state';
import { buildDocxContext } from './inspector';
import { buildDocxDecorations, collectDocxGlobals } from './presentation';
import { validateDocxMarkdown } from './validate';

/**
 * 性能基线：默认读取仓库内的全功能样例，也可以用 `DOCXMD_PERF_FILE`
 * 指向一份真实 `.docx.md` 做额外测量。
 */
const perfFile =
  process.env.DOCXMD_PERF_FILE ?? resolve(__dirname, '__fixtures__/all_features.docx.md');
const source = readFileSync(perfFile, 'utf8');

function measure(label: string, run: () => void, times = 3): number {
  run();
  const start = performance.now();
  for (let index = 0; index < times; index += 1) run();
  const elapsed = (performance.now() - start) / times;
  console.log(`[docxmd perf] ${label}: ${elapsed.toFixed(1)} ms`);
  return elapsed;
}

describe('docxmd real-document performance', () => {
  it('reports parse, decoration, validation and context timings', { timeout: 120_000 }, () => {
    let doc = parseMarkdown(source, { docx: true });
    measure('parseMarkdown(docx)', () => {
      doc = parseMarkdown(source, { docx: true });
    });
    measure('serializeMarkdown', () => {
      serializeMarkdown(doc);
    });
    measure('collectDocxGlobals', () => {
      collectDocxGlobals(doc);
    });
    measure('buildDocxDecorations', () => {
      buildDocxDecorations(doc);
    }, 5);
    measure('validateDocxMarkdown', () => {
      validateDocxMarkdown(source);
    }, 3);
    const head = (() => {
      const selection = Selection.atStart(doc);
      return selection.$head;
    })();
    measure('buildDocxContext', () => {
      buildDocxContext(doc, head, true, { revision: 1, directivesVisible: false });
    }, 5);

    // 段落后处理的快路径必须与逐行修正得到同样的文本，否则保存会丢转义。
    const serialized = serializeMarkdown(doc);
    const roundTrip = serializeMarkdown(parseMarkdown(serialized, { docx: true }));
    console.log(
      `[docxmd perf] round-trip identical: ${serialized === source}, idempotent: ${roundTrip === serialized}`,
    );
    expect(roundTrip).toBe(serialized);
    expect(doc.childCount).toBeGreaterThan(0);
  });
});
