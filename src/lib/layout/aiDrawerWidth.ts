/**
 * AI 助手抽屉的宽度偏好。
 *
 * 与文档大纲/属性抽屉共用交互：拖动左边缘、双击恢复默认、方向键调整。
 * 默认宽度仍由 `editor-right-drawer.css` 的 clamp() 计算；用户拖动后
 * 才把像素值写到根元素，抽屉、正文预留与状态栏同步移动。
 */

import { createDrawerWidthPreference } from './drawerWidth';

export const AI_DRAWER_MIN_WIDTH = 300;
export const AI_DRAWER_MAX_WIDTH = 720;
export const AI_DRAWER_DEFAULT_WIDTH = 430;
export const AI_DRAWER_STORAGE_KEY = 'newmd.aiDrawer.width.v1';

const preference = createDrawerWidthPreference({
  storageKey: AI_DRAWER_STORAGE_KEY,
  cssVariable: '--ai-drawer-width',
  minWidth: AI_DRAWER_MIN_WIDTH,
  maxWidth: AI_DRAWER_MAX_WIDTH,
  defaultWidth: AI_DRAWER_DEFAULT_WIDTH,
});

export const clampAiDrawerWidth = preference.clamp;
export const parseStoredAiDrawerWidth = preference.parse;
export const readStoredAiDrawerWidth = preference.read;
export const writeStoredAiDrawerWidth = preference.write;
export const applyAiDrawerWidth = preference.apply;
