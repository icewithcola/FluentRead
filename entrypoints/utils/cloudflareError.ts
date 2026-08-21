/**
 * Parse Cloudflare-hosted error / challenge pages.
 *
 * Runs in the background service worker, so this is string-only (no DOMParser).
 * Successful Cloudflare-proxied API responses also carry `cf-ray`; detection
 * must not treat that header alone as an error.
 */

export interface CloudflareErrorInfo {
  code?: string;
  title?: string;
  rayId?: string;
  errorType?: string;
  httpStatus?: number;
  kind: 'error-page' | 'challenge' | 'block';
}

const CF_ERROR_TITLES: Record<string, string> = {
  '500': 'Internal server error',
  '502': 'Bad gateway',
  '504': 'Gateway timeout',
  '520': 'Web server is returning an unknown error',
  '521': 'Web server is down',
  '522': 'Connection timed out',
  '523': 'Origin is unreachable',
  '524': 'A timeout occurred',
  '525': 'SSL handshake failed',
  '526': 'Invalid SSL certificate',
  '527': 'Railgun error',
  '530': 'Origin DNS error',
  '1000': 'DNS points to prohibited IP',
  '1003': 'Direct IP access not allowed',
  '1015': 'Rate limited',
  '1016': 'Origin DNS error',
  '1020': 'Access denied',
  '1101': 'Worker threw an exception',
  '1102': 'Worker exceeded resource limits',
};

const HTML_ERROR_MARKERS = [
  /id=["']cf-error-details["']/i,
  /class=["'][^"']*\bcf-error-details\b/i,
  /class=["'][^"']*\bcf-error-code\b/i,
  /Cloudflare\s+Ray\s+ID:/i,
  /cdn-cgi\/styles\/cf\.errors/i,
  /cloudflare\.com\/5xx-error-landing/i,
  /id=["']cf-wrapper["']/i,
  /window\._cf_translation/i,
];

const CHALLENGE_MARKERS = [
  /\/cdn-cgi\/challenge-platform/i,
  /cf-browser-verification/i,
  /id=["']challenge-running["']/i,
  /id=["']challenge-form["']/i,
  /<title[^>]*>\s*Just a moment\.\.\./i,
  /<title[^>]*>\s*Attention Required!/i,
];

const BLOCK_MARKERS = [
  /data-translate=["']block_headline["']/i,
  /Sorry,\s+you have been blocked/i,
  /<title[^>]*>\s*Access denied/i,
];

type HeaderSource = { get(name: string): string | null } | null | undefined;

function header(headers: HeaderSource, name: string): string {
  return headers?.get(name)?.trim() || '';
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => fromCodePoint(Number(dec)));
}

function fromCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
  return String.fromCodePoint(code);
}

function stripTags(html: string): string {
  return decodeHtmlEntities(html.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function classContent(html: string, className: string): string | undefined {
  const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = html.match(
    new RegExp(
      `<([a-z0-9]+)[^>]*\\sclass=["'][^"']*\\b${escaped}\\b[^"']*["'][^>]*>([\\s\\S]*?)</\\1>`,
      'i',
    ),
  );
  const text = match ? stripTags(match[2]) : '';
  return text || undefined;
}

function pageTitle(html: string): string | undefined {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const text = match ? stripTags(match[1]) : '';
  return text || undefined;
}

function detectKind(body: string, headers: HeaderSource): CloudflareErrorInfo['kind'] {
  if (BLOCK_MARKERS.some((re) => re.test(body))) return 'block';
  const mitigated = header(headers, 'cf-mitigated').toLowerCase();
  if (mitigated === 'challenge' || CHALLENGE_MARKERS.some((re) => re.test(body))) {
    return 'challenge';
  }
  return 'error-page';
}

function isCloudflareHostedError(body: string, headers: HeaderSource): boolean {
  if (header(headers, 'cf-error-type') || header(headers, 'cf-mitigated')) return true;
  if (HTML_ERROR_MARKERS.some((re) => re.test(body))) return true;
  if (CHALLENGE_MARKERS.some((re) => re.test(body))) return true;
  if (BLOCK_MARKERS.some((re) => re.test(body))) return true;
  return false;
}

function parseCloudflareJson(body: string): CloudflareErrorInfo | null {
  const trimmed = body.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const json = JSON.parse(trimmed) as Record<string, unknown>;
    const cloudflareError = json.cloudflare_error === true;
    const errorCode = json.error_code != null ? String(json.error_code) : undefined;
    const rayId =
      (typeof json.ray_id === 'string' && json.ray_id) ||
      (typeof json.instance === 'string' && json.instance) ||
      undefined;
    if (!cloudflareError && !(errorCode && rayId && typeof json.error_name === 'string')) {
      return null;
    }

    const title =
      (typeof json.title === 'string' && json.title) ||
      (typeof json.error_name === 'string' && json.error_name.replace(/_/g, ' ')) ||
      (typeof json.detail === 'string' && json.detail) ||
      undefined;

    return {
      kind: 'error-page',
      code: errorCode,
      title,
      rayId,
      httpStatus: typeof json.status === 'number' ? json.status : undefined,
    };
  } catch {
    return null;
  }
}

function parseCodeAndTitleFromText(text: string | undefined): { code?: string; title?: string } {
  if (!text) return {};
  const titled = text.match(/(?:^|\|\s*)(\d{3,4})\s*:\s*([^|<]+)/);
  if (titled) {
    return { code: titled[1], title: titled[2].trim() };
  }
  const errorN = text.match(/\bError\s+(\d{3,4})\b/i);
  if (errorN) return { code: errorN[1], title: text.replace(/\bError\s+\d{3,4}\b/i, '').trim() || undefined };
  return {};
}

/**
 * Detect a Cloudflare-hosted error/challenge page and extract code, title, and Ray ID.
 */
export function parseCloudflareError(
  body: string,
  headers?: HeaderSource,
  httpStatus?: number,
): CloudflareErrorInfo | null {
  const json = parseCloudflareJson(body);
  if (json) {
    json.httpStatus = json.httpStatus ?? httpStatus;
    json.rayId = json.rayId || header(headers, 'cf-ray') || undefined;
    json.errorType = header(headers, 'cf-error-type') || undefined;
    return json;
  }

  if (!isCloudflareHostedError(body, headers)) return null;

  const titleText = pageTitle(body);
  const fromTitle = parseCodeAndTitleFromText(titleText);
  const fromHeadline = parseCodeAndTitleFromText(classContent(body, 'cf-subheadline'));
  const errorCode =
    classContent(body, 'cf-error-code') ||
    body.match(/\bError\s+(\d{3,4})\b/i)?.[1] ||
    fromTitle.code ||
    fromHeadline.code;

  const pageTitleLooksGeneric =
    !titleText ||
    /cloudflare/i.test(titleText) ||
    /attention required/i.test(titleText) ||
    /just a moment/i.test(titleText) ||
    /access denied/i.test(titleText) ||
    Boolean(fromTitle.code);

  const title =
    classContent(body, 'cf-subheadline') ||
    fromTitle.title ||
    fromHeadline.title ||
    (pageTitleLooksGeneric ? undefined : titleText) ||
    (errorCode ? CF_ERROR_TITLES[errorCode] : undefined);

  const rayFromBody =
    body.match(/Cloudflare\s+Ray\s+ID:\s*(?:<[^>]+>)*\s*([a-f0-9]{8,32})/i)?.[1] ||
    body.match(/\bRay ID:\s*([a-f0-9]{8,32})/i)?.[1];

  return {
    kind: detectKind(body, headers),
    code: errorCode,
    title: title || undefined,
    rayId: header(headers, 'cf-ray') || rayFromBody || undefined,
    errorType: header(headers, 'cf-error-type') || undefined,
    httpStatus,
  };
}

export function formatCloudflareError(info: CloudflareErrorInfo): string {
  const code =
    info.code ||
    (info.httpStatus && info.httpStatus >= 400 ? String(info.httpStatus) : undefined);
  const title =
    info.title ||
    (code && CF_ERROR_TITLES[code]) ||
    (info.kind === 'challenge' ? 'challenge page' : info.kind === 'block' ? 'access denied' : undefined);

  const parts = ['Cloudflare'];
  if (code) parts.push(code);
  if (title && title.toLowerCase() !== String(code).toLowerCase()) parts.push(title);
  if (!code && !title && info.errorType) parts.push(info.errorType);
  if (info.rayId) parts.push(`(Ray ID: ${info.rayId})`);
  return parts.join(' ');
}

/** `翻译失败: Cloudflare …` or null when the body/headers are not a CF error page. */
export function cloudflareFailureMessage(
  body: string,
  headers?: HeaderSource,
  httpStatus?: number,
): string | null {
  const info = parseCloudflareError(body, headers, httpStatus);
  if (!info) return null;
  return `翻译失败: ${formatCloudflareError(info)}`;
}
