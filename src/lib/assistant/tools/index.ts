import type { ToolSet } from 'ai';
import { createDocumentTools, type DocumentToolContext } from './doc';
import { createFileTools, type FileToolContext } from './files';
import { createMcpTools, type McpToolContext } from './mcp';
import { createShellTools, type ShellToolContext } from './shell';
import { createSkillsTools } from './skills';

export interface AssistantToolOptions {
  document: DocumentToolContext | null;
  /** 关闭后写文档工具不会出现在工具表里，模型也就无从调用。 */
  includeDocumentWrites: boolean;
  /** 已连接服务器的工具；为空或省略时不注入 MCP 工具。 */
  mcp?: McpToolContext | null;
  /** 关闭后 shell_exec 不会出现；每次执行仍需原生确认。 */
  shell?: ShellToolContext | null;
  /** 技能目录非空时注入 skill_list / skill_load。 */
  skills?: boolean;
  /** 当前文档已保存时注入 file_list / file_read；写入另受 includeFileWrites 控制。 */
  files?: FileToolContext | null;
  /** 文件写入默认关闭；关闭时 file_write 不出现在工具表里。 */
  includeFileWrites?: boolean;
}

const WRITE_TOOLS = new Set(['doc_apply_edit', 'file_write']);

/**
 * 组装本轮可用的工具。后续 MCP、shell、skills 都从这里并入，
 * 上层（面板 / agent）不需要知道具体有哪些工具。
 */
export function createAssistantTools(options: AssistantToolOptions): ToolSet {
  const tools: ToolSet = {};

  if (options.document) {
    const documentTools = createDocumentTools(options.document);
    for (const [name, definition] of Object.entries(documentTools)) {
      if (!options.includeDocumentWrites && WRITE_TOOLS.has(name)) {
        continue;
      }
      tools[name] = definition;
    }
  }

  if (options.mcp && options.mcp.servers.length > 0) {
    const mcpTools = createMcpTools(options.mcp);
    for (const [name, definition] of Object.entries(mcpTools)) {
      tools[name] = definition;
    }
  }

  if (options.shell) {
    Object.assign(tools, createShellTools(options.shell));
  }

  if (options.skills) {
    Object.assign(tools, createSkillsTools());
  }

  if (options.files) {
    const fileTools = createFileTools(options.files);
    for (const [name, definition] of Object.entries(fileTools)) {
      if (!options.includeFileWrites && WRITE_TOOLS.has(name)) {
        continue;
      }
      tools[name] = definition;
    }
  }

  return tools;
}

export type {
  DocumentToolContext,
  FileToolContext,
  McpToolContext,
  ShellToolContext,
};
