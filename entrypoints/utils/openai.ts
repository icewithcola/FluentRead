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

export const TRANSLATION_TRUNCATED_CODE = 'TRUNCATED';

const TRUNCATED_FINISH_REASONS = new Set(['length', 'max_tokens', 'max_output_tokens']);

export class TranslationTruncatedError extends Error {
  readonly code = TRANSLATION_TRUNCATED_CODE;

  constructor(message = '翻译结果超出模型输出长度上限而被截断') {
    super(message);
    this.name = 'TranslationTruncatedError';
  }
}

export function isTranslationTruncatedError(error: unknown): boolean {
  return (
    error instanceof TranslationTruncatedError ||
    (error instanceof Error && (error as { code?: unknown }).code === TRANSLATION_TRUNCATED_CODE)
  );
}

export function isTruncatedFinishReason(reason: unknown): boolean {
  return typeof reason === 'string' && TRUNCATED_FINISH_REASONS.has(reason.trim().toLowerCase());
}

export function extractOpenAiFinishReason(result: any): string | undefined {
  const chatReason = result?.choices?.[0]?.finish_reason;
  if (typeof chatReason === 'string' && chatReason.trim()) {
    return chatReason.trim().toLowerCase();
  }

  const stopReason = result?.stop_reason;
  if (typeof stopReason === 'string' && stopReason.trim()) {
    return stopReason.trim().toLowerCase();
  }

  if (
    result?.type === 'response.incomplete' ||
    result?.status === 'incomplete' ||
    result?.response?.status === 'incomplete'
  ) {
    const incompleteReason =
      result?.incomplete_details?.reason ?? result?.response?.incomplete_details?.reason;
    if (typeof incompleteReason === 'string' && incompleteReason.trim()) {
      return incompleteReason.trim().toLowerCase();
    }
    return 'length';
  }

  if (
    result?.type === 'response.completed' ||
    result?.status === 'completed' ||
    result?.response?.status === 'completed'
  ) {
    return 'stop';
  }

  return undefined;
}

export function isOpenAiResponseTruncated(result: any): boolean {
  const finishReason = extractOpenAiFinishReason(result);
  if (isTruncatedFinishReason(finishReason)) return true;
  return (
    result?.status === 'incomplete' ||
    result?.type === 'response.incomplete' ||
    result?.response?.status === 'incomplete'
  );
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
