import type { ModelMessage } from 'ai';

/** 只支持两类协议：OpenAI 兼容（/chat/completions）与 Anthropic 原生（/messages）。 */
export type AssistantProviderKind = 'openai-compatible' | 'anthropic';

/**
 * 请求鉴权方式。真正的密钥保存在系统凭据管理器里，由 Rust 在发请求时注入；
 * 这里只描述「往哪个请求头里放」。
 */
export type AssistantAuthStyle = 'bearer' | 'xApiKey' | 'none';

export interface AssistantProviderConfig {
  /** 同时作为凭据管理器里的账号名，必须是 ASCII 字母数字/-/_。 */
  id: string;
  name: string;
  kind: AssistantProviderKind;
  /** 例如 `https://api.deepseek.com/v1`；具体路径由 AI SDK 拼接。 */
  baseUrl: string;
  /** 默认模型 id。 */
  model: string;
  /** 额外请求头；不要在这里放密钥。 */
  headers?: Record<string, string>;
}

export interface AssistantPreferences {
  providers: AssistantProviderConfig[];
  activeProviderId: string;
  /** 允许模型执行 shell 命令；默认开启，每次执行仍需确认。 */
  shellEnabled: boolean;
  /** 允许模型直接改文档；关闭后写文档工具从工具表中移除。 */
  documentWriteEnabled: boolean;
  /** 允许模型写入工作区文件；默认关闭，每次写入仍需确认。 */
  fileWriteEnabled: boolean;
  /** 长对话自动摘要；默认开启，失败不会阻断本轮。 */
  autoCompactionEnabled: boolean;
  /** Skills 根目录；空字符串表示使用默认的 `~/.skills-manager/skills`。 */
  skillsRoot: string;
}

/** MCP 服务器宣告的一个工具；`inputSchema` 是原样的 JSON Schema。 */
export interface McpToolInfo {
  name: string;
  title?: string | null;
  description: string;
  inputSchema: unknown;
  /** 服务器声明的 `readOnlyHint`，只作为审批策略的参考。 */
  readOnly: boolean;
}

export interface McpServerTools {
  serverId: string;
  trusted: boolean;
  tools: McpToolInfo[];
}

export interface McpServerStatus {
  id: string;
  transport: 'stdio' | 'http' | 'invalid';
  command?: string | null;
  url?: string | null;
  disabled: boolean;
  trusted: boolean;
  connected: boolean;
  toolCount: number;
  error?: string | null;
}

export interface McpConfigView {
  path: string;
  text: string;
  /** 配置解析失败时的原因；此时 `servers` 为空。 */
  parseError?: string | null;
  servers: McpServerStatus[];
}

export interface McpHealthResult {
  id: string;
  connected: boolean;
  toolCount: number;
  error?: string | null;
}

/** 一个可导入的本地 MCP 配置来源（Claude Desktop / Cursor / 工作区）。 */
export interface McpImportSource {
  kind: 'claude' | 'cursor' | 'workspace' | string;
  label: string;
  path: string;
  exists: boolean;
  servers: string[];
  error?: string | null;
}

export interface McpImportResult {
  imported: string[];
  skipped: string[];
  conflicts: string[];
  invalid: string[];
  config: McpConfigView;
}

/** 技能目录里一个 `SKILL.md` 的元数据。 */
export interface SkillInfo {
  /** 目录名，也是 `skill_load` 的参数。 */
  id: string;
  name: string;
  description: string;
  /** `SKILL.md` 的绝对路径，仅用于展示。 */
  path: string;
}

export interface SkillContent extends SkillInfo {
  /** 去掉 frontmatter 后的正文。 */
  content: string;
  truncated: boolean;
  /** `references/`、`scripts/` 下可继续读取的文件（相对路径）。 */
  files: string[];
}

export interface SkillFileInfo {
  path: string;
  bytes: number;
}

export interface SkillFileContent {
  path: string;
  bytes: number;
  truncated: boolean;
  content: string;
}

/** `shell_exec` 的返回结构，与 Rust 的 `ShellOutput` 对齐。 */
export interface ShellResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

export type AssistantToolStatus = 'pending-approval' | 'running' | 'success' | 'error' | 'denied';

export interface AssistantToolInvocation {
  /** SDK 的 toolCallId，用于把流式事件对回同一条工具记录。 */
  id: string;
  name: string;
  /** 给用户看的短标题，例如「读取大纲」。 */
  title: string;
  status: AssistantToolStatus;
  input?: unknown;
  output?: string;
  error?: string;
  /** 毫秒时间戳；用于在工具卡片上显示耗时。 */
  startedAt?: number;
  finishedAt?: number;
}

export type AssistantMessageRole = 'user' | 'assistant';

export interface AssistantMessage {
  id: string;
  role: AssistantMessageRole;
  content: string;
  reasoning?: string;
  createdAt: number;
  toolCalls?: AssistantToolInvocation[];
  /** 出错或中止时展示的说明。 */
  error?: string;
  stopped?: boolean;
}

/** JSONL 里的一行：消息记录。 */
export interface AssistantSessionRecord extends AssistantMessage {
  type: 'message';
}

export interface AssistantSessionMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface AssistantSessionSummary extends AssistantSessionMeta {
  messageCount: number;
}

/** 一次对话轮次里模型产生的用量，用于页脚展示。 */
export interface AssistantUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

/** 传给 `runAssistantTurn` 的会话状态；返回后由调用方写回。 */
export interface AssistantTurnResult {
  /** 本轮新增的模型消息（用户输入 + 助手回复 + 工具结果）。 */
  messages: ModelMessage[];
  text: string;
  usage: AssistantUsage;
  aborted: boolean;
}
