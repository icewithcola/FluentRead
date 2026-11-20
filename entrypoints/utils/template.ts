// 消息模板工具
import { defaultOption } from './option';
import { config } from '@/entrypoints/utils/config';
import { isCantonese } from './common';
import { openAiModel, type OpenAiRequest } from './openai';

const PROMPT_LANGUAGE_NAMES: Record<string, string> = {
  'zh-Hans': 'Simplified Chinese (简体中文)',
  'zh-Hant': 'Traditional Chinese (繁體中文)',
  zh: 'Simplified Chinese (简体中文)',
  en: 'English',
  ja: 'Japanese (日本語)',
  ko: 'Korean (한국어)',
  fr: 'French (Français)',
  ru: 'Russian (Русский)',
  de: 'German (Deutsch)',
  es: 'Spanish (Español)',
  it: 'Italian (Italiano)',
  pt: 'Portuguese (Português)',
  ar: 'Arabic (العربية)',
  hi: 'Hindi (हिन्दी)',
  th: 'Thai (ไทย)',
  vi: 'Vietnamese (Tiếng Việt)',
  nl: 'Dutch (Nederlands)',
  pl: 'Polish (Polski)',
  tr: 'Turkish (Türkçe)',
};

/**
 * Resolve a short BCP-47/internal target language code into a descriptive label
 * so smaller LLMs do not ignore or misinterpret codes like `zh-Hans`.
 */
export function formatTargetLanguageForPrompt(langCode: string): string {
  return PROMPT_LANGUAGE_NAMES[langCode] || langCode;
}

// openai 格式的消息模板（通用模板）
// pageSummary: optional page summary context to inject into the prompt for better translation
export function commonMsgTemplate(origin: string, pageSummary?: string): OpenAiRequest {

  let system = config.system_role[config.service] || defaultOption.system_role;
  const targetLanguage = formatTargetLanguageForPrompt(config.to);

  // 规范化原文：将 HTML 缩进产生的连续空白（换行/制表符/连续空格）折叠为单个空格，
  // 并去除首尾空白，避免这些无关空白被模型原样带入译文内容
  const cleanedOrigin = origin.replace(/\s+/g, ' ').trim();

  let user = (config.user_role[config.service] || defaultOption.user_role)
    .replace(/\{\{to\}\}/g, () => targetLanguage)
    .replace(/\{\{origin\}\}/g, () => cleanedOrigin);

  // 如果是粤语，注入专属的粤语理解与意译Prompt
  if (isCantonese(origin)) {
    system += `\n\nNote: The source text is written in Cantonese (粤语/广东话) and may contain Cantonese slang, colloquial grammar, and internet abbreviations (e.g. 'po' means post/帖子, '劈' means drinking/chugging, etc.). Do NOT perform a word-for-word literal translation. Instead, fully understand the meaning, slang, and context of the Cantonese text, and translate it into standard, natural, and idiomatic ${targetLanguage}.`;
  }

  // Inject page summary context into the system prompt if available
  if (pageSummary) {
    system += `\n\nPage context for reference (use this to improve translation accuracy, especially for proper nouns and domain-specific terms):\n${pageSummary}`;
  }

  const body: OpenAiRequest = {
    model: openAiModel(config),
    temperature: 0.3,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  };

  // Enable streaming if configured
  if (config.useStream) {
    body.stream = true;
  }

  return body;
}

/**
 * Build a summary request body for extracting key terms and background context from a page.
 * The summary result is NOT shown to users—it's injected into translation prompts to improve quality.
 * Always non-streaming since we need the full result before translations begin.
 */
export function summaryMsgTemplate(content: string) {
  // Use summary-specific model if configured, otherwise fall back to translation model
  const model = config.summaryModel?.replace(/（.*）/g, '').trim() || openAiModel(config);
  const targetLanguage = formatTargetLanguageForPrompt(config.to);

  if (config.debugMode) {
    console.log(
      '[Catgirl Read Debug] summaryMsgTemplate - model:',
      model,
      '| target language:',
      config.to,
      '| content length:',
      content.length,
    );
  }

  const system =
    'You are a professional content analyst. Your job is to extract key context from webpage content to help a translator produce more accurate translations.';
  const user = `Analyze the following webpage content. Provide a brief context summary in 1-2 sentences, then list up to 10 key terms/proper nouns with their correct translations in ${targetLanguage}. Format your response exactly as:\nContext: <brief background>\nKey terms: <term1> = <translation1>, <term2> = <translation2>, ...\n\n${content}`;

  const body: any = {
    model: model,
    temperature: 0.3,
    stream: false,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  };

  if (config.debugMode) {
    console.log('[Catgirl Read Debug] summaryMsgTemplate - model:', model, '| stream:', false);
    console.log('[Catgirl Read Debug] summaryMsgTemplate - system prompt:', system);
    console.log(
      '[Catgirl Read Debug] summaryMsgTemplate - user prompt (first 300 chars):',
      user.slice(0, 300) + '...',
    );
  }

  // Always non-streaming for summary since we need the full result upfront
  return JSON.stringify(body);
}
