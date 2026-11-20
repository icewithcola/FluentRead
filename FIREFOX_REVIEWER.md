# Firefox reviewer build instructions

The submitted extension is built locally from TypeScript and Vue source with WXT, Vite, and Bun. The Firefox production bundle is intentionally not minified so it remains easy to review and reproduce. No remote code or web-based build tool is used.

## Environment

- Ubuntu 24.04 LTS or macOS
- Bun 1.3.13 (`package.json` requires Bun 1.3 or newer)
- Network access to the official package registry during dependency installation

Install Bun from <https://bun.sh/docs/installation> if it is not already available.

## Reproduce the submitted Firefox package

From the extracted source archive root, run:

```sh
bun install --frozen-lockfile
bun run zip:firefox
```

The uploadable extension is `.output/catgirl-read-0.5.5-firefox.zip`. WXT also creates `.output/catgirl-read-0.5.5-firefox-sources.zip`; the latter is the reviewer source archive and is not installed as an extension.

To run the same static checks used before submission:

```sh
bun run compile
bun run lint:firefox
```

The Firefox build targets Manifest V2, which is WXT's default Firefox target for this version. Chrome builds remain Manifest V3 and retain the Chrome Offscreen and built-in Translation APIs.

## Functional test

1. Temporarily load `.output/firefox-mv2/manifest.json` in `about:debugging` on Firefox Desktop 140 or later, or Firefox for Android 142 or later.
2. Open a normal web page, open the extension popup, and select Google Translate.
3. Trigger full-page or selected-text translation and verify that bilingual text appears.
4. Select Custom API to test an OpenAI-compatible endpoint. Firefox accepts HTTPS endpoints and loopback HTTP endpoints such as `http://localhost:11434`; a remote plain-HTTP endpoint is intentionally rejected.

No account is required for the Google Translate test. Custom API testing requires reviewer-provided compatible credentials and endpoint.

## Permissions and transmitted data

- `storage` and `unlimitedStorage`: local preferences, API credentials, translation cache, and optional page-summary cache.
- `contextMenus`: full-page translation and restore commands.
- `<all_urls>`: reads text on the current page and lets the background page contact Google Translate or the endpoint configured by the user.
- `websiteContent`: only text selected for translation, page titles used as translation context, and optional page text used for a user-enabled summary are sent to the selected translation provider.
- `authenticationInfo`: a custom API credential is sent only to the custom endpoint configured by the user.

The extension has no analytics, advertising, tracking, or developer-operated data collection server. Translation and page-summary results may be cached locally. The Firefox build is disabled in private windows so private-session content is not persisted.

Mozilla's linter may report `innerHTML` warnings for two reviewed cases: Vue/Element Plus rendering internals, and the translation DOM pipeline. Translation-service HTML is passed through `sanitizeTranslationHTML` before insertion; executable elements, event handlers, styles, unsafe URLs, and response-supplied attributes are removed. Other assignments restore page-authored DOM previously captured by the extension. The `Function` constructor warning comes from the unmodified release build of Element Plus/Lodash; the extension does not evaluate downloaded or user-provided code.
