import type { Config } from './model';
import { customModelString } from './option';

export interface OpenAiRequest {
  model: string;
  messages: { role: 'system' | 'user'; content: string }[];
  temperature?: number;
  stream?: boolean;
}

export interface OpenAiEndpointSettings {
  url: string;
  token: string;
  model: string;
  stream: boolean;
}

export function openAiModel(settings: Pick<Config, 'service' | 'model' | 'customModel'>): string {
  const { service, model, customModel } = settings;
  const raw = model?.[service];
  const name = !raw || raw === customModelString ? customModel?.[service] : raw;
  return name?.replace(/（.*）/g, '').trim() || '';
}

export function openAiEndpointType(endpoint: string): 'responses' | 'chat' | undefined {
  const path = getHttpUrl(endpoint)?.pathname.replace(/\/+$/, '');
  if (path?.endsWith('/responses')) return 'responses';
  if (path?.endsWith('/chat/completions')) return 'chat';
}

function getHttpUrl(endpoint: string): URL | undefined {
  try {
    const url = new URL(endpoint);
    if (url.protocol === 'http:' || url.protocol === 'https:') return url;
  } catch {
    // An incomplete or invalid address cannot be tested.
  }
}

export function openAiEndpointCandidates(endpoint: string): string[] {
  const url = getHttpUrl(endpoint);
  if (!url) throw new Error('请输入有效的 http:// 或 https:// API 地址');
  if (openAiEndpointType(endpoint)) return [endpoint];

  const path = url.pathname.replace(/\/+$/, '');
  const hasVersion = /\/v\d+$/.test(path);
  const basePaths = hasVersion ? [path] : [`${path}/v1`, path];
  // A custom proxy path may already be a complete Chat Completions endpoint.
  const candidates = path && !hasVersion ? [endpoint] : [];
  for (const basePath of basePaths) {
    for (const route of ['chat/completions', 'responses']) {
      url.pathname = `${basePath}/${route}`;
      candidates.push(url.href);
    }
  }
  return candidates;
}

export function openAiRequestBody(endpoint: string, request: OpenAiRequest): string {
  if (openAiEndpointType(endpoint) !== 'responses') return JSON.stringify(request);
  const { model, messages, stream } = request;
  return JSON.stringify({ model, input: messages, stream, store: false });
}

export function isOpenAiResponseTruncated(result: any): boolean {
  const finishReason = result?.choices?.[0]?.finish_reason;
  if (finishReason === 'length') return true;
  if (result?.status === 'incomplete') return true;
  return false;
}

export function openAiResponseText(result: any): string {
  const chatText = result?.choices?.[0]?.message?.content;
  if (typeof chatText === 'string') return chatText;
  if (typeof result?.output_text === 'string') return result.output_text;
  if (!Array.isArray(result?.output)) return '';

  return result.output
    .filter((item: any) => item?.type === 'message' && Array.isArray(item.content))
    .flatMap((item: any) => item.content)
    .filter((part: any) => part?.type === 'output_text' && typeof part.text === 'string')
    .map((part: any) => part.text)
    .join('');
}
