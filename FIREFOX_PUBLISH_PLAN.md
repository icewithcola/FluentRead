# 喵喵阅读 (FluentRead) Firefox 发布与 AMO 上架完整规划方案

本文档基于 Mozilla 官方扩展审核指南（AMO Review Policies）、WebExtension 规范及最新数据安全要求（Data Collection Permissions），针对 **喵喵阅读 (FluentRead)** 项目整理出的完整发布与上架改造规划。

---

## 目录
1. [项目现状与改造目标](#一项目现状与改造目标)
2. [Manifest 与 WXT 构建配置改造](#二manifest-与-wxt-构建配置改造)
3. [代码兼容性与运行环境适配](#三代码兼容性与运行环境适配)
4. [Mozilla 安全策略与代码审核合规 (AMO Policies)](#四mozilla-安全策略与代码审核合规-amo-policies)
5. [AMO 商店上架信息与物料准备 (Listing Metadata)](#五amo-商店上架信息与物料准备-listing-metadata)
6. [源码包提交规范与审阅者构建指南 (Reviewer Notes)](#六源码包提交规范与审阅者构建指南-reviewer-notes)
7. [端到端上架操作检查清单 (Checklist)](#七端到端上架操作检查清单-checklist)

---

## 一、项目现状与改造目标

### 1.1 项目现状分析
- **框架体系**：基于 WXT 0.20 + Vue 3 + TypeScript + Element Plus + Bun。
- **构建输出**：当前 `bun run build:firefox` 默认输出为 `firefox-mv2`，且缺少 Firefox 专属的 `browser_specific_settings` 配置。
- **Linter 检验现状**：使用 Mozilla 官方 `addons-linter` 检测发现以下关键项：
  1. `MISSING_ADDON_ID`：缺少 Gecko Add-on ID（Firefox MV3 强制要求，MV2 强烈建议）。
  2. `MISSING_DATA_COLLECTION_PERMISSIONS`：缺少 Mozilla 2025 强制要求的内建数据收集声明。
  3. `MANIFEST_PERMISSIONS`：Manifest 中包含 Chrome 特有的 `'offscreen'` 权限（Firefox 不支持）。
  4. `UNSUPPORTED_API`：`entrypoints/service/chrome-translator.ts` 中引用了 `chrome.offscreen`。
  5. 默认服务配置：`defaultOption.service` 默认为 `chromeTranslator`，在 Firefox 环境下初次安装即报错。
  6. 源码审阅要求：由于使用 Vite/WXT 打包和压缩，AMO 审核**必须提交未压缩的完整源代码包**。

### 1.2 改造目标
1. **0 错误**通过 Mozilla `addons-linter` 静态检测，并在审核说明中解释框架与已净化 DOM 写入产生的非阻断警告。
2. Chrome 保持 **Manifest V3 (MV3)**，Firefox 使用 WXT 当前稳定支持的 **Manifest V2 (MV2)** 默认目标。
3. 保证 Firefox 用户在“开箱即用”状态下具备正确的默认翻译引擎与降级机制。
4. 准备好符合 AMO 规范的商店物料、隐私政策（Privacy Policy）及审阅者说明（Notes to Reviewers）。

---

## 二、Manifest 与 WXT 构建配置改造

### 2.1 构建目标：按浏览器保留各自稳定目标
Chrome 继续使用 MV3、Offscreen API 与内置 Translation API。Firefox 继续使用 WXT 默认的 MV2 目标；这不会影响 AMO 提交，也避免改变现有 Firefox 开发与后台运行方式。

#### 需要在 `package.json` 中调整的构建脚本：
```json
{
  "scripts": {
    "dev:firefox": "wxt -b firefox",
    "build:firefox": "wxt build -b firefox",
    "zip:firefox": "wxt zip -b firefox"
  }
}
```

### 2.2 `wxt.config.ts` 动态 Manifest 适配规划
需利用 WXT 的 `manifest: ({ browser }) => ({ ... })` 函数，根据目标浏览器动态生成差异化配置：

```typescript
// wxt.config.ts 改造规划结构示例
export default defineConfig({
  modules: ['@wxt-dev/webextension-polyfill'],
  // ... 其他 vite 配置
  manifest: ({ browser }) => {
    const isFirefox = browser === 'firefox';

    // 1. 基础权限配置
    const permissions = isFirefox
      ? ['storage', 'contextMenus', 'unlimitedStorage'] // 移除 offscreen
      : ['storage', 'contextMenus', 'offscreen', 'unlimitedStorage'];

    // 2. 主机权限 (MV3 下 background fetch 跨域请求需要 host_permissions)
    const host_permissions = [
      '<all_urls>', // 允许请求用户自定义 AI API 与 Google Translate
    ];

    // 3. Firefox 专有设置 (Gecko Specific Settings)
    const browser_specific_settings = isFirefox
      ? {
          gecko: {
            // 必须：指定唯一 Add-on ID（格式为 email 样式或 GUID）
            id: 'catgirl-read@icewithcola.github.io',
            // Firefox 140 起支持 Mozilla 内建数据传输同意界面
            strict_min_version: '140.0',
            // 必须：Mozilla 2025 数据收集声明 (Data Collection Permissions)
            data_collection_permissions: {
              required: ['websiteContent', 'authenticationInfo'],
            },
          },
        }
      : undefined;

    return {
      name: '喵喵阅读',
      description: '一款 AI 驱动的开源浏览器翻译插件，带来母语般的双语阅读体验',
      permissions,
      host_permissions,
      browser_specific_settings,
      web_accessible_resources: [
        {
          resources: ['icon/*.png'],
          matches: ['<all_urls>'],
        },
      ],
    };
  },
});
```

### 2.3 关键字段详解与合规说明

| 字段 | 设定值 | 说明 |
| :--- | :--- | :--- |
| `gecko.id` | `catgirl-read@icewithcola.github.io` | AMO 签名、扩展更新与存储隔离使用的稳定标识。首次发布后不得随意更改。 |
| `gecko.strict_min_version` | `"140.0"` | Firefox Desktop 140 起使用 Mozilla 内建数据传输同意界面。Android 最低版本单独设为 142。 |
| `gecko.data_collection_permissions` | `{"required": ["websiteContent", "authenticationInfo"]}` | 声明翻译文本以及自定义接口凭证会发送给用户选择的翻译提供商。 |
| `permissions` | 剔除 `'offscreen'` | Firefox 暂不支持 Offscreen API，声明会导致 Linter 报错。 |
| `host_permissions` | `["<all_urls>"]` | WXT 在 Firefox MV2 输出中将其转换为 `permissions`，供后台请求 Google Translate 与用户配置的接口。 |

---

## 三、代码兼容性与运行环境适配

### 3.1 默认翻译引擎的智能环境适配
**问题发现**：
当前 `entrypoints/utils/option.ts` 中的 `defaultOption.service` 硬编码为 `services.chromeTranslator`。在 Firefox 下，由于没有 Chrome 内置 AI 翻译接口，新用户安装后首次使用会直接报错抛出异常。

**规划改造方案**：
1. **环境检测工具函数**：
   编写运行时检测方法（如 `isFirefox()` 或检测 `typeof chrome !== 'undefined' && !!chrome.offscreen`）。
2. **动态默认值**：
   - Chrome 环境：默认 `services.chromeTranslator`（或自定义）。
   - Firefox 环境：默认 `services.google`（免配置开箱即用）或 `services.custom`。
3. **配置加载兼容**：
   在 `entrypoints/utils/config.ts` 初始化时，若检测为 Firefox 且当前服务为 `chromeTranslator`，自动平滑回退至 `services.google`。

### 3.2 设置弹窗 UI 选项过滤
**问题发现**：
在 Firefox 中打开 Popup 弹窗时，服务商列表中仍会显示“Chrome内置AI翻译⭐”。

**规划改造方案**：
在 `components/Main.vue` 的 `compute.filteredServices` 中：
- 当运行在 Firefox 环境下时，在下拉列表过滤掉 `services.chromeTranslator`，避免用户误选后导致翻译失败。

### 3.3 Chrome 专属模块的条件隔离
- **`entrypoints/service/chrome-translator.ts`**：
  保持现有的 `if (!chrome.offscreen)` 防御，并在调用入口（`_service.ts` 或 `background.ts`）做环境熔断，防止非 Chromium 内核触发无意义的消息通信。

---

## 四、Mozilla 安全策略与代码审核合规 (AMO Policies)

Mozilla 对 AMO 上架代码有严格的安全与隐私审查规则。以下是审核核心要点及应对规划：

### 4.1 动态 HTML 渲染与 XSS 防护 (`innerHTML`)
- **现状**：Linter 扫描到 17 处 `UNSAFE_VAR_ASSIGNMENT`（主要集中在 `entrypoints/main/trans.ts`、`entrypoints/main/dom.ts` 与部分站点兼容脚本中）。
- **审查规则**：Mozilla 要求所有插入到 DOM 中的动态内容必须确保安全性，严禁将未转义的网络数据或用户输入直接通过 `innerHTML` 插入页面。
- **合规规划**：
  1. 纯文本翻译内容建议优先使用 `textContent` 或 `document.createTextNode`。
  2. 双语对照的 HTML 结构包装：确保对 AI 返回的文本内容进行 HTML 转义（Escape）后再组装模板。
  3. 富文本/站点适配恢复逻辑：在提交给 AMO 的“审阅者附注（Notes to Reviewers）”中详细解释 DOM 双语节点结构替换的实现原理及安全性保障。

### 4.2 严禁远程代码执行与动态代码评估 (No Remote Code & Eval)
- **审查规则**：
  - 严禁使用 `<script src="https://...">` 动态引入外部脚本。
  - 严禁使用 `eval()`、`new Function(dynamicString)`。
- **合规规划**：
  - 本项目所有静态资源、样式、Vue 运行时与第三方库均通过 Bun 本地编译打包，符合“无远程代码”要求。
  - Linter 中出现的 vendor 库中的 `Function("return this")()` 为基础库检测 `globalThis` 的常见逻辑，在审阅者说明中注明即可。

### 4.3 隐私与数据安全合规 (Privacy Guidelines)
- **审查规则**：扩展必须明确告知用户收集了哪些数据、传输给了谁，并且不得未经用户同意收集与功能无关的浏览记录或敏感信息。
- **合规规划**：
  1. **零自建服务器数据收集**：明确扩展不包含任何统计分析（Analytics）、用户追踪（Telemetry）或广告 SDK。
  2. **API Key 本地安全存储**：用户的 OpenAI / DeepSeek / Custom API Key 保存在 `browser.storage.local`，仅在调用用户配置的接口时发送到该接口，不会发送到开发者服务器。
  3. **数据按需传输**：网页文本仅在用户主动触发（划词、悬浮球、快捷键、自动翻译）时，单向发送至用户指定的第三方（Google 翻译服务或用户配置的 OpenAI/DeepSeek 接口）。

---

## 五、AMO 商店上架信息与物料准备 (Listing Metadata)

在提交至 [Mozilla Add-on Developer Hub](https://addons.mozilla.org/developers/) 时，需提前准备以下中英文 Listing 信息：

### 5.1 基础信息

| 字段 | 建议填写内容（中文） | 建议填写内容（英文） |
| :--- | :--- | :--- |
| **扩展名称 (Name)** | 喵喵阅读 - AI 双语阅读助手 | FluentRead - AI Bilingual Reading Assistant |
| **简短摘要 (Summary)** *(≤250字符)* | 一款 AI 驱动的开源双语网页翻译扩展，支持 Google 翻译与自定义 OpenAI/DeepSeek 等大模型接口，带来母语般的沉浸式阅读体验。 | An open-source AI-powered bilingual translation extension for Firefox, supporting Google Translate and custom LLMs (OpenAI, DeepSeek, Ollama, etc.). |
| **主要分类 (Categories)** | 语言支持 (Language Support) / 生产力工具 (Productivity) | Language Support / Productivity |
| **开源许可 (License)** | MIT License | MIT License |
| **支持网站 (Support Website)** | `https://fluent.thinkstu.com/` | `https://fluent.thinkstu.com/` |
| **源码仓库 (Repository)** | `https://github.com/icewithcola/FluentRead` | `https://github.com/icewithcola/FluentRead` |

### 5.2 详细描述 (Detailed Description)
建议使用 Markdown 格式包含以下核心卖点：
1. **双语沉浸对照**：保留网页原始排版，在原文下方优雅插入译文，支持波浪线、卡片、高亮、淡雅背景等多种样式。
2. **多引擎支持**：内置免配置的 Google 翻译，同时支持任意 OpenAI 兼容的 Chat Completions 接口（DeepSeek、GPT-4o、Kimi、Ollama 等）。
3. **极速流式传输**：支持 SSE 流式翻译，译文边生成边显示，无需漫长等待。
4. **多样化交互**：全文翻译悬浮球、全局自定义快捷键、划词翻译浮窗、右键菜单翻译。
5. **隐私与安全第一**：配置与缓存均存储在本地（LRU 缓存），不收集任何用户隐私数据。

### 5.3 图像与视觉资产要求

| 资产类型 | 规格要求 | 对应仓库现有资源 / 建议 |
| :--- | :--- | :--- |
| **扩展图标 (Icon)** | 16x16, 32x32, 48x48, 64x64, 128x128 PNG (透明背景) | 位于 `public/icon/` 与 `.output/firefox-mv2/icon/` |
| **界面截图 (Screenshots)** | 1280x800 或 640x400 PNG/JPEG，至少 1 张，推荐 3-5 张 | 可复用 `docs/public/` 下的截图（如双语对照效果、Popup 配置面板、悬浮球） |

### 5.4 隐私政策声明草案 (Privacy Policy)
*AMO 提交时对于请求 `<all_urls>` 的扩展强制要求提供 Privacy Policy 链接或正文。*

> **【隐私政策文本草案】**
> 
> **喵喵阅读 (FluentRead) 隐私政策**
> 1. **数据收集与存储**：喵喵阅读是一款纯客户端运行的开源浏览器扩展。本扩展不设立任何用于收集用户数据的中心化服务器，不收集、不跟踪用户的个人身份信息、浏览历史、Cookie 或设备标识。
> 2. **翻译内容处理**：当用户主动触发翻译功能（全文翻译或划词翻译）时，扩展仅提取当前需要翻译的网页文本段落，并将其直接发送至用户选定的翻译提供商（例如 Google Translate 官方接口，或用户自行配置的第三方 AI 服务商如 OpenAI、DeepSeek、自定义 API 端点）。
> 3. **API 密钥与凭证安全**：用户填写的 API Key、Token 等敏感配置数据存储于浏览器本地存储 (`browser.storage.local`) 中，仅在向用户指定的 API 发送翻译请求时作为 HTTP Header 携带，不会发送到扩展开发者的服务器。
> 4. **本地缓存**：为了提高翻译速度并减少重复 API 请求，扩展会在本地保存翻译缓存，用户可在设置中随时关闭或清理。

---

## 六、源码包提交规范与审阅者构建指南 (Reviewer Notes)

由于扩展使用了 Vue 3、TypeScript 及 Vite/WXT 构建压缩，**Mozilla 审核人员无法直接通过压缩后的 `.js` 文件完成安全审查**。必须在提交界面勾选 **"Yes, provide source code"** 并上传源码 `.zip`。

### 6.1 源码包打包规则
源码压缩包（`source-code.zip`）必须满足：
1. **包含内容**：
   - 完整的项目根目录源代码（`entrypoints/`、`components/`、`styles/`、`public/`、`wxt.config.ts`、`package.json`、`tsconfig.json`）。
   - 依赖锁定文件：**`bun.lock`**。
2. **排除内容**（减小体积并避免干扰审查）：
   - 排除 `node_modules/`
   - 排除 `.output/`
   - 排除 `.wxt/`
   - 排除 `.git/`

### 6.2 审阅者附注 (Notes to Reviewers) 标准模板
在 AMO 提交表单的 **"Information for Reviewers"** 框中，粘贴以下英文构建说明：

```markdown
### Build Instructions for Reviewers

This extension is built using WXT (Web Extension Tools) + Vite + Vue 3 + TypeScript, and uses Bun as the package manager.

#### Prerequisites
- Bun runtime (version >= 1.3.0) or Node.js (v20+) with Bun installed.

#### Steps to reproduce the build:
1. Extract the provided source code archive.
2. Open terminal in the project root directory.
3. Install dependencies from frozen lockfile:
   ```bash
   bun install --frozen-lockfile
   ```
4. Build the Firefox Manifest V2 production bundle:
   ```bash
   bun run build:firefox
   ```
   (Or package into zip via: `bun run zip:firefox`)
5. The output directory is generated at `.output/firefox-mv2/`, and the installable archive at `.output/catgirl-read-<version>-firefox.zip`.

#### Additional Notes on Permissions:
- `storage` / `unlimitedStorage`: Used solely for storing user configuration, custom API keys, and local translation LRU cache.
- `contextMenus`: Used for the right-click menu "Translate Full Page" / "Restore".
- `<all_urls>` (host_permissions & content_scripts): Required to inspect webpage text when the user requests translation, and to send translation requests via background fetch to Google Translate or the user-configured OpenAI-compatible API endpoint.
- All API keys and preferences stay strictly within local storage and are never sent to any developer-owned servers.
```

---

## 七、端到端上架操作检查清单 (Checklist)

### 阶段一：代码与配置准备
- [x] 在 `wxt.config.ts` 中配置 `browser_specific_settings.gecko`（填写 `id`、`strict_min_version`、`data_collection_permissions`）。
- [x] 在 `wxt.config.ts` 中针对 Firefox 移除 `'offscreen'` 权限，并补齐 `host_permissions`。
- [x] 调整 `entrypoints/utils/option.ts` 与 `config.ts`，为 Firefox 设置 Google 翻译默认服务和旧配置降级。
- [x] 在 `components/Main.vue` 中针对 Firefox 隐藏 Chrome 专属的翻译选项。
- [x] 保持 Chrome MV3 功能，同时生成 Firefox MV2 商店包与审核源码包。

### 阶段二：本地验证与构建
- [x] 执行类型检查：`bun run compile`。
- [x] 构建 Firefox 扩展包：`bun run build:firefox`。
- [x] 运行 Mozilla 官方 Linter 验证：
  ```bash
  bun run lint:firefox
  ```
  *当前确认为 0 errors；框架代码和已净化 DOM 写入仍有 19 个非阻断 warnings，原因记录在 `FIREFOX_REVIEWER.md`。*
- [x] 打包产物：`bun run zip:firefox`（同时生成扩展 zip 与审核源码 zip）。

### 阶段三：AMO 提交发布
- [ ] 登录 [Mozilla Add-on Developer Hub](https://addons.mozilla.org/developers/)（确保已启用双重认证 2FA）。
- [ ] 点击 **"Submit a New Add-on"** -> 选择 **"On this site"**（在 AMO 商店公开分发）。
- [ ] 上传打包好的 `.output/catgirl-read-*-firefox.zip`。
- [ ] 在源码提供选项中选择 **"Yes"** 并上传 `.output/catgirl-read-*-firefox-sources.zip`。
- [ ] 在 "Notes to Reviewers" 中填入上述第六章的构建说明。
- [ ] 完善商店页面信息：填写中英文名称、摘要、详细描述、分类、隐私政策及截图。
- [ ] 提交审核，通常初审需 1~3 个工作日。审核通过后将自动在 AMO 上架。
