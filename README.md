> [English](https://github.com/icewithcola/FluentRead/blob/main/misc/README_EN.md) | 中文

<p align="center">
  <img src="./public/icon/512.png" alt="喵喵阅读猫娘翻译助手图标" width="160">
</p>

<h1 align="center">喵喵阅读 ฅ^•ﻌ•^ฅ</h1>

<p align="center">
  <strong>让每一页外语，都有猫娘陪你轻松读懂。</strong><br>
  你的 AI 双语阅读搭子，喵～
</p>

<p align="center">
  <a href="https://fluent.thinkstu.com/">阅读文档</a> ·
  <a href="https://fluent.thinkstu.com/guide/getting-started">安装扩展</a> ·
  <a href="https://github.com/icewithcola/FluentRead">GitHub</a>
</p>

喵喵阅读（Catgirl Read）是一款开源的浏览器翻译扩展。它可将网页或选中的文本翻译为双语对照或仅译文，帮助你更轻松地阅读外语内容。

不论是论文、技术文档还是日常冲浪，都能读得像母语一样轻松自在。

1. [官方文档（必看）](https://fluent.thinkstu.com/)
2. [B站视频介绍](https://www.bilibili.com/video/BV1ux4y1e73x/)
3. [deepwiki 架构介绍](https://deepwiki.com/icewithcola/FluentRead)

## ✨ 现在能做什么

- **三种翻译方式**：内置 Google 翻译（双语模式）、Chrome 内置 Translation API，以及可配置的 OpenAI 兼容 Chat Completions 接口。自定义接口可设置 URL、API Key、模型和提示词，并支持 SSE 流式输出。
- **整页翻译与还原**：使用悬浮球、快捷键或右键菜单翻译整页；无需刷新即可还原原始页面内容。
- **双语或仅译文**：可保留原文并在其后显示译文，也可替换为仅译文；双语模式提供多种译文样式。
- **划词翻译**：选中文本后，将鼠标移到出现的指示点即可查看翻译；支持双语/仅译文显示、复制译文，以及浏览器语音朗读原文或译文。
- **阅读体验设置**：可设置目标语言、快捷键、悬浮球显示与位置、主题、动画、缓存、翻译并发数和进度面板；配置也可导入或导出。
- **上下文增强**：使用自定义接口进行全文翻译时，可选先生成页面摘要并把它作为翻译上下文。
- **本地配置，按需发送**：扩展设置和翻译缓存保存在浏览器本地。翻译文本会发送给你选择的翻译服务；请依据所选服务的隐私政策使用。

> **服务范围说明**：本项目没有 Microsoft、DeepL、DeepSeek、Kimi、Ollama 等独立内置适配器。若服务提供 OpenAI 兼容的 Chat Completions 接口，可通过“自定义接口”接入。Chrome 内置 Translation API 仅适用于支持该 API 的 Chrome（代码当前要求 Chrome 138 或更高版本）；在其他浏览器中请使用 Google 翻译或自定义接口。

## 🧭 翻译核心

全文翻译使用一套按元素管理生命周期的 DOM/翻译核心：

- DOM 扫描与翻译请求解耦，按最小可读内容单元选择节点，并自动跳过导航、隐藏内容和扩展自身 UI。
- 每个节点都有独立的 pending、translating、translated、failed 状态；动态页面新增内容会被增量观察，不会重复扫描已处理内容。
- 翻译请求支持并发限制、超时、重试和取消。停止翻译或还原页面后，迟到的普通响应和流式响应都不会再次写入页面。
- 还原时保留页面元素身份和原始子节点，尽量保留网站绑定的事件监听器；译文 HTML 也会经过标签、属性和 URL 安全过滤。

<p align="center"><em>原文和译文一起贴贴，阅读更轻松 ✨</em></p>
<kbd><img src="./misc/sample-git-1.gif" alt="sample-git-1.gif" style="width: 80%; max-width: 100%;border: 1px solid black;"></kbd>

<p align="center"><em>整页翻译，也要优雅地伸个懒腰 🐾</em></p>
<kbd><img src="./misc/sample-git-4.gif" alt="sample-git-4.gif" style="width: 80%; max-width: 100%;border: 1px solid black;"></kbd>

<p align="center"><em>轻轻划一下，译文马上送到 ✂️</em></p>
<kbd><img src="./misc/highlight_trans.png" alt="sample-git-4.gif" style="width: 80%; max-width: 100%;border: 1px solid black;"></kbd>

## 🐾 把喵喵阅读带回家

| 浏览器 | 安装方式 |
|-------|---------|
| Chrome | [Chrome 应用商店](https://chromewebstore.google.com/detail/%E6%B5%81%E7%95%85%E9%98%85%E8%AF%BB/djnlaiohfaaifbibleebjggkghlmcpcj?hl=zh-CN&authuser=0) \| [国内镜像](https://www.crxsoso.com/webstore/detail/djnlaiohfaaifbibleebjggkghlmcpcj) |
| Edge | [Edge 应用商店](https://microsoftedge.microsoft.com/addons/detail/%E6%B5%81%E7%95%85%E9%98%85%E8%AF%BB/kakgmllfpjldjhcnkghpplmlbnmcoflp?hl=zh-CN) |
| Firefox | [Firefox 附加组件商店](https://addons.mozilla.org/zh-CN/firefox/addon/%E6%B5%81%E7%95%85%E9%98%85%E8%AF%BB/) |

## 🛠️ 开发者的小工坊

```bash
# 安装依赖
bun install

# 开发模式（热重载）
bun run dev

# 生产构建
bun run build

# 类型检查
bun run compile

# Debug 构建（无混淆，带 sourcemap，方便调试）
bun run build:debug

# Firefox 构建
bun run build:firefox

# 打包 zip
bun run zip
```

## 📖 猫娘使用手册

想和喵喵阅读更熟一点？请访问 [官方文档](https://fluent.thinkstu.com/) 获取详细的：
- 功能介绍
- 配置指南
- 使用教程
- 常见问题

## 🙏 致谢

喵喵阅读 fork 自 [FluentRead](https://github.com/Bistutu/FluentRead)。感谢 FluentRead 的作者与社区打下坚实基础，并持续推动开源翻译工具的发展。
