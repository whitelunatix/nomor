import { invoke } from '@tauri-apps/api/core';
import { isTauriRuntime } from '../desktop/tauriStorage';
import type {
  SkillContent,
  SkillFileContent,
  SkillFileInfo,
  SkillInfo,
} from './types';

/**
 * Skills 的前端入口：Rust 负责扫描目录与读文件，这里只搬元数据与正文。
 *
 * 技能根目录只认设置里保存的 `skillsRoot`（空则用 `~/.skills-manager/skills`），
 * Rust 侧读取配置并做越界校验，前端不传路径。
 */

export async function listSkills(): Promise<SkillInfo[]> {
  if (!isTauriRuntime()) {
    return [];
  }
  return invoke<SkillInfo[]>('assistant_skills_list');
}

export async function readSkill(id: string): Promise<SkillContent> {
  return invoke<SkillContent>('assistant_skills_read', { id });
}

/** 列出技能目录里可读取的资源文件（references/、scripts/）。 */
export async function listSkillFiles(id: string): Promise<SkillFileInfo[]> {
  return invoke<SkillFileInfo[]>('assistant_skills_files', { id });
}

/** 读取一个技能资源文件；Rust 侧限制在 references/、scripts/ 内且拒绝二进制。 */
export async function readSkillFile(id: string, path: string): Promise<SkillFileContent> {
  return invoke<SkillFileContent>('assistant_skills_read_file', { id, path });
}
