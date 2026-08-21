import { commonMsgTemplate } from '../utils/template';
import { method } from '../utils/constant';
import { services } from '@/entrypoints/utils/option';
import { config } from '@/entrypoints/utils/config';
import { contentPostHandler } from '@/entrypoints/utils/check';
import { cloudflareFailureMessage } from '@/entrypoints/utils/cloudflareError';

async function custom(message: any) {
  let headers = new Headers();
  headers.append('Content-Type', 'application/json');
  headers.append('Authorization', `Bearer ${config.token[services.custom]}`);

  // Read page summary from message (passed from content script where it was generated)
  const pageSummary = config.enablePageSummary ? message.pageSummary || undefined : undefined;

  if (config.debugMode) {
    console.log(
      '[Catgirl Read Debug] custom() - translating:',
      message.origin?.slice(0, 100),
      '| pageSummary injected:',
      !!pageSummary,
    );
    if (pageSummary) {
      console.log('[Catgirl Read Debug] custom() - pageSummary preview:', pageSummary.slice(0, 200));
    }
  }

  const resp = await fetch(config.custom, {
    method: method.POST,
    headers: headers,
    body: commonMsgTemplate(message.origin, pageSummary),
  });

  if (!resp.ok) {
    const body = await resp.text();
    console.log('翻译失败：', resp);
    throw failedResponseError(resp, body);
  }

  // Streaming mode: parse SSE chunks and send via port
  if (config.useStream && message._port) {
    return await parseStreamResponse(resp, message._port);
  }

  // Non-streaming mode: parse JSON response
  // However, the API may still return SSE stream data if config.useStream is true
  // (e.g. when called via browser.runtime.sendMessage without a port).
  // Detect and handle SSE responses gracefully.
  const contentType = resp.headers.get('content-type') || '';
  const responseText = await resp.text();
  throwIfCloudflareErrorPage(responseText, resp);

  // Check if the response is SSE (text/event-stream) or starts with "data: "
  if (contentType.includes('text/event-stream') || responseText.trimStart().startsWith('data: ')) {
    return parseSSEText(responseText);
  }

  // Normal JSON response
  let result = JSON.parse(responseText);
  return contentPostHandler(result.choices[0].message.content);
}

function failedResponseError(resp: Response, body: string): Error {
  return new Error(
    cloudflareFailureMessage(body, resp.headers, resp.status) ??
      `翻译失败: ${resp.status} ${resp.statusText} body: ${body}`,
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
  const lines = text.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(':')) continue;
    if (trimmed === 'data: [DONE]') continue;

    if (trimmed.startsWith('data: ')) {
      const jsonStr = trimmed.slice(6);
      try {
        const chunk = JSON.parse(jsonStr);
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) {
          result += delta;
        }
      } catch (e) {
        console.warn('SSE chunk parse error:', e, jsonStr);
      }
    }
  }

  if (!result) {
    throw new Error('翻译失败: SSE 响应未返回有效内容');
  }
  return contentPostHandler(result);
}

/**
 * Parse an SSE (Server-Sent Events) streaming response from an OpenAI-compatible API.
 * Sends each content delta to the content script via Port for real-time DOM updates.
 * Returns the full accumulated translated text.
 */
async function parseStreamResponse(resp: Response, port: any): Promise<string> {
  const contentType = resp.headers.get('content-type') || '';
  if (
    contentType.includes('text/html') ||
    resp.headers.get('cf-error-type') ||
    resp.headers.get('cf-mitigated')
  ) {
    const body = await resp.text();
    throwIfCloudflareErrorPage(body, resp);
    throw new Error('翻译失败: 流式响应未返回有效内容');
  }

  const reader = resp.body?.getReader();
  if (!reader) {
    throw new Error('翻译失败: 无法获取响应流');
  }

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

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const chunk = decoder.decode(value, { stream: true });
    appendRaw(chunk);
    buffer += chunk;

    // Process complete SSE lines
    const lines = buffer.split('\n');
    // Keep the last potentially incomplete line in the buffer
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(':')) continue;
      if (trimmed === 'data: [DONE]') continue;

      if (trimmed.startsWith('data: ')) {
        const jsonStr = trimmed.slice(6);
        try {
          const chunkJson = JSON.parse(jsonStr);
          const delta = chunkJson.choices?.[0]?.delta?.content;
          if (delta) {
            result += delta;
            // Send each chunk to content script in real-time
            try {
              port.postMessage({ type: 'stream-chunk', chunk: delta, accumulated: result });
            } catch (e) {
              // Port may have been disconnected
              console.warn('Port disconnected, stopping stream');
              reader.cancel();
              return contentPostHandler(result);
            }
          }
        } catch (e) {
          console.warn('Stream chunk parse error:', e, jsonStr);
        }
      }
    }
  }

  appendRaw(decoder.decode());

  if (!result) {
    throwIfCloudflareErrorPage(rawPrefix, resp);
    throw new Error('翻译失败: 流式响应未返回有效内容');
  }

  return contentPostHandler(result);
}

export default custom;
