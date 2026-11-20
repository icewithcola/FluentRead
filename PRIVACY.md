# Privacy Policy for Catgirl Read (喵喵阅读)

Last updated: September 7, 2026

Catgirl Read is a client-side browser extension. It does not contain analytics, advertising, tracking, or telemetry, and it does not send data to a server operated by the extension developer.

When you request a translation, the extension sends the text to the translation provider you select. The Google Translate option sends the requested text to Google Translate. The Custom API option sends the requested text and its API credential to the OpenAI-compatible endpoint that you configure. Page titles may be included as translation context. If you enable page summaries, relevant page text is sent to that same configured endpoint to generate the summary. These transmissions are necessary to provide translation and summary features.

Firefox builds require HTTPS for remote custom endpoints. Plain HTTP is accepted only for loopback endpoints on the same device, such as `localhost` or `127.0.0.1`.

Settings, custom API credentials, translation results, and optional page summaries are stored in the browser's local extension storage. Translation caches expire after one month without use and can be disabled or cleared in the extension. Firefox builds do not run in private windows.

The selected translation provider processes transmitted data under its own privacy policy. Users should review the policy of the provider or custom endpoint they choose. Uninstalling the extension removes its browser-managed local storage according to the browser's normal extension-removal behavior.
