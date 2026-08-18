> [中文](https://github.com/icewithcola/FluentRead/blob/main/README.md) | English

<p align="center">
  <img src="../public/icon/512.png" alt="Catgirl Read translator icon" width="160">
</p>

<h1 align="center">Catgirl Read ᓚ₍ ^. .^₎</h1>

<p align="center">
  <strong>Your cozy bilingual reading companion, nya~</strong><br>
  Turn unfamiliar pages into an easy, natural reading flow.
</p>

<p align="center">
  <a href="https://fluent.thinkstu.com/">Documentation</a> ·
  <a href="https://fluent.thinkstu.com/guide/getting-started">Get the extension</a> ·
  <a href="https://github.com/icewithcola/FluentRead">GitHub</a>
</p>

Catgirl Read is an open-source browser translation extension. It translates a web page or selected text into bilingual or translation-only output, making foreign-language reading easier.

Whether you are reading papers, technical docs, or simply wandering the web, it helps every page feel a little more like home.

1. [Official Documentation (Must Read)](https://fluent.thinkstu.com/)
2. [Bilibili Video Introduction](https://www.bilibili.com/video/BV1ux4y1e73x/)
3. [Deepwiki Architecture Introduction](https://deepwiki.com/icewithcola/FluentRead)

## ✨ What it can do today

- **Three translation routes**: Built-in Google Translate (bilingual mode), Chrome's built-in Translation API, and a configurable OpenAI-compatible Chat Completions endpoint. The custom route supports a URL, API key, model, prompt templates, and SSE streaming.
- **Translate and restore whole pages**: Use the floating button, a shortcut, or the context menu to translate a page, then restore its original content without reloading.
- **Bilingual or translation-only output**: Keep the source text with its translation or replace it with the translation; bilingual mode includes several display styles.
- **Selection translation**: Select text and hover the indicator that appears to open its translation. It supports bilingual/translation-only display, copying the translation, and browser text-to-speech for either text.
- **Reading controls**: Configure the target language, shortcuts, floating button visibility and position, theme, animations, cache, translation concurrency, and progress panel. Settings can also be exported and imported.
- **Context enhancement**: When translating a full page with the custom endpoint, you can optionally generate a page summary and include it as translation context.
- **Local settings, provider-bound requests**: Extension settings and translation cache stay in the browser. Text to translate is sent to the translation service you choose, so use it in accordance with that provider's privacy policy.

> **Service scope:** This project does not ship separate built-in adapters for Microsoft, DeepL, DeepSeek, Kimi, Ollama, or other providers. A provider with an OpenAI-compatible Chat Completions endpoint can be connected through **Custom endpoint**. Chrome's built-in Translation API is available only in Chrome versions that support it (the current code requires Chrome 138 or later); use Google Translate or a custom endpoint in other browsers.

<p align="center"><em>Original and translation, curled up together ✨</em></p>
<kbd><img src="../misc/sample-git-1.gif" alt="sample-git-1.gif" style="width: 80%; max-width: 100%;border: 1px solid black;"></kbd>

<p align="center"><em>Full-page translation with a graceful little stretch 🐾</em></p>
<kbd><img src="../misc/sample-git-4.gif" alt="sample-git-4.gif" style="width: 80%; max-width: 100%;border: 1px solid black;"></kbd>

## 🐾 Take Catgirl Read home

| Browser | Installation Method |
|---------|-------------------|
| Chrome | [Chrome Web Store](https://chromewebstore.google.com/detail/%E6%B5%81%E7%95%85%E9%98%85%E8%AF%BB/djnlaiohfaaifbibleebjggkghlmcpcj?hl=zh-CN&authuser=0) \| [Domestic Mirror](https://www.crxsoso.com/webstore/detail/djnlaiohfaaifbibleebjggkghlmcpcj) |
| Edge | [Edge Add-ons Store](https://microsoftedge.microsoft.com/addons/detail/%E6%B5%81%E7%95%85%E9%98%85%E8%AF%BB/kakgmllfpjldjhcnkghpplmlbnmcoflp?hl=zh-CN) |
| Firefox | [Firefox Add-ons Store](https://addons.mozilla.org/zh-CN/firefox/addon/%E6%B5%81%E7%95%85%E9%98%85%E8%AF%BB/) |

## 📖 The catgirl handbook

Want to get to know Catgirl Read better? Visit the [documentation](https://fluent.thinkstu.com/) for:
- Feature Introduction
- Configuration Guide
- User Tutorial
- FAQ

## 🙏 Thanks to FluentRead

Catgirl Read is forked from [FluentRead](https://github.com/Bistutu/FluentRead). Many thanks to its authors and community for the strong foundation and their continued work on open-source translation tools.
