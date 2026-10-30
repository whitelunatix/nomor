//! PDF 页眉页脚与页码后处理。
//!
//! 原生打印无法输出可自定义的页眉页脚，这里在打印完成后用 lopdf 为每页追加一条
//! 内容流，绘制页眉/页脚文字。中文使用预定义 CID 字体 `STSong-Light` + `UniGB-UCS2-H`，
//! 由阅读器按系统字体回退显示，不需要内嵌字体文件。

use std::path::Path;

use lopdf::{Dictionary, Document, Object, ObjectId, Stream};

use crate::models::PdfMarginsInput;

const CHROME_FONT: &str = "NomoChrome";
const CHROME_FONT_BASE: &str = "STSong-Light";
const FONT_SIZE: f32 = 9.0;
const LINE_GAP: f32 = 11.0;
const POINTS_PER_MILLIMETER: f32 = 72.0 / 25.4;
const MIN_MARGIN_BAND_MM: f32 = 12.0;
const MAX_TEMPLATE_LINES: usize = 2;

/// 页眉页脚绘制参数；模板中的占位符在每页按实际页码替换。
pub(crate) struct PdfChromeOptions<'a> {
    pub(crate) header_template: &'a str,
    pub(crate) footer_template: &'a str,
    pub(crate) title: &'a str,
    pub(crate) date: &'a str,
    pub(crate) margins: Option<&'a PdfMarginsInput>,
}

impl PdfChromeOptions<'_> {
    pub(crate) fn is_active(&self) -> bool {
        !self.header_template.trim().is_empty() || !self.footer_template.trim().is_empty()
    }
}

/// 为每一页绘制页眉/页脚，并写入新的 PDF 文件。
pub(crate) fn add_page_chrome(
    input_path: &Path,
    output_path: &Path,
    options: &PdfChromeOptions<'_>,
) -> Result<(), String> {
    let mut document =
        Document::load(input_path).map_err(|error| format!("解析 PDF 失败：{error}"))?;
    let pages: Vec<(u32, ObjectId)> = document.get_pages().into_iter().collect();
    if pages.is_empty() {
        return Err("PDF 不包含页面".to_string());
    }
    let total = pages.len() as u32;
    let font_id = document.add_object(chrome_font());

    for (index, (_number, page_id)) in pages.iter().enumerate() {
        let page_number = index as u32 + 1;
        let bounds = page_bounds(&document, *page_id)?;
        let header = render_template_lines(options.header_template, page_number, total, options);
        let footer = render_template_lines(options.footer_template, page_number, total, options);
        if header.is_empty() && footer.is_empty() {
            continue;
        }
        let content = build_content_stream(&bounds, options, &header, &footer)?;
        add_font_resource(&mut document, *page_id, font_id)?;
        document
            .add_page_contents(*page_id, content)
            .map_err(|error| format!("写入 PDF 页眉页脚失败：{error}"))?;
    }

    document
        .save(output_path)
        .map(|_| ())
        .map_err(|error| format!("写入 PDF 文件失败：{error}"))
}

struct PageBounds {
    left: f32,
    bottom: f32,
    right: f32,
    top: f32,
}

fn page_bounds(document: &Document, page_id: ObjectId) -> Result<PageBounds, String> {
    let page = document
        .get_dictionary(page_id)
        .map_err(|error| format!("读取 PDF 页面失败：{error}"))?;
    let media_box = page
        .get(b"MediaBox")
        .map_err(|_| "PDF 页面缺少 MediaBox".to_string())?;
    let (_, media_box) = document
        .dereference(media_box)
        .map_err(|error| format!("读取 PDF 页面尺寸失败：{error}"))?;
    let values = media_box
        .as_array()
        .map_err(|error| format!("PDF 页面尺寸格式无效：{error}"))?;
    if values.len() != 4 {
        return Err("PDF 页面尺寸长度无效".to_string());
    }
    let coordinate = |index: usize| {
        values[index]
            .as_float()
            .map_err(|error| format!("PDF 页面尺寸坐标无效：{error}"))
    };
    let left = coordinate(0)?;
    let bottom = coordinate(1)?;
    let right = coordinate(2)?;
    let top = coordinate(3)?;
    if right <= left || top <= bottom {
        return Err("PDF 页面尺寸无效".to_string());
    }
    Ok(PageBounds {
        left: left.min(right),
        bottom: bottom.min(top),
        right: left.max(right),
        top: bottom.max(top),
    })
}

fn render_template_lines(
    template: &str,
    page_number: u32,
    total: u32,
    options: &PdfChromeOptions<'_>,
) -> Vec<String> {
    let normalized = template.replace("\r\n", "\n").replace('\r', "\n");
    normalized
        .split('\n')
        .take(MAX_TEMPLATE_LINES)
        .map(|line| {
            line.replace("{title}", options.title)
                .replace("{date}", options.date)
                .replace("{page}", &page_number.to_string())
                .replace("{total}", &total.to_string())
        })
        .collect()
}

fn build_content_stream(
    bounds: &PageBounds,
    options: &PdfChromeOptions<'_>,
    header: &[String],
    footer: &[String],
) -> Result<Vec<u8>, String> {
    let page_width = bounds.right - bounds.left;
    let top_margin = margin_points(options.margins.map(|value| value.top));
    let bottom_margin = margin_points(options.margins.map(|value| value.bottom));
    let top_band = top_margin.max(MIN_MARGIN_BAND_MM * POINTS_PER_MILLIMETER);
    let bottom_band = bottom_margin.max(MIN_MARGIN_BAND_MM * POINTS_PER_MILLIMETER);

    let mut stream = String::from("q\n0.4 g\n");
    for (index, line) in header.iter().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let baseline = bounds.top - top_band / 2.0 - FONT_SIZE * 0.35 - index as f32 * LINE_GAP;
        push_text(&mut stream, line, bounds.left, page_width, baseline);
    }
    let footer_gap = (footer.len().saturating_sub(1)) as f32 * LINE_GAP;
    for (index, line) in footer.iter().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let baseline = bounds.bottom + bottom_band / 2.0 - FONT_SIZE * 0.35
            + footer_gap
            - index as f32 * LINE_GAP;
        push_text(&mut stream, line, bounds.left, page_width, baseline);
    }
    stream.push_str("Q\n");
    Ok(stream.into_bytes())
}

fn push_text(stream: &mut String, line: &str, left: f32, page_width: f32, baseline: f32) {
    let width = approximate_text_width(line);
    let x = (left + (page_width - width) / 2.0).max(left);
    stream.push_str(&format!(
        "BT\n/{CHROME_FONT} {FONT_SIZE:.2} Tf\n1 0 0 1 {x:.2} {baseline:.2} Tm\n<{}> Tj\nET\n",
        utf16be_hex(line)
    ));
}

fn approximate_text_width(text: &str) -> f32 {
    text.chars()
        .map(|character| if character.is_ascii() { 0.52 } else { 1.0 })
        .sum::<f32>()
        * FONT_SIZE
}

fn utf16be_hex(text: &str) -> String {
    let mut encoded = String::with_capacity(text.len() * 4);
    for unit in text.encode_utf16() {
        encoded.push_str(&format!("{unit:04X}"));
    }
    encoded
}

fn margin_points(value: Option<f64>) -> f32 {
    let value = value.filter(|value| value.is_finite() && *value >= 0.0);
    (value.unwrap_or(20.0) as f32) * POINTS_PER_MILLIMETER
}

fn chrome_font() -> Dictionary {
    let mut descriptor = Dictionary::new();
    descriptor.set("Type", Object::Name(b"FontDescriptor".to_vec()));
    descriptor.set("FontName", Object::Name(CHROME_FONT_BASE.as_bytes().to_vec()));
    descriptor.set("Flags", 4i64);
    descriptor.set(
        "FontBBox",
        vec![
            Object::Integer(-25),
            Object::Integer(-254),
            Object::Integer(1000),
            Object::Integer(880),
        ],
    );
    descriptor.set("ItalicAngle", 0i64);
    descriptor.set("Ascent", 880i64);
    descriptor.set("Descent", -120i64);
    descriptor.set("CapHeight", 880i64);
    descriptor.set("StemV", 93i64);

    let mut system_info = Dictionary::new();
    system_info.set("Registry", Object::string_literal("Adobe"));
    system_info.set("Ordering", Object::string_literal("GB1"));
    system_info.set("Supplement", 4i64);

    let mut descendant = Dictionary::new();
    descendant.set("Type", Object::Name(b"Font".to_vec()));
    descendant.set("Subtype", Object::Name(b"CIDFontType0".to_vec()));
    descendant.set(
        "BaseFont",
        Object::Name(CHROME_FONT_BASE.as_bytes().to_vec()),
    );
    descendant.set("CIDSystemInfo", Object::Dictionary(system_info));
    descendant.set("FontDescriptor", Object::Dictionary(descriptor));
    descendant.set("DW", 1000i64);

    let mut font = Dictionary::new();
    font.set("Type", Object::Name(b"Font".to_vec()));
    font.set("Subtype", Object::Name(b"Type0".to_vec()));
    font.set("BaseFont", Object::Name(CHROME_FONT_BASE.as_bytes().to_vec()));
    font.set("Encoding", Object::Name(b"UniGB-UCS2-H".to_vec()));
    font.set(
        "DescendantFonts",
        vec![Object::Dictionary(descendant)],
    );
    font
}

/// 把字体挂到页面资源上。页面可能继承上级 Resources，先取合并后的副本再覆盖，
/// 避免丢失原有的图片/字体资源。
fn add_font_resource(
    document: &mut Document,
    page_id: ObjectId,
    font_id: ObjectId,
) -> Result<(), String> {
    let mut resources = effective_resources(document, page_id)?;
    let mut fonts = match resources.get(b"Font") {
        Ok(Object::Reference(id)) => document
            .get_dictionary(*id)
            .map_err(|error| format!("读取 PDF 页面字体资源失败：{error}"))?
            .clone(),
        Ok(Object::Dictionary(dictionary)) => dictionary.clone(),
        _ => Dictionary::new(),
    };
    fonts.set(CHROME_FONT, font_id);
    let fonts_id = document.add_object(fonts);
    resources.set("Font", fonts_id);
    let resources_id = document.add_object(resources);
    document
        .get_dictionary_mut(page_id)
        .map_err(|error| format!("更新 PDF 页面资源失败：{error}"))?
        .set("Resources", resources_id);
    Ok(())
}

fn effective_resources(document: &Document, page_id: ObjectId) -> Result<Dictionary, String> {
    let mut resources = Dictionary::new();
    let (direct, inherited) = document
        .get_page_resources(page_id)
        .map_err(|error| format!("读取 PDF 页面资源失败：{error}"))?;
    if let Some(direct) = direct {
        merge_dictionary(&mut resources, direct);
    }
    for resource_id in inherited {
        let dictionary = document
            .get_dictionary(resource_id)
            .map_err(|error| format!("读取 PDF 继承资源失败：{error}"))?;
        merge_dictionary(&mut resources, dictionary);
    }
    Ok(resources)
}

fn merge_dictionary(target: &mut Dictionary, source: &Dictionary) {
    for (key, value) in source.iter() {
        if !target.has(key) {
            target.set(key.clone(), value.clone());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TestDirectory(PathBuf);
    impl TestDirectory {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "nomo-pdf-chrome-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn sample_pdf(page_count: usize) -> Vec<u8> {
        let mut document = Document::with_version("1.5");
        let pages_id = document.new_object_id();
        let mut kids = Vec::new();
        for _ in 0..page_count {
            let contents_id = document.add_object(Stream::new(Dictionary::new(), b"".to_vec()));
            let mut page = Dictionary::new();
            page.set("Type", Object::Name(b"Page".to_vec()));
            page.set("Parent", pages_id);
            page.set(
                "MediaBox",
                vec![
                    Object::Integer(0),
                    Object::Integer(0),
                    Object::Integer(595),
                    Object::Integer(842),
                ],
            );
            page.set("Contents", contents_id);
            let page_id = document.add_object(page);
            kids.push(page_id);
        }
        let mut pages = Dictionary::new();
        pages.set("Type", Object::Name(b"Pages".to_vec()));
        pages.set("Count", kids.len() as i64);
        pages.set("Kids", kids.into_iter().map(Object::from).collect::<Vec<_>>());
        document.set_object(pages_id, pages);
        let catalog_id = document.add_object({
            let mut catalog = Dictionary::new();
            catalog.set("Type", Object::Name(b"Catalog".to_vec()));
            catalog.set("Pages", pages_id);
            catalog
        });
        document.trailer.set("Root", catalog_id);
        let mut bytes = Vec::new();
        document.save_to(&mut bytes).unwrap();
        bytes
    }

    fn options<'a>(
        header: &'a str,
        footer: &'a str,
        margins: &'a PdfMarginsInput,
    ) -> PdfChromeOptions<'a> {
        PdfChromeOptions {
            header_template: header,
            footer_template: footer,
            title: "中文标题",
            date: "2026-10-30",
            margins: Some(margins),
        }
    }

    #[test]
    fn substitutes_placeholders_and_limits_lines() {
        let margins = PdfMarginsInput {
            top: 20.0,
            right: 20.0,
            bottom: 20.0,
            left: 20.0,
        };
        let options = options("{title} / {date}", "第 {page} 页 / 共 {total} 页\n第二行\n第三行", &margins);
        let lines = render_template_lines(options.footer_template, 2, 9, &options);
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0], "第 2 页 / 共 9 页");
        assert_eq!(render_template_lines(options.header_template, 1, 9, &options)[0], "中文标题 / 2026-10-30");
        assert!(render_template_lines("", 1, 1, &options)[0].is_empty());
        assert!(options.is_active());
    }

    #[test]
    fn encodes_chinese_as_utf16_without_bom() {
        assert_eq!(utf16be_hex("A中"), "00414E2D");
        assert!(approximate_text_width("中文") > approximate_text_width("ab"));
    }

    #[test]
    fn draws_footer_on_every_page_and_preserves_page_count() {
        let directory = TestDirectory::new();
        let source = directory.0.join("source.pdf");
        let output = directory.0.join("output.pdf");
        std::fs::write(&source, sample_pdf(3)).unwrap();
        let margins = PdfMarginsInput {
            top: 20.0,
            right: 20.0,
            bottom: 20.0,
            left: 20.0,
        };
        add_page_chrome(
            &source,
            &output,
            &options("", "第 {page} 页 / 共 {total} 页", &margins),
        )
        .unwrap();

        let document = Document::load(&output).unwrap();
        let pages = document.get_pages();
        assert_eq!(pages.len(), 3);
        for (number, page_id) in pages {
            let content = String::from_utf8_lossy(&document.get_page_content(page_id)).into_owned();
            assert!(content.contains("/NomoChrome"));
            assert!(content.contains(utf16be_hex(&format!("第 {number} 页 / 共 3 页")).as_str()));
            let fonts = document.get_page_fonts(page_id).unwrap();
            assert!(fonts.contains_key(CHROME_FONT.as_bytes()));
        }
    }

    #[test]
    fn keeps_inherited_resources_when_adding_font() {
        let directory = TestDirectory::new();
        let source = directory.0.join("inherited.pdf");
        let output = directory.0.join("inherited-out.pdf");
        std::fs::write(&source, sample_pdf(1)).unwrap();
        // 把 Resources 放到 Pages 节点上，由页面继承。
        let mut document = Document::load(&source).unwrap();
        let page_id = *document.get_pages().values().next().unwrap();
        let parent_id = document
            .get_dictionary(page_id)
            .unwrap()
            .get(b"Parent")
            .and_then(Object::as_reference)
            .unwrap();
        let mut resources = Dictionary::new();
        let mut fonts = Dictionary::new();
        let font_id = document.add_object({
            let mut font = Dictionary::new();
            font.set("Type", Object::Name(b"Font".to_vec()));
            font.set("Subtype", Object::Name(b"Type1".to_vec()));
            font.set("BaseFont", Object::Name(b"Helvetica".to_vec()));
            font
        });
        fonts.set("Existing", font_id);
        let fonts_id = document.add_object(fonts);
        resources.set("Font", fonts_id);
        let resources_id = document.add_object(resources);
        document
            .get_dictionary_mut(parent_id)
            .unwrap()
            .set("Resources", resources_id);
        document.save(&source).unwrap();

        let margins = PdfMarginsInput {
            top: 20.0,
            right: 20.0,
            bottom: 20.0,
            left: 20.0,
        };
        add_page_chrome(&source, &output, &options("页眉", "", &margins)).unwrap();

        let document = Document::load(&output).unwrap();
        let page_id = *document.get_pages().values().next().unwrap();
        let fonts = document.get_page_fonts(page_id).unwrap();
        assert!(fonts.contains_key(b"Existing".as_slice()));
        assert!(fonts.contains_key(CHROME_FONT.as_bytes()));
    }

    #[test]
    fn rejects_invalid_pdf() {
        let directory = TestDirectory::new();
        let source = directory.0.join("bad.pdf");
        std::fs::write(&source, b"not a pdf").unwrap();
        let margins = PdfMarginsInput {
            top: 20.0,
            right: 20.0,
            bottom: 20.0,
            left: 20.0,
        };
        assert!(add_page_chrome(&source, &directory.0.join("out.pdf"), &options("a", "", &margins)).is_err());
    }
}
