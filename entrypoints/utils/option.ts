export const services = {
  // 传统机器翻译
  google: 'google',
  // 大模型翻译
  custom: 'custom',
  chromeTranslator: 'chromeTranslator', // Chrome 内置翻译 API
};

export function defaultServiceForBrowser(): string {
  return services.google;
}

export function supportedServiceForBrowser(service: string): string {
  return import.meta.env.FIREFOX && service === services.chromeTranslator
    ? services.google
    : service;
}

export const servicesType = {
  // 阵营划分
  machine: new Set([services.chromeTranslator, services.google]),
  // 需要 token
  useToken: new Set([services.custom]),
  // 需要 model
  useModel: new Set([services.custom]),
  // 支持自定义 URL 的服务
  useCustomUrl: new Set([services.custom]),

  isMachine: (service: string) => servicesType.machine.has(service),
  isUseToken: (service: string) => servicesType.useToken.has(service),
  isUseModel: (service: string) => servicesType.useModel.has(service),
  isCustom: (service: string) => service === services.custom,
  isUseCustomUrl: (service: string) => servicesType.useCustomUrl.has(service),
};

export const customModelString = '自定义模型';

/**
 * Migrate legacy `customModel[service]` entries into `model[service]` so
 * users who previously chose "自定义模型" keep their typed model name.
 */
export function migrateCustomModels(cfg: {
  model?: Record<string, string>;
  customModel?: Record<string, string>;
}): boolean {
  if (!cfg.model || typeof cfg.model !== 'object') cfg.model = {};
  if (!cfg.customModel || typeof cfg.customModel !== 'object') return false;
  let changed = false;
  for (const service of new Set([...Object.keys(cfg.model), ...Object.keys(cfg.customModel)])) {
    const current = cfg.model[service];
    const legacy = cfg.customModel[service];
    if (current === customModelString || (!current && legacy)) {
      cfg.model[service] = legacy || '';
      if (legacy !== undefined) delete cfg.customModel[service];
      changed = true;
    } else if (legacy !== undefined) {
      delete cfg.customModel[service];
      changed = true;
    }
  }
  return changed;
}

export const options = {
  on: [
    { value: true, label: '开启' },
    { value: false, label: '关闭' },
  ],
  // 是否即时翻译
  autoTranslate: [
    { value: true, label: '开启' },
    { value: false, label: '关闭' },
  ],
  // 是否使用缓存
  useCache: [
    { value: true, label: '开启' },
    { value: false, label: '关闭' },
  ],
  form: [{ value: 'auto', label: '自动检测' }],
  to: [
    { value: 'zh-Hans', label: '中文' },
    { value: 'en', label: '英语' },
    { value: 'ja', label: '日语' },
    { value: 'ko', label: '韩语' },
    { value: 'fr', label: '法语' },
    { value: 'ru', label: '俄语' },
  ],
  keys: [
    { value: 'none', label: '关闭' },

    { value: 'Computer', label: '按住按键 + 鼠标悬停', disabled: true },
    { value: 'Control', label: 'Ctrl 键' },
    { value: 'Alt', label: 'Alt / Option 键' },
    { value: 'Shift', label: 'Shift 键' },
    { value: 'Escape', label: 'Esc 键' },
    { value: '`', label: '~ 波浪号键' },

    { value: 'mouse', label: '鼠标点击段落', disabled: true },
    { value: 'DoubleClick', label: '鼠标双击段落' },
    { value: 'LongPress', label: '鼠标长按段落' },
    { value: 'MiddleClick', label: '鼠标中键（按滚轮）' },

    { value: 'touchscreen', label: '触屏手势', disabled: true },
    { value: 'TwoFinger', label: '双指轻触' },
    { value: 'ThreeFinger', label: '三指轻触' },
    { value: 'FourFinger', label: '四指轻触' },
    { value: 'DoubleClickScree', label: '双击屏幕' },
    { value: 'TripleClickScree', label: '三击屏幕' },

    { value: 'custom', label: '自定义按键…' },
  ],
  services: [
    // 传统机器翻译
    { value: 'machine', label: '开箱即用', disabled: true },
    { value: services.chromeTranslator, label: 'Chrome 内置翻译' },
    { value: services.google, label: 'Google 翻译' },
    // 大模型翻译
    { value: 'ai', label: 'AI 大模型', disabled: true },
    { value: services.custom, label: '自定义 AI 接口' },
  ],
  display: [
    { value: 0, label: '仅显示译文' },
    { value: 1, label: '双语对照' },
  ],
  // 双语翻译样式
  styles: [
    // 基础样式
    { value: 'basic', label: '基础样式', disabled: true },
    { value: 0, label: '朴素模式', class: 'fluent-display-default', group: 'basic' },
    { value: 1, label: '加粗显示', class: 'fluent-display-bold', group: 'basic' },
    { value: 2, label: '优雅斜体', class: 'fluent-display-italic', group: 'basic' },
    { value: 3, label: '立体阴影', class: 'fluent-display-text-shadow', group: 'basic' },

    // 下划线系列
    { value: 'underline', label: '下划线系列', disabled: true },
    { value: 4, label: '蓝色实线', class: 'fluent-display-solid-underline', group: 'underline' },
    { value: 5, label: '优雅虚线', class: 'fluent-display-dot-underline', group: 'underline' },
    { value: 6, label: '活泼波浪', class: 'fluent-display-wavy', group: 'underline' },

    // 卡片系列
    { value: 'card', label: '卡片系列', disabled: true },
    { value: 7, label: '简约卡片', class: 'fluent-display-card-mode', group: 'card' },
    { value: 8, label: '渐变卡片', class: 'fluent-display-modern-card', group: 'card' },
    { value: 9, label: '纸张卡片', class: 'fluent-display-paper', group: 'card' },

    // 高亮系列
    { value: 'highlight', label: '高亮系列', disabled: true },
    { value: 10, label: '学习标记', class: 'fluent-display-learning-mode', group: 'highlight' },
    { value: 11, label: '荧光标记', class: 'fluent-display-marker', group: 'highlight' },
    { value: 12, label: '柔和渐变', class: 'fluent-display-highlight-fade', group: 'highlight' },

    // 背景色系列
    { value: 'background', label: '背景色系列', disabled: true },
    { value: 13, label: '温暖黄底', class: 'fluent-display-lightyellow', group: 'background' },
    { value: 14, label: '清新蓝底', class: 'fluent-display-lightblue', group: 'background' },
    { value: 15, label: '素雅灰底', class: 'fluent-display-lightgray', group: 'background' },

    // 特殊效果
    { value: 'special', label: '特殊效果', disabled: true },
    { value: 16, label: '典雅引用', class: 'fluent-display-quote', group: 'special' },
    { value: 17, label: '轻巧边框', class: 'fluent-display-border', group: 'special' },
    { value: 18, label: '阅读焦点', class: 'fluent-display-focus', group: 'special' },
    { value: 19, label: '简约底线', class: 'fluent-display-clean', group: 'special' },

    // 专业样式
    { value: 'pro', label: '专业样式', disabled: true },
    { value: 20, label: '代码风格', class: 'fluent-display-tech', group: 'pro' },
    { value: 21, label: '书籍风格', class: 'fluent-display-elegant', group: 'pro' },

    // 透明度
    { value: 'transparent', label: '透明效果', disabled: true },
    { value: 22, label: '半透明弱化', class: 'fluent-display-dimmed', group: 'transparent' },
    {
      value: 23,
      label: '轻透明感',
      class: 'fluent-display-transparent-mode',
      group: 'transparent',
    },
  ],
  // 悬浮球快捷键选项
  floatingBallHotkeys: [
    { value: 'none', label: '关闭' },
    { value: 'Alt+T', label: 'Alt + T（默认）' },
    { value: 'Alt+A', label: 'Alt + A' },
    { value: 'Alt+S', label: 'Alt + S' },
    { value: 'Alt+D', label: 'Alt + D' },
    { value: 'Alt+Q', label: 'Alt + Q' },
    { value: 'Ctrl+Shift+T', label: 'Ctrl + Shift + T' },
    { value: 'Ctrl+Shift+A', label: 'Ctrl + Shift + A' },
    { value: 'F9', label: 'F9' },
    { value: 'F10', label: 'F10' },
    { value: 'F11', label: 'F11' },
    { value: 'F12', label: 'F12' },
    { value: 'custom', label: '自定义快捷键…' },
  ],
  theme: [
    { value: 'auto', label: '跟随系统' },
    { value: 'light', label: '浅色模式' },
    { value: 'dark', label: '深色模式' },
  ],
};

export const defaultOption = {
  on: true,
  from: 'auto',
  to: 'zh-Hans',
  style: 1,
  display: 1,
  hotkey: 'Control',
  service: defaultServiceForBrowser(),
  custom: 'http://localhost:11434/v1/chat/completions',
  system_role: 'You are a professional, authentic machine translation engine.',
  user_role: `Translate the following text into {{to}}, If translation is unnecessary (e.g. proper nouns, codes, etc.), return the original text. NO explanations. NO notes:

{{origin}}`,
  count: 0,
  useCache: true,
  floatingBallHotkey: 'Alt+T', // 默认悬浮球快捷键
};
