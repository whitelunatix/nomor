import { describe, expect, it } from 'vitest';
import { ApprovalBroker } from '../approval';
import { createAssistantTools } from './index';

const document = {
  getEditor: () => null,
  isDocxMode: () => false,
  approval: new ApprovalBroker(),
};

describe('createAssistantTools', () => {
  it('没有文档时返回空工具表', () => {
    expect(
      Object.keys(createAssistantTools({ document: null, includeDocumentWrites: true })),
    ).toEqual([]);
  });

  it('默认包含只读工具与写入工具', () => {
    const tools = createAssistantTools({ document, includeDocumentWrites: true });
    expect(Object.keys(tools).sort()).toEqual([
      'doc_apply_edit',
      'doc_diagnostics',
      'doc_outline',
      'doc_read',
      'doc_search',
      'doc_selection',
    ]);
  });

  it('关闭写入后模型看不到 doc_apply_edit', () => {
    const tools = createAssistantTools({ document, includeDocumentWrites: false });
    expect(tools.doc_apply_edit).toBeUndefined();
    expect(tools.doc_read).toBeDefined();
  });

  it('有工作区时提供只读文件工具', () => {
    const tools = createAssistantTools({
      document: null,
      includeDocumentWrites: false,
      files: { getDocumentPath: () => 'C:\\docs\\main.md', approval: new ApprovalBroker() },
    });
    expect(Object.keys(tools).sort()).toEqual(['file_list', 'file_read']);
  });

  it('文件写入默认关闭，显式开启后才出现 file_write', () => {
    const files = { getDocumentPath: () => 'C:\\docs\\main.md', approval: new ApprovalBroker() };
    const off = createAssistantTools({
      document: null,
      includeDocumentWrites: false,
      files,
    });
    const on = createAssistantTools({
      document: null,
      includeDocumentWrites: false,
      files,
      includeFileWrites: true,
    });
    expect(off.file_write).toBeUndefined();
    expect(on.file_write).toBeDefined();
  });
});
