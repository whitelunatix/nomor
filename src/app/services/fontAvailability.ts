import { formatFontFamilyName } from '../../lib/theme/fonts';

/**
 * 本地字体可用性探测与设置页候选字体。
 *
 * WebView 不提供系统字体枚举接口，这里用 canvas 比较“目标字体 + 通用回退”与“仅通用回退”的
 * 文本宽度：任一回退族下宽度不同即说明目标字体参与了渲染。结果只用于设置页提示和候选过滤，
 * 不影响字体偏好的保存与应用。
 */

/** 同时覆盖拉丁宽窄字形与中日文字形，避免只含 CJK 的字体被误判为未安装。 */
const PROBE_TEXT = 'mmmmmmmmmmlli WwQq 永和文字';
/** 大字号放大字宽差异，降低亚像素取整造成的误判。 */
const PROBE_FONT_SIZE = '72px';
/** 目标字体恰好是某个通用族的默认字体时，另外两个族仍能区分。 */
const PROBE_FALLBACK_FAMILIES = ['monospace', 'serif', 'sans-serif'];
/** 每项约几十字节；上限只防止用户反复输入不同名称时无限增长。 */
const AVAILABILITY_CACHE_LIMIT = 64;

const TEXT_FONT_CANDIDATES = [
  'PingFang SC',
  'Hiragino Sans GB',
  'Songti SC',
  'Kaiti SC',
  'Microsoft YaHei',
  'DengXian',
  'SimSun',
  'KaiTi',
  'Noto Sans SC',
  'Noto Serif SC',
  'Noto Sans CJK SC',
  'Noto Serif CJK SC',
  'Source Han Sans SC',
  'Source Han Serif SC',
  'LXGW WenKai',
  'HarmonyOS Sans SC',
  'MiSans',
  'Helvetica Neue',
  'Segoe UI',
  'Inter',
  'Georgia',
  'Times New Roman',
];
const MONO_FONT_CANDIDATES = [
  'SF Mono',
  'Menlo',
  'Monaco',
  'Consolas',
  'Cascadia Code',
  'JetBrains Mono',
  'Fira Code',
  'Source Code Pro',
  'Sarasa Mono SC',
  'LXGW WenKai Mono',
];

const availabilityCache = new Map<string, boolean | null>();
let probeContext: CanvasRenderingContext2D | null | undefined;
let installedSuggestions: { text: string[]; mono: string[] } | undefined;

/**
 * 判断字体族是否已安装并可被当前 WebView 使用。
 *
 * @param name 已归一化的单个字体族名；通用族关键字视为可用。
 * @returns `true` 可用；`false` 未检测到；`null` 当前环境无法探测（无 canvas）。
 */
export function isFontFamilyAvailable(name: string): boolean | null {
  const cached = availabilityCache.get(name);
  if (cached !== undefined) return cached;
  const result = probeFontFamily(name);
  if (availabilityCache.size >= AVAILABILITY_CACHE_LIMIT) {
    const oldest = availabilityCache.keys().next().value;
    if (oldest !== undefined) availabilityCache.delete(oldest);
  }
  availabilityCache.set(name, result);
  return result;
}

/**
 * 返回本机已安装的候选字体，供设置页输入框联想。首次调用时探测并缓存，之后复用。
 */
export function getInstalledFontSuggestions() {
  installedSuggestions ??= {
    text: TEXT_FONT_CANDIDATES.filter((name) => isFontFamilyAvailable(name) === true),
    mono: MONO_FONT_CANDIDATES.filter((name) => isFontFamilyAvailable(name) === true),
  };
  return installedSuggestions;
}

function probeFontFamily(name: string): boolean | null {
  const formatted = formatFontFamilyName(name);
  // 通用族关键字由浏览器保证存在，未加引号即说明是关键字。
  if (!formatted.startsWith('"')) return true;
  const context = getProbeContext();
  if (!context) return null;
  return PROBE_FALLBACK_FAMILIES.some((fallback) => {
    context.font = `${PROBE_FONT_SIZE} ${fallback}`;
    const fallbackWidth = context.measureText(PROBE_TEXT).width;
    context.font = `${PROBE_FONT_SIZE} ${formatted}, ${fallback}`;
    return context.measureText(PROBE_TEXT).width !== fallbackWidth;
  });
}

function getProbeContext() {
  if (probeContext === undefined) {
    probeContext =
      typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d');
  }
  return probeContext;
}
