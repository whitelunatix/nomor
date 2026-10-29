// 常用语言列表（含别名，用于语言选择器）
export const CODE_LANGUAGES: Array<{ label: string; value: string; aliases: string[] }> = [
  { label: 'Plain Text', value: 'text', aliases: ['plaintext', 'txt'] },
  { label: 'JavaScript', value: 'javascript', aliases: ['js'] },
  { label: 'TypeScript', value: 'typescript', aliases: ['ts'] },
  { label: 'HTML', value: 'html', aliases: [] },
  { label: 'CSS', value: 'css', aliases: [] },
  { label: 'JSON', value: 'json', aliases: [] },
  { label: 'Markdown', value: 'markdown', aliases: ['md'] },
  { label: 'Python', value: 'python', aliases: ['py'] },
  { label: 'Java', value: 'java', aliases: [] },
  { label: 'Shell', value: 'shell', aliases: ['sh', 'bash'] },
  { label: 'SQL', value: 'sql', aliases: [] },
  { label: 'YAML', value: 'yaml', aliases: ['yml'] },
  { label: 'Diff', value: 'diff', aliases: [] },
  { label: 'Mermaid', value: 'mermaid', aliases: [] },
  { label: 'XML', value: 'xml', aliases: [] },
  { label: 'C', value: 'c', aliases: [] },
  { label: 'C++', value: 'cpp', aliases: ['c++'] },
  { label: 'C#', value: 'csharp', aliases: ['cs', 'c#'] },
  { label: 'Go', value: 'go', aliases: ['golang'] },
  { label: 'Rust', value: 'rust', aliases: ['rs'] },
  { label: 'Ruby', value: 'ruby', aliases: ['rb'] },
  { label: 'PHP', value: 'php', aliases: [] },
  { label: 'Swift', value: 'swift', aliases: [] },
  { label: 'Kotlin', value: 'kotlin', aliases: ['kt'] },
  { label: 'Dart', value: 'dart', aliases: [] },
  { label: 'Lua', value: 'lua', aliases: [] },
  { label: 'R', value: 'r', aliases: [] },
  { label: 'Scala', value: 'scala', aliases: [] },
  { label: 'Bash', value: 'bash', aliases: [] },
  { label: 'PowerShell', value: 'powershell', aliases: ['ps'] },
  { label: 'TOML', value: 'toml', aliases: [] },
  { label: 'INI', value: 'ini', aliases: [] },
  { label: 'GraphQL', value: 'graphql', aliases: ['gql'] },
  { label: 'Docker', value: 'docker', aliases: ['dockerfile'] },
];

/** 根据语言 value 获取对应的 label（大驼峰显示名），不在列表中则原样返回 */
export function getCodeLanguageLabel(value: string): string {
  if (!value) return 'code';
  const found = CODE_LANGUAGES.find((l) => l.value === value || l.aliases.includes(value));
  return found ? found.label : value;
}
