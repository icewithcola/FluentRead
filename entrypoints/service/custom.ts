import { commonMsgTemplate } from '../utils/template';
import { method } from '../utils/constant';
import { services } from '@/entrypoints/utils/option';
import { config } from '@/entrypoints/utils/config';
import { contentPostHandler, sanitizeStreamPreview } from '@/entrypoints/utils/check';
import { cloudflareFailureMessage } from '@/entrypoints/utils/cloudflareError';
import { assertSecureFirefoxEndpoint, firefoxRedirectMode } from '@/entrypoints/utils/network';
import {
  isOpenAiResponseTruncated,
  openAiEndpointCandidates,
  openAiRequestBody,
  openAiResponseText,
  type OpenAiEndpointSettings,
  type OpenAiRequest,
} from '@/entrypoints/utils/openai';

function requestCustomEndpoint(
  url: string,
  token: string,
  request: OpenAiRequest,
  signal?: AbortSignal,
): Promise<Response> {
  assertSecureFirefoxEndpoint(url);
  return fetch(url, {
    method: method.POST,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: openAiRequestBody(url, request),
    signal,
    redirect: firefoxRedirectMode(),
  });
}

async function custom(message: any, signal?: AbortSignal) {
  // Read page summary and structural context from message (passed from content script)
  const pageSummary = config.enablePageSummary ? message.pageSummary || undefined : undefined;
  const pageContext = typeof message.context === 'string' ? message.context : undefined;

  if (config.debugMode) {
    console.log(
      '[Catgirl Read Debug] custom() - translating:',
      message.origin?.slice(0, 100),
      '| pageContext:',
      !!pageContext,
      '| pageSummary injected:',
      !!pageSummary,
    );
    if (pageSummary) {
      console.log('[Catgirl Read Debug] custom() - pageSummary preview:', pageSummary.slice(0, 200));
    }
  }

  const request = commonMsgTemplate(message.origin, pageSummary, pageContext);
  const resp = await requestCustomEndpoint(
    config.custom,
    config.token[services.custom],
    request,
    signal,
  );

  if (!resp.ok) {
    const body = await resp.text();
    console.log('翻译失败：', resp);
    throw failedResponseError(resp, body);
  }

  return readCustomResponse(resp, request.stream ? message._port : undefined, signal);
}

export async function testCustomEndpoint({ url, token, model, stream }: OpenAiEndpointSettings) {
  const candidates = openAiEndpointCandidates(url);
  assertSecureFirefoxEndpoint(url);
  if (!model || !token) throw new Error('请先填写 API Key 和模型');

  const request: OpenAiRequest = {
    model,
    messages: [{ role: 'user', content: 'Reply with only the word OK.' }],
    temperature: 0.3,
    stream: stream || undefined,
  };
  const signal = AbortSignal.timeout(20_000);
  let httpError: string | undefined;
  let requestError: string | undefined;

  for (const candidate of candidates) {
    try {
      const resp = await requestCustomEndpoint(candidate, token, request, signal);
      if (!resp.ok) {
        const body = await resp.text();
        const detail = extractResponseErrorMessage(body);
        const failure = cloudflareFailureMessage(body, resp.headers, resp.status) ??
          (detail ? `HTTP ${resp.status}：${detail}` : `HTTP ${resp.status} ${resp.statusText}`.trim());
        if (![404, 405, 501].includes(resp.status)) httpError ??= failure;
        requestError ??= failure;
        continue;
      }
      if (await readCustomResponse(resp, undefined, signal)) return candidate;
      requestError ??= '接口未返回翻译内容，请检查模型是否可用';
    } catch (error) {
      if (signal.aborted) throw new Error('连接超时，请检查网络或 API 地址');
      requestError ??= error instanceof SyntaxError
        ? '接口返回格式无法识别，请检查 API 地址是否正确'
        : error instanceof Error ? error.message : String(error);
    }
  }

  throw new Error(httpError ?? requestError ?? '接口未返回翻译内容，请检查模型是否可用');
}

async function readCustomResponse(resp: Response, port?: any, signal?: AbortSignal): Promise<string> {
  const contentType = resp.headers.get('content-type') || '';
  if (port && !contentType.includes('application/json')) {
    return parseStreamResponse(resp, port, signal);
  }

  const responseText = await resp.text();
  throwIfCloudflareErrorPage(responseText, resp);

  if (contentType.includes('text/event-stream') || /^(data:|event:|:)/.test(responseText.trimStart())) {
    return parseSSEText(responseText);
  }

  const parsed = JSON.parse(responseText);
  if (isOpenAiResponseTruncated(parsed)) {
    throw new Error('翻译结果超出模型输出长度上限而被截断');
  }
  const result = openAiResponseText(parsed);
  if (!result) throw new Error('接口未返回翻译内容，请检查模型是否可用');
  return contentPostHandler(result);
}

function extractResponseErrorMessage(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return '';
  try {
    const parsed = JSON.parse(trimmed);
    const msg = parsed?.error?.message || parsed?.message || parsed?.error_msg || parsed?.detail;
    if (typeof msg === 'string' && msg.trim()) return msg.trim();
  } catch {
    // Non-JSON response body; fall back to plain text below.
  }
  if (/^\s*</.test(trimmed)) return '';
  return trimmed.length > 140 ? `${trimmed.slice(0, 140)}…` : trimmed;
}

function failedResponseError(resp: Response, body: string): Error {
  const cfMessage = cloudflareFailureMessage(body, resp.headers, resp.status);
  if (cfMessage) return new Error(cfMessage);
  const detail = extractResponseErrorMessage(body) || resp.statusText;
  return new Error(
    detail ? `翻译失败（HTTP ${resp.status}）：${detail}` : `翻译失败（HTTP ${resp.status}）`,
  );
}

function throwIfCloudflareErrorPage(body: string, resp: Response): void {
  const message = cloudflareFailureMessage(body, resp.headers, resp.status);
  if (message) throw new Error(message);
}

/**
 * Parse an SSE text body (already fully read) and extract the translated content.
 * Used when the API returns SSE stream data but we don't have a Port for real-time updates.
 */
function parseSSEText(text: string): string {
  let result = '';
  for (const line of text.split('\n')) {
    result += openAiStreamDelta(line);
  }

  if (!result) {
    throw new Error('未收到翻译内容，可尝试在设置中关闭“边译边显”后重试');
  }
  return contentPostHandler(result);
}

function openAiStreamDelta(line: string): string {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) return '';
  const data = trimmed.slice(5).trim();
  if (!data || data === '[DONE]') return '';

  let event;
  try {
    event = JSON.parse(data);
  } catch (error) {
    console.warn('SSE chunk parse error:', error);
    return '';
  }

  if (event?.type === 'error' || event?.type === 'response.failed') {
    throw new Error(event.message || event.response?.error?.message || '接口返回错误，请稍后重试');
  }
  if (
    event?.choices?.[0]?.finish_reason === 'length' ||
    event?.type === 'response.incomplete' ||
    event?.response?.status === 'incomplete'
  ) {
    throw new Error('翻译结果超出模型输出长度上限而被截断');
  }
  const delta = event?.type === 'response.output_text.delta'
    ? event.delta
    : event?.choices?.[0]?.delta?.content;
  return typeof delta === 'string' ? delta : '';
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException('The user aborted a request.', 'AbortError');
}

/**
 * Parse an SSE (Server-Sent Events) streaming response from an OpenAI-compatible API.
 * Sends each content delta to the content script via Port for real-time DOM updates.
 * Returns the full accumulated translated text.
 */
async function parseStreamResponse(resp: Response, port: any, signal?: AbortSignal): Promise<string> {
  const contentType = resp.headers.get('content-type') || '';
  if (
    contentType.includes('text/html') ||
    resp.headers.get('cf-error-type') ||
    resp.headers.get('cf-mitigated')
  ) {
    const body = await resp.text();
    throwIfCloudflareErrorPage(body, resp);
    throw new Error('未收到翻译内容，可尝试在设置中关闭“边译边显”后重试');
  }

  const reader = resp.body?.getReader();
  if (!reader) {
    throw new Error('无法读取接口响应流，可尝试在设置中关闭“边译边显”后重试');
  }

  const onAbort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();

  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let result = '';
  // Keep enough of the raw body to recognize a Cloudflare error page if the
  // stream never yields SSE deltas (wrong content-type, or CF HTML mid-flight).
  let rawPrefix = '';
  const rawPrefixLimit = 48 * 1024;
  const appendRaw = (chunk: string) => {
    if (rawPrefix.length >= rawPrefixLimit) return;
    rawPrefix += chunk.slice(0, rawPrefixLimit - rawPrefix.length);
  };

  try {
    while (true) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      throwIfAborted(signal);

      const chunk = done ? decoder.decode() : decoder.decode(value, { stream: true });
      appendRaw(chunk);
      buffer += chunk;

      // Process complete SSE lines
      const lines = buffer.split('\n');
      // Keep the last potentially incomplete line in the buffer
      if (!done) buffer = lines.pop() || '';

      for (const line of lines) {
        const delta = openAiStreamDelta(line);
        if (!delta) continue;
        result += delta;
        const preview = sanitizeStreamPreview(result);
        if (!preview) continue;
        try {
          port.postMessage({ type: 'stream-chunk', chunk: delta, accumulated: preview });
        } catch {
          throwIfAborted(signal);
          return contentPostHandler(result);
        }
      }
      if (done) break;
    }

    throwIfAborted(signal);

    if (!result) {
      throwIfCloudflareErrorPage(rawPrefix, resp);
      throw new Error('未收到翻译内容，可尝试在设置中关闭“边译边显”后重试');
    }

    return contentPostHandler(result);
  } finally {
    signal?.removeEventListener('abort', onAbort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export default custom;
