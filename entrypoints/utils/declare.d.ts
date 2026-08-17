declare module 'entrypoints/utils/declare';
declare module 'js-beautify';

interface ChromeRuntimeApi {
  getContexts?: (options: { contextTypes: string[] }) => Promise<unknown[]>;
  getURL: (path: string) => string;
  readonly lastError?: { message?: string };
  onMessage: {
    addListener: (
      listener: (
        message: any,
        sender: unknown,
        sendResponse: (response: unknown) => void,
      ) => boolean,
    ) => void;
  };
  sendMessage: (message: unknown, callback: (response: unknown) => void) => void;
}

interface ChromeOffscreenApi {
  createDocument: (options: {
    url: string;
    reasons: string[];
    justification: string;
  }) => Promise<void>;
}

declare const chrome: {
  runtime: ChromeRuntimeApi;
  offscreen?: ChromeOffscreenApi;
};
