/**
 * 右侧共用抽屉（文档大纲 / 文档属性）的宽度偏好。
 *
 * 默认宽度由 `editor-right-drawer.css` 用容器单位计算；用户拖动分割线后，
 * 这里把像素宽度写到根元素的自定义属性上，抽屉、正文预留空间和状态栏
 * 都引用同一个变量，因此三者始终对齐。
 */

import { createDrawerWidthPreference } from './drawerWidth';

export const SIDE_DRAWER_MIN_WIDTH = 260;
export const SIDE_DRAWER_MAX_WIDTH = 560;
export const SIDE_DRAWER_DEFAULT_WIDTH = 360;
export const SIDE_DRAWER_STORAGE_KEY = 'newmd.sideDrawer.width.v1';

const preference = createDrawerWidthPreference({
  storageKey: SIDE_DRAWER_STORAGE_KEY,
  cssVariable: '--side-drawer-width',
  minWidth: SIDE_DRAWER_MIN_WIDTH,
  maxWidth: SIDE_DRAWER_MAX_WIDTH,
  defaultWidth: SIDE_DRAWER_DEFAULT_WIDTH,
});

export const clampSideDrawerWidth = preference.clamp;
export const parseStoredSideDrawerWidth = preference.parse;
export const readStoredSideDrawerWidth = preference.read;
export const writeStoredSideDrawerWidth = preference.write;
export const applySideDrawerWidth = preference.apply;
