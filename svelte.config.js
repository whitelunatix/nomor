import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

export default {
  // 项目里没有 `<style lang>` 预处理器，Svelte 自己就能编译纯 CSS。
  // 关掉 style 预处理可以避开 vitePreprocess 在 Vitest 里拿不到
  // 已解析配置、对 undefined 建 Proxy 的崩溃（组件编译阶段直接失败）。
  preprocess: vitePreprocess({ style: false }),
};
