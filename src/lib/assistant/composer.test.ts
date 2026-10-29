import { describe, expect, it } from 'vitest';
import { expandComposerInput } from './composer';

const context = {
  documentTitle: '第三章',
  documentPath: 'C:\\docs\\thesis.md',
  selection: '被选中的一句话。',
};

describe('expandComposerInput', () => {
  it('普通消息原样返回', () => {
    expect(expandComposerInput('  帮我看看结论  ', context)).toBe('帮我看看结论');
  });

  it('展开中文与英文的文档引用，并提示先读大纲', () => {
    const result = expandComposerInput('@文档 总结一下 @doc', context);

    expect(result).toContain('[引用当前文档]');
    expect(result).toContain('标题：第三章');
    expect(result).toContain('路径：C:\\docs\\thesis.md');
    expect(result).toContain('doc_outline');
    expect(result).toContain('总结一下');
    expect(result).not.toContain('@文档');
    expect(result).not.toContain('@doc');
  });

  it('文档未保存时明确说明，而不是伪造路径', () => {
    const result = expandComposerInput('@document 看下', {
      ...context,
      documentTitle: null,
      documentPath: null,
    });

    expect(result).toContain('标题：（未命名）');
    expect(result).toContain('（尚未保存到磁盘）');
  });

  it('选区作为不可信内容注入，避免被当成指令', () => {
    const result = expandComposerInput('@选区 改短一点', context);

    expect(result).toContain('[引用当前选区]');
    expect(result).toContain('<untrusted source="selection">');
    expect(result).toContain('被选中的一句话。');
    expect(result).toContain('改短一点');
    expect(result).not.toContain('@选区');
  });

  it('没有选区时给出可读说明', () => {
    const result = expandComposerInput('@selection 解释', {
      ...context,
      selection: null,
    });

    expect(result).toContain('（当前没有选中文本）');
    expect(result).toContain('解释');
  });

  it('同时展开文档与选区引用', () => {
    const result = expandComposerInput('@文件 对比 @选取 和全文', {
      documentTitle: '论文',
      documentPath: null,
      selection: '片段',
    });

    expect(result).toContain('[引用当前文档]');
    expect(result).toContain('[引用当前选区]');
    expect(result).toContain('对比');
    expect(result).toContain('和全文');
  });
});
