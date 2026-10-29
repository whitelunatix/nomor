import { jsonSchema, tool, type JSONSchema7, type ToolSet } from 'ai';
import { t } from '../../../app/i18n';
import type { ApprovalBroker } from '../approval';
import { formatToolOutput, truncateText } from '../context';
import { callMcpTool, mcpToolName } from '../mcp';
import type { McpServerTools, McpToolInfo } from '../types';

/**
 * 把 MCP 服务器宣告的工具包装成 AI SDK 工具。
 *
 * 审批策略：只有 `mcp.json` 里显式信任（且配置指纹未变）的服务器上、
 * 由工具自己声明 `readOnlyHint` 的调用才自动放行；其余一律先问用户。
 * 拒绝时返回结构化结果，让模型继续而不是中断整轮对话。
 */

export interface McpToolContext {
  servers: McpServerTools[];
  approval: ApprovalBroker;
}

const MAX_DESCRIPTION_LENGTH = 2000;
const MAX_TOOL_NAME_LENGTH = 64;

function approvalId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `mcp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 第三方 schema 可能是任意 JSON；不是对象时退回空对象，避免整个工具表构造失败。 */
function asSchema(info: McpToolInfo): JSONSchema7 {
  const schema = info.inputSchema;
  if (schema && typeof schema === 'object' && !Array.isArray(schema)) {
    return schema as JSONSchema7;
  }
  return { type: 'object', properties: {} };
}

function describeInput(input: unknown): string {
  try {
    return truncateText(JSON.stringify(input ?? {}, null, 2), 4000);
  } catch {
    return String(input);
  }
}

function uniqueToolName(used: Set<string>, base: string): string {
  let name = base;
  let index = 2;
  while (used.has(name)) {
    const suffix = `_${index}`;
    name = `${base.slice(0, MAX_TOOL_NAME_LENGTH - suffix.length)}${suffix}`;
    index += 1;
  }
  used.add(name);
  return name;
}

export function createMcpTools(context: McpToolContext): ToolSet {
  const tools: ToolSet = {};
  const used = new Set<string>();

  for (const server of context.servers) {
    // 信任只有一个来源：mcp.json 里的 trusted + 指纹校验结果（见 Rust 侧）。
    const serverTrusted = server.trusted;
    for (const info of server.tools) {
      const name = uniqueToolName(used, mcpToolName(server.serverId, info.name));
      const label = `${server.serverId} / ${info.name}`;
      const description = truncateText(
        `[MCP ${label}] ${info.description || info.name}${
          info.readOnly ? '' : `\n${t.aiMcpWriteHint()}`
        }`,
        MAX_DESCRIPTION_LENGTH,
      );

      tools[name] = tool({
        description,
        inputSchema: jsonSchema<Record<string, unknown>>(asSchema(info)),
        execute: async (input, { abortSignal, toolCallId }) => {
          if (!(serverTrusted && info.readOnly)) {
            const decision = await context.approval.request(
              {
                id: approvalId(),
                toolName: name,
                toolCallId,
                title: t.aiMcpApprovalTitle({ name: label }),
                detail: describeInput(input),
                input,
              },
              abortSignal,
            );
            if (decision !== 'approve') {
              return { denied: true, reason: t.aiDeniedTool() };
            }
          }
          const result = await callMcpTool(
            server.serverId,
            info.name,
            (input ?? {}) as Record<string, unknown>,
            toolCallId,
            abortSignal,
          );
          return formatToolOutput(result);
        },
      });
    }
  }

  return tools;
}
