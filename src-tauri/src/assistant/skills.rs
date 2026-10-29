//! Skills：扫描技能目录里的 `SKILL.md`，把元数据、正文与可读资源交给前端工具。
//!
//! 只读、只扫一级子目录——`~/.skills-manager/skills` 下常有 worktree 副本，
//! 递归会把同一份技能重复列出好几次。技能内的 `references/`、`scripts/`
//! 允许按需读取，但必须留在技能目录内。

use serde::Serialize;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Mutex,
    time::SystemTime,
};
use tauri::{AppHandle, Manager, State};

use super::{
    files::{decode_text, looks_binary, read_text_file},
    limits::{
        SKILL_MAX_CONTENT_BYTES as MAX_CONTENT_BYTES,
        SKILL_MAX_FILE_BYTES as MAX_SKILL_FILE_BYTES,
        SKILL_MAX_RESOURCE_BYTES as MAX_RESOURCE_BYTES,
        SKILL_MAX_RESOURCE_DEPTH as MAX_RESOURCE_DEPTH,
        SKILL_MAX_RESOURCE_FILES as MAX_RESOURCE_FILES,
        SKILL_MAX_RESOURCE_PATH_LENGTH as MAX_RESOURCE_PATH_LENGTH,
    },
    prefs::{read_assistant_preferences, string_field},
};

/// 只允许读取这两个子目录，避免把技能目录变成任意文件读取入口。
const RESOURCE_DIRS: &[&str] = &["references", "scripts"];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SkillInfo {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) description: String,
    pub(crate) path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SkillFileInfo {
    /// 相对技能目录的路径，例如 `references/style.md`。
    pub(crate) path: String,
    pub(crate) bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SkillContent {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) description: String,
    pub(crate) path: String,
    pub(crate) content: String,
    pub(crate) truncated: bool,
    /// `references/`、`scripts/` 下可继续读取的文件（相对路径）。
    pub(crate) files: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SkillFileContent {
    pub(crate) path: String,
    pub(crate) bytes: u64,
    pub(crate) truncated: bool,
    pub(crate) content: String,
}

struct CachedSkill {
    file: PathBuf,
    modified: Option<SystemTime>,
    len: u64,
    info: SkillInfo,
    content: SkillContent,
}

#[derive(Default)]
struct CacheState {
    root: Option<PathBuf>,
    entries: HashMap<String, CachedSkill>,
}

/// 技能缓存：`SKILL.md` 的路径、mtime、大小任一变化都会重新读取；
/// 技能根切换时整体清空，避免显示另一个目录下的同名技能。
#[derive(Default)]
pub(crate) struct SkillsCache {
    state: Mutex<CacheState>,
}

impl SkillsCache {
    fn lock(&self) -> Result<std::sync::MutexGuard<'_, CacheState>, String> {
        self.state
            .lock()
            .map_err(|_| "技能缓存不可用".to_string())
    }
}

/// 技能根目录只认设置里保存的 `skillsRoot`。
/// webview 不能临时指定目录，否则任何脚本都能让工具去读任意位置的文件。
fn skills_root(app: &AppHandle) -> Result<PathBuf, String> {
    let configured = read_assistant_preferences(app)?
        .as_ref()
        .and_then(|value| string_field(value, "skillsRoot"));
    if let Some(root) = configured {
        return Ok(PathBuf::from(root));
    }
    app.path()
        .home_dir()
        .map(|home| home.join(".skills-manager").join("skills"))
        .map_err(|error| format!("定位用户目录失败：{error}"))
}

fn canonical_root(root: &Path) -> Result<PathBuf, String> {
    if !root.is_dir() {
        return Err(format!("技能目录不存在：{}", root.display()));
    }
    std::fs::canonicalize(root).map_err(|error| format!("技能目录不可用：{error}"))
}

/// 拆出 `---` 包起来的 frontmatter 与正文；没有 frontmatter 时正文就是全文。
fn split_frontmatter(text: &str) -> (Option<&str>, &str) {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let Some(rest) = text.strip_prefix("---") else {
        return (None, text);
    };
    let rest = if let Some(rest) = rest.strip_prefix("\r\n") {
        rest
    } else if let Some(rest) = rest.strip_prefix('\n') {
        rest
    } else {
        return (None, text);
    };

    let mut offset = 0;
    for line in rest.split_inclusive('\n') {
        let content = line.trim_end_matches(['\r', '\n']);
        if content.trim() == "---" {
            return (Some(&rest[..offset]), &rest[offset + line.len()..]);
        }
        offset += line.len();
    }
    (None, text)
}

fn unquote(value: &str) -> String {
    let trimmed = value.trim();
    for quote in ['"', '\''] {
        if trimmed.len() >= 2 && trimmed.starts_with(quote) && trimmed.ends_with(quote) {
            return trimmed[1..trimmed.len() - 1].to_string();
        }
    }
    trimmed.to_string()
}

/// 只认识 `key: value` 形式的简单 frontmatter，不引入 YAML 依赖。
fn parse_frontmatter(frontmatter: &str) -> Vec<(String, String)> {
    let mut pairs = Vec::new();
    for line in frontmatter.lines() {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let key = key.trim();
        if key.is_empty() || key.starts_with('#') {
            continue;
        }
        pairs.push((key.to_string(), unquote(value)));
    }
    pairs
}

fn meta_value(pairs: &[(String, String)], key: &str) -> Option<String> {
    pairs
        .iter()
        .find(|(name, _)| name == key)
        .map(|(_, value)| value.clone())
        .filter(|value| !value.trim().is_empty())
}

fn describe(id: &str, path: &Path, text: &str) -> SkillInfo {
    let (frontmatter, _) = split_frontmatter(text);
    let pairs = frontmatter.map(parse_frontmatter).unwrap_or_default();
    SkillInfo {
        id: id.to_string(),
        name: meta_value(&pairs, "name").unwrap_or_else(|| id.to_string()),
        description: meta_value(&pairs, "description").unwrap_or_default(),
        path: path.display().to_string(),
    }
}

/// 列出 `references/`、`scripts/` 下的文本文件；跳过符号链接与隐藏项。
fn list_resource_entries(skill_dir: &Path) -> Vec<SkillFileInfo> {
    let mut files = Vec::new();
    for name in RESOURCE_DIRS {
        let Ok(canonical) = std::fs::canonicalize(skill_dir.join(name)) else {
            continue;
        };
        if !canonical.starts_with(skill_dir) || !canonical.is_dir() {
            continue;
        }
        let mut stack = vec![(canonical, name.to_string(), 1usize)];
        while let Some((dir, prefix, depth)) = stack.pop() {
            let Ok(entries) = std::fs::read_dir(&dir) else {
                continue;
            };
            for entry in entries.flatten() {
                if files.len() >= MAX_RESOURCE_FILES {
                    break;
                }
                let Ok(file_type) = entry.file_type() else {
                    continue;
                };
                if file_type.is_symlink() {
                    continue;
                }
                let file_name = entry.file_name().to_string_lossy().to_string();
                if file_name.starts_with('.') {
                    continue;
                }
                let relative = format!("{prefix}/{file_name}");
                if file_type.is_dir() {
                    if depth < MAX_RESOURCE_DEPTH {
                        stack.push((entry.path(), relative, depth + 1));
                    }
                } else if file_type.is_file() {
                    let Ok(metadata) = entry.metadata() else {
                        continue;
                    };
                    files.push(SkillFileInfo {
                        path: relative,
                        bytes: metadata.len(),
                    });
                }
            }
        }
    }
    files.sort_by(|left, right| left.path.cmp(&right.path));
    files.truncate(MAX_RESOURCE_FILES);
    files
}

fn build_skill(id: &str, file: &Path, text: &str) -> (SkillInfo, SkillContent) {
    let info = describe(id, file, text);
    let (_, body) = split_frontmatter(text);
    let (content, truncated) = truncate_content(body.trim().to_string());
    let files = file
        .parent()
        .map(list_resource_entries)
        .unwrap_or_default()
        .into_iter()
        .map(|entry| entry.path)
        .collect();
    let content = SkillContent {
        id: info.id.clone(),
        name: info.name.clone(),
        description: info.description.clone(),
        path: info.path.clone(),
        content,
        truncated,
        files,
    };
    (info, content)
}

#[cfg(test)]
fn scan_uncached(root: &Path) -> Result<Vec<SkillInfo>, String> {
    let root = canonical_root(root)?;
    let entries =
        std::fs::read_dir(&root).map_err(|error| format!("读取技能目录失败：{error}"))?;
    let mut skills = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let id = entry.file_name().to_string_lossy().to_string();
        if id.starts_with('.') {
            continue;
        }
        // 指向根目录之外的符号链接不算技能。
        let Ok(canonical_dir) = std::fs::canonicalize(&path) else {
            continue;
        };
        if !canonical_dir.starts_with(&root) {
            continue;
        }
        let file = canonical_dir.join("SKILL.md");
        let Ok(metadata) = std::fs::metadata(&file) else {
            continue;
        };
        if !metadata.is_file() || metadata.len() > MAX_SKILL_FILE_BYTES {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&file) else {
            continue;
        };
        skills.push(describe(&id, &file, &text));
    }
    skills.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
    Ok(skills)
}

/// 带缓存的技能列表；缓存命中时不再读 `SKILL.md`。
fn scan_cached(cache: &SkillsCache, root: &Path) -> Result<Vec<SkillInfo>, String> {
    let root = canonical_root(root)?;
    let entries =
        std::fs::read_dir(&root).map_err(|error| format!("读取技能目录失败：{error}"))?;
    let mut state = cache.lock()?;
    if state.root.as_deref() != Some(root.as_path()) {
        state.root = Some(root.clone());
        state.entries.clear();
    }

    let mut skills = Vec::new();
    let mut seen = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let id = entry.file_name().to_string_lossy().to_string();
        if id.starts_with('.') {
            continue;
        }
        let Ok(canonical_dir) = std::fs::canonicalize(&path) else {
            continue;
        };
        if !canonical_dir.starts_with(&root) {
            continue;
        }
        let file = canonical_dir.join("SKILL.md");
        let Some((modified, len)) = file_signature(&file) else {
            continue;
        };
        if len > MAX_SKILL_FILE_BYTES {
            continue;
        }
        seen.push(id.clone());
        if let Some(cached) = state.entries.get(&id) {
            if cached.file == file && cached.modified == modified && cached.len == len {
                skills.push(cached.info.clone());
                continue;
            }
        }
        let Ok(text) = std::fs::read_to_string(&file) else {
            continue;
        };
        let (info, content) = build_skill(&id, &file, &text);
        state.entries.insert(
            id.clone(),
            CachedSkill {
                file,
                modified,
                len,
                info: info.clone(),
                content,
            },
        );
        skills.push(info);
    }
    state.entries.retain(|id, _| seen.contains(id));
    skills.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
    Ok(skills)
}

/// 解析技能文件并确认它仍在技能根目录内（拒绝符号链接逃逸）。
fn resolve_skill_file(root: &Path, id: &str) -> Result<PathBuf, String> {
    validate_id(id)?;
    let root = std::fs::canonicalize(root)
        .map_err(|error| format!("技能目录不可用：{error}"))?;
    let file = root.join(id).join("SKILL.md");
    let canonical =
        std::fs::canonicalize(&file).map_err(|error| format!("读取技能「{id}」失败：{error}"))?;
    if !canonical.starts_with(&root) {
        return Err(format!("技能「{id}」指向了技能目录之外"));
    }
    Ok(canonical)
}

fn validate_id(id: &str) -> Result<&str, String> {
    let valid = !id.is_empty()
        && id.len() <= 128
        && !id.starts_with('.')
        && id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'));
    if valid {
        Ok(id)
    } else {
        Err(format!("非法的技能 id：{id}"))
    }
}

fn truncate_content(mut text: String) -> (String, bool) {
    if text.len() <= MAX_CONTENT_BYTES {
        return (text, false);
    }
    let mut end = MAX_CONTENT_BYTES;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text.truncate(end);
    text.push_str("\n\n…（技能正文过长，已截断）");
    (text, true)
}

fn file_signature(file: &Path) -> Option<(Option<SystemTime>, u64)> {
    let metadata = std::fs::metadata(file).ok()?;
    if !metadata.is_file() {
        return None;
    }
    Some((metadata.modified().ok(), metadata.len()))
}

fn read_skill_text(id: &str, file: &Path) -> Result<String, String> {
    let metadata =
        std::fs::metadata(file).map_err(|error| format!("读取技能「{id}」失败：{error}"))?;
    if metadata.len() > MAX_SKILL_FILE_BYTES {
        return Err(format!(
            "技能「{id}」的 SKILL.md 过大（{} KB），无法载入",
            metadata.len() / 1024
        ));
    }
    std::fs::read_to_string(file).map_err(|error| format!("读取技能「{id}」失败：{error}"))
}

#[cfg(test)]
fn read_skill(root: &Path, id: &str) -> Result<SkillContent, String> {
    let root = canonical_root(root)?;
    let file = resolve_skill_file(&root, id)?;
    let text = read_skill_text(id, &file)?;
    Ok(build_skill(id, &file, &text).1)
}

fn load_skill_cached(
    cache: &SkillsCache,
    root: &Path,
    id: &str,
) -> Result<SkillContent, String> {
    let root = canonical_root(root)?;
    let file = resolve_skill_file(&root, id)?;
    let (modified, len) = file_signature(&file)
        .ok_or_else(|| format!("读取技能「{id}」失败：文件不可用"))?;
    let mut state = cache.lock()?;
    if state.root.as_deref() != Some(root.as_path()) {
        state.root = Some(root);
        state.entries.clear();
    }
    if let Some(cached) = state.entries.get(id) {
        if cached.file == file && cached.modified == modified && cached.len == len {
            return Ok(cached.content.clone());
        }
    }
    let text = read_skill_text(id, &file)?;
    let (info, content) = build_skill(id, &file, &text);
    state.entries.insert(
        id.to_string(),
        CachedSkill {
            file,
            modified,
            len,
            info,
            content: content.clone(),
        },
    );
    Ok(content)
}

fn validate_resource_path(relative: &str) -> Result<String, String> {
    let trimmed = relative.trim();
    if trimmed.is_empty() || trimmed.len() > MAX_RESOURCE_PATH_LENGTH {
        return Err("技能资源路径不合法".to_string());
    }
    let normalized = trimmed.replace('\\', "/");
    if normalized.starts_with('/') || normalized.contains(':') {
        return Err("技能资源只接受相对路径".to_string());
    }
    let parts: Vec<&str> = normalized.split('/').collect();
    if parts
        .iter()
        .any(|part| part.is_empty() || *part == "." || *part == "..")
    {
        return Err("技能资源路径不能包含 . 或 ..".to_string());
    }
    if !RESOURCE_DIRS.iter().any(|dir| *dir == parts[0]) {
        return Err("只能读取 references/ 或 scripts/ 下的文件".to_string());
    }
    Ok(normalized)
}

fn read_skill_resource(skill_dir: &Path, relative: &str) -> Result<SkillFileContent, String> {
    let normalized = validate_resource_path(relative)?;
    // 统一成 canonical 形式再比较，否则 Windows 上 `\\?\C:\...` 与前缀对不上。
    let skill_dir = std::fs::canonicalize(skill_dir)
        .map_err(|error| format!("技能目录不可用：{error}"))?;
    let candidate = normalized
        .split('/')
        .fold(skill_dir.to_path_buf(), |path, part| path.join(part));
    let canonical = std::fs::canonicalize(&candidate)
        .map_err(|error| format!("读取技能资源失败：{error}"))?;
    if !canonical.starts_with(skill_dir) {
        return Err("技能资源指向了技能目录之外".to_string());
    }
    let metadata = std::fs::metadata(&canonical)
        .map_err(|error| format!("读取技能资源失败：{error}"))?;
    if !metadata.is_file() {
        return Err("技能资源不是文件".to_string());
    }
    let (bytes, truncated) = read_text_file(&canonical, MAX_RESOURCE_BYTES)?;
    if looks_binary(&bytes, truncated) {
        return Err("技能资源看起来是二进制文件，无法作为文本读取".to_string());
    }
    let content = decode_text(bytes, truncated)?;
    Ok(SkillFileContent {
        path: normalized,
        bytes: metadata.len(),
        truncated,
        content,
    })
}

#[tauri::command]
pub(crate) fn assistant_skills_list(
    app: AppHandle,
    cache: State<'_, SkillsCache>,
) -> Result<Vec<SkillInfo>, String> {
    let root = skills_root(&app)?;
    scan_cached(&cache, &root)
}

#[tauri::command]
pub(crate) fn assistant_skills_read(
    app: AppHandle,
    cache: State<'_, SkillsCache>,
    id: String,
) -> Result<SkillContent, String> {
    let root = skills_root(&app)?;
    load_skill_cached(&cache, &root, &id)
}

#[tauri::command]
pub(crate) fn assistant_skills_files(
    app: AppHandle,
    id: String,
) -> Result<Vec<SkillFileInfo>, String> {
    let root = canonical_root(&skills_root(&app)?)?;
    let file = resolve_skill_file(&root, &id)?;
    let directory = file
        .parent()
        .ok_or_else(|| format!("技能「{id}」目录不可用"))?;
    Ok(list_resource_entries(directory))
}

#[tauri::command]
pub(crate) fn assistant_skills_read_file(
    app: AppHandle,
    id: String,
    path: String,
) -> Result<SkillFileContent, String> {
    let root = canonical_root(&skills_root(&app)?)?;
    let file = resolve_skill_file(&root, &id)?;
    let directory = file
        .parent()
        .ok_or_else(|| format!("技能「{id}」目录不可用"))?;
    read_skill_resource(directory, &path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_frontmatter_and_body() {
        let text = "---\nname: Word 操作\ndescription: \"处理 docx\"\n---\n\n正文\n";
        let (frontmatter, body) = split_frontmatter(text);
        let pairs = parse_frontmatter(frontmatter.expect("frontmatter"));
        assert_eq!(meta_value(&pairs, "name").as_deref(), Some("Word 操作"));
        assert_eq!(meta_value(&pairs, "description").as_deref(), Some("处理 docx"));
        assert_eq!(body.trim(), "正文");
    }

    #[test]
    fn treats_text_without_frontmatter_as_body() {
        let (frontmatter, body) = split_frontmatter("hello\n---\nworld");
        assert!(frontmatter.is_none());
        assert_eq!(body, "hello\n---\nworld");
    }

    #[test]
    fn rejects_path_like_ids() {
        assert!(validate_id("word-operation").is_ok());
        assert!(validate_id("../secret").is_err());
        assert!(validate_id("a/b").is_err());
        assert!(validate_id("..").is_err());
    }

    fn unique_root(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "nomo-skills-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|value| value.as_nanos())
                .unwrap_or(0)
        ))
    }

    fn demo_skill(root: &Path) -> PathBuf {
        let skill_dir = root.join("demo");
        std::fs::create_dir_all(skill_dir.join("references")).expect("create references");
        std::fs::create_dir_all(skill_dir.join("scripts")).expect("create scripts");
        std::fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: Demo\ndescription: demo skill\n---\n\n步骤一\n",
        )
        .expect("write skill");
        std::fs::write(skill_dir.join("references").join("style.md"), "风格参考")
            .expect("write reference");
        std::fs::write(skill_dir.join("scripts").join("run.ps1"), "Write-Host ok")
            .expect("write script");
        skill_dir
    }

    #[test]
    fn rejects_ids_that_escape_the_root() {
        let root = unique_root("escape");
        std::fs::create_dir_all(&root).expect("create root");

        assert!(resolve_skill_file(&root, "../outside").is_err());
        assert!(resolve_skill_file(&root, "demo/../../outside").is_err());
        assert!(resolve_skill_file(&root, "C:\\Windows").is_err());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinked_skill_escaping_the_root() {
        let root = unique_root("symlink-root");
        let outside = unique_root("symlink-outside");
        std::fs::create_dir_all(&root).expect("create root");
        std::fs::create_dir_all(&outside).expect("create outside");
        std::fs::write(outside.join("SKILL.md"), "secret").expect("write secret");
        if std::os::unix::fs::symlink(&outside, root.join("escape")).is_err() {
            let _ = std::fs::remove_dir_all(&root);
            let _ = std::fs::remove_dir_all(&outside);
            return;
        }

        assert!(resolve_skill_file(&root, "escape").is_err());
        // 扫描时同样跳过越界链接。
        assert!(scan_uncached(&root).expect("scan").is_empty());

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
    }

    #[test]
    fn refuses_oversized_skill_files_before_reading() {
        let root = unique_root("oversized");
        let skill_dir = root.join("huge");
        std::fs::create_dir_all(&skill_dir).expect("create skill dir");
        let file = std::fs::File::create(skill_dir.join("SKILL.md")).expect("create file");
        file.set_len(MAX_SKILL_FILE_BYTES + 1).expect("set len");

        let error = read_skill(&root, "huge").expect_err("must reject");
        assert!(error.contains("过大"), "{error}");
        assert!(scan_uncached(&root).expect("scan").is_empty());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn scans_one_level_and_reads_body() {
        let root = unique_root("scan");
        let skill_dir = demo_skill(&root);
        // 二级目录不算技能，避免 worktree 副本重复出现。
        std::fs::create_dir_all(skill_dir.join("nested")).expect("create nested");

        let skills = scan_uncached(&root).expect("scan");
        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].id, "demo");
        assert_eq!(skills[0].name, "Demo");

        let content = read_skill(&root, "demo").expect("read");
        assert_eq!(content.content, "步骤一");
        assert!(!content.truncated);
        assert_eq!(
            content.files,
            vec!["references/style.md", "scripts/run.ps1"]
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn reads_files_only_from_references_and_scripts() {
        let root = unique_root("resources");
        let skill_dir = demo_skill(&root);
        std::fs::write(skill_dir.join("secret.md"), "secret").expect("write secret");

        let resource =
            read_skill_resource(&skill_dir, "references/style.md").expect("read reference");
        assert_eq!(resource.content, "风格参考");
        assert_eq!(resource.bytes, "风格参考".len() as u64);
        assert!(!resource.truncated);

        assert!(read_skill_resource(&skill_dir, "secret.md").is_err());
        assert!(read_skill_resource(&skill_dir, "../secret.md").is_err());
        assert!(read_skill_resource(&skill_dir, "references/../../secret.md").is_err());
        assert!(read_skill_resource(&skill_dir, "/etc/passwd").is_err());
        assert!(read_skill_resource(&skill_dir, "C:\\Windows\\win.ini").is_err());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn rejects_binary_skill_resources() {
        let root = unique_root("binary");
        let skill_dir = demo_skill(&root);
        std::fs::write(skill_dir.join("references").join("image.bin"), [0u8, 1, 2, 3])
            .expect("write binary");

        let error =
            read_skill_resource(&skill_dir, "references/image.bin").expect_err("must reject");
        assert!(error.contains("二进制"), "{error}");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn truncates_large_skill_resources() {
        let root = unique_root("large-resource");
        let skill_dir = demo_skill(&root);
        std::fs::write(
            skill_dir.join("references").join("big.md"),
            "字".repeat(MAX_RESOURCE_BYTES as usize / 3 + 10),
        )
        .expect("write big");

        let resource =
            read_skill_resource(&skill_dir, "references/big.md").expect("read big");
        assert!(resource.truncated);
        assert!(resource.content.len() <= MAX_RESOURCE_BYTES as usize);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn cache_refreshes_when_skill_markdown_changes() {
        let root = unique_root("cache");
        let skill_dir = demo_skill(&root);
        let cache = SkillsCache::default();

        let first = scan_cached(&cache, &root).expect("first scan");
        assert_eq!(first[0].name, "Demo");

        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: Renamed\ndescription: changed\n---\n\n步骤二\n",
        )
        .expect("rewrite skill");

        let second = scan_cached(&cache, &root).expect("second scan");
        assert_eq!(second[0].name, "Renamed");
        let content = load_skill_cached(&cache, &root, "demo").expect("load");
        assert_eq!(content.content, "步骤二");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn cache_clears_when_root_changes() {
        let first_root = unique_root("cache-root-a");
        let second_root = unique_root("cache-root-b");
        demo_skill(&first_root);
        let second_skill = demo_skill(&second_root);
        std::fs::write(
            second_skill.join("SKILL.md"),
            "---\nname: Other\n---\n\n另一个技能\n",
        )
        .expect("rewrite second");

        let cache = SkillsCache::default();
        assert_eq!(scan_cached(&cache, &first_root).expect("scan a")[0].name, "Demo");
        assert_eq!(
            scan_cached(&cache, &second_root).expect("scan b")[0].name,
            "Other"
        );

        let _ = std::fs::remove_dir_all(&first_root);
        let _ = std::fs::remove_dir_all(&second_root);
    }
}
