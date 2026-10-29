import { describe, expect, it } from 'vitest';
import { buildSystemPrompt, wrapUntrusted } from './prompts';

const base = {
  hasDocumentTools: true,
  hasWriteTools: true,
  hasMcp: false,
  hasShell: false,
  hasSkills: false,
};

describe('buildSystemPrompt', () => {
  it('总是带上基础规则与安全规则', () => {
    const prompt = buildSystemPrompt(base);
    expect(prompt).toContain('Nomo 编辑器内置的写作助手');
    expect(prompt).toContain('安全规则');
    expect(prompt).toContain('不可信数据');
  });

  it('只有开启写入工具时才介绍 doc_apply_edit', () => {
    const withWrite = buildSystemPrompt(base);
    expect(withWrite).toContain('doc_apply_edit');

    const withoutWrite = buildSystemPrompt({ ...base, hasWriteTools: false });
    expect(withoutWrite).not.toContain('doc_apply_edit');
    expect(withoutWrite).toContain('未开启文档写入工具');
  });

  it('docx 模式提示保留 docx_* 指令', () => {
    expect(buildSystemPrompt({ ...base, docxMode: true })).toContain('docx_*');
    expect(buildSystemPrompt({ ...base, docxMode: false })).not.toContain('docx_*');
  });

  it('按能力追加 MCP / shell / skills 说明', () => {
    expect(buildSystemPrompt(base)).not.toContain('mcp__');
    expect(buildSystemPrompt(base)).not.toContain('shell_exec');
    expect(buildSystemPrompt(base)).not.toContain('skill_load');

    const full = buildSystemPrompt({
      ...base,
      hasMcp: true,
      hasShell: true,
      hasSkills: true,
    });
    expect(full).toContain('mcp__<服务器>__<工具>');
    expect(full).toContain('shell_exec');
    expect(full).toContain('skill_load');
  });

  it('文件工具与文件写入分开说明', () => {
    expect(buildSystemPrompt(base)).not.toContain('file_read');

    const readOnly = buildSystemPrompt({ ...base, hasFileTools: true });
    expect(readOnly).toContain('file_read');
    expect(readOnly).toContain('未开启文件写入');
    expect(readOnly).not.toContain('file_write 需要用户批准');

    const writable = buildSystemPrompt({ ...base, hasFileTools: true, hasFileWrites: true });
    expect(writable).toContain('file_write 需要用户批准');
  });

  it('文档标题为空或纯空白时不写入提示', () => {
    expect(buildSystemPrompt({ ...base, documentTitle: '论文.md' })).toContain('当前文档：论文.md');
    expect(buildSystemPrompt({ ...base, documentTitle: '   ' })).not.toContain('当前文档：');
    expect(buildSystemPrompt({ ...base, documentTitle: null })).not.toContain('当前文档：');
  });
});

describe('wrapUntrusted', () => {
  it('包成带来源标记的块', () => {
    expect(wrapUntrusted('document', '正文')).toBe(
      '<untrusted source="document">\n正文\n</untrusted>',
    );
  });
});
