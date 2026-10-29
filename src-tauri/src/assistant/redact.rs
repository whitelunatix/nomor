//! 日志/审计脱敏。
//!
//! 不引入正则依赖：只识别常见的请求头与 JSON 字段名，宁可多遮一点，
//! 也不能把 API Key、Bearer Token 写进磁盘。

const REDACTED: &str = "[REDACTED]";

/// 字段名从长到短匹配，避免 `access-token` 被 `token` 抢先截断。
const SENSITIVE_KEYS: &[&str] = &[
    "authorization",
    "x-api-key",
    "access-token",
    "refresh-token",
    "api-key",
    "api_key",
    "apikey",
    "password",
    "passwd",
    "secret",
    "token",
];

fn is_key_boundary_before(line: &str, position: usize) -> bool {
    match line[..position].chars().next_back() {
        None => true,
        Some(value) => !(value.is_ascii_alphanumeric() || value == '_' || value == '-'),
    }
}

fn is_key_boundary_after(value: &str) -> bool {
    match value.chars().next() {
        None => true,
        Some(value) => !(value.is_ascii_alphanumeric() || value == '_'),
    }
}

/// 把 `key: value` / `"key": "value"` 的值替换成 `[REDACTED]`，保留 JSON 结构。
fn redact_key_value(line: &str, key: &str) -> String {
    let mut lower = line.to_ascii_lowercase();
    let mut search_from = 0;
    let mut current = line.to_string();

    while search_from < lower.len() {
        let Some(relative) = lower[search_from..].find(key) else {
            break;
        };
        let position = search_from + relative;
        let after_key = position + key.len();
        if !is_key_boundary_before(&current, position) || !is_key_boundary_after(&current[after_key..])
        {
            search_from = after_key;
            continue;
        }

        let rest = &current[after_key..];
        let Some(separator) = rest.find([':', '=']) else {
            search_from = after_key;
            continue;
        };
        let value_start = after_key + separator + 1;
        let after_separator = &current[value_start..];
        let whitespace = after_separator.len() - after_separator.trim_start().len();
        let value = &after_separator[whitespace..];
        if value.is_empty() {
            search_from = value_start + whitespace;
            continue;
        }

        let (masked, consumed) = if value.starts_with('"') || value.starts_with('\'') {
            let quote = value.chars().next().unwrap_or('"');
            match value[quote.len_utf8()..].find(quote) {
                Some(end) => (
                    format!("{quote}{REDACTED}{quote}"),
                    quote.len_utf8() + end + quote.len_utf8(),
                ),
                None => (REDACTED.to_string(), value.len()),
            }
        } else {
            let end = value
                .find(|character: char| {
                    character.is_whitespace() || matches!(character, ',' | '}' | ']' | ';')
                })
                .unwrap_or(value.len());
            (REDACTED.to_string(), end)
        };

        current.replace_range(value_start + whitespace..value_start + whitespace + consumed, &masked);
        search_from = value_start + whitespace + masked.len();
        // 替换会改变长度；后续查找必须以新字符串为准。
        lower = current.to_ascii_lowercase();
    }

    current
}

/// 遮掉 `Bearer <token>`，保留前缀便于排查是哪种鉴权。
fn redact_bearer(input: &str) -> String {
    let lower = input.to_ascii_lowercase();
    let mut output = String::with_capacity(input.len());
    let mut cursor = 0;

    while let Some(relative) = lower[cursor..].find("bearer") {
        let position = cursor + relative;
        let after_key = position + "bearer".len();
        if !is_key_boundary_before(input, position) {
            output.push_str(&input[cursor..after_key]);
            cursor = after_key;
            continue;
        }
        let rest = &input[after_key..];
        let whitespace = rest.len() - rest.trim_start().len();
        if whitespace == 0 {
            output.push_str(&input[cursor..after_key]);
            cursor = after_key;
            continue;
        }
        let value = &rest[whitespace..];
        let end = value
            .find(|character: char| {
                character.is_whitespace() || matches!(character, '"' | '\'' | ',' | ';' | '}' | ']')
            })
            .unwrap_or(value.len());
        if end == 0 {
            output.push_str(&input[cursor..after_key]);
            cursor = after_key;
            continue;
        }
        output.push_str(&input[cursor..position]);
        output.push_str("Bearer ");
        output.push_str(REDACTED);
        cursor = after_key + whitespace + end;
    }

    output.push_str(&input[cursor..]);
    output
}

fn is_secret_char(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_'
}

/// 遮掉 OpenAI/DeepSeek 风格的 `sk-...`。
fn redact_sk_tokens(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut output = String::with_capacity(input.len());
    let mut cursor = 0;
    let mut index = 0;

    while index + 3 <= bytes.len() {
        if &bytes[index..index + 3] == b"sk-"
            && (index == 0 || !is_secret_char(bytes[index - 1]))
        {
            let mut end = index + 3;
            while end < bytes.len() && is_secret_char(bytes[end]) {
                end += 1;
            }
            // 至少 8 个字符才当成密钥，避免把普通单词里的 sk- 也遮掉。
            if end - (index + 3) >= 8 {
                output.push_str(&input[cursor..index]);
                output.push_str("sk-[REDACTED]");
                cursor = end;
                index = end;
                continue;
            }
        }
        index += 1;
    }

    output.push_str(&input[cursor..]);
    output
}

pub(crate) fn redact_text(input: &str) -> String {
    let mut redacted = String::with_capacity(input.len());
    for line in input.split_inclusive('\n') {
        let mut current = line.to_string();
        for key in SENSITIVE_KEYS {
            current = redact_key_value(&current, key);
        }
        redacted.push_str(&current);
    }
    let redacted = redact_bearer(&redacted);
    redact_sk_tokens(&redacted)
}

#[cfg(test)]
mod tests {
    use super::redact_text;

    #[test]
    fn redacts_authorization_and_bearer_tokens() {
        let text = "Authorization: Bearer sk-abcdefghijklmnop\nnext line";
        let result = redact_text(text);

        assert!(!result.contains("abcdefghijklmnop"), "{result}");
        assert!(result.contains("Authorization"));
        assert!(result.contains("[REDACTED]"));
        assert!(!result.contains("Bearer sk-"), "{result}");
    }

    #[test]
    fn redacts_json_api_keys_but_keeps_structure() {
        let text = r#"{"apiKey":"sk-1234567890abcdef","token":"plain-token","other":1}"#;
        let result = redact_text(text);

        assert!(!result.contains("1234567890abcdef"), "{result}");
        assert!(!result.contains("plain-token"), "{result}");
        assert!(result.contains("\"other\":1"), "{result}");
        assert_eq!(result.matches("[REDACTED]").count(), 2);
    }

    #[test]
    fn does_not_redact_token_counts() {
        let text = r#"{"totalTokens":321,"max_tokens":100}"#;
        assert_eq!(redact_text(text), text);
    }

    #[test]
    fn redacts_x_api_key_header_and_password_fields() {
        let text = "x-api-key: my-secret-value\npassword=hello\nno secret here";
        let result = redact_text(text);

        assert!(!result.contains("my-secret-value"), "{result}");
        assert!(!result.contains("hello"), "{result}");
        assert!(result.contains("no secret here"), "{result}");
    }

    #[test]
    fn leaves_short_sk_prefixes_alone() {
        assert_eq!(redact_text("task-1"), "task-1");
    }
}
