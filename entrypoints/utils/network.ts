/** Enforce Mozilla's encrypted-transport policy without restricting Chrome builds. */
export function assertSecureFirefoxEndpoint(endpoint: string): void {
  if (!import.meta.env.FIREFOX) return;

  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error('接口地址无效');
  }

  const isLoopback =
    url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback)) {
    throw new Error('Firefox 仅允许 HTTPS 远程接口（本机 localhost 接口除外）');
  }
}

export function firefoxRedirectMode(): RequestRedirect | undefined {
  // A 307/308 redirect can forward translated content and credentials to an
  // undeclared host, so Firefox requests must fail instead of following it.
  return import.meta.env.FIREFOX ? 'error' : undefined;
}
