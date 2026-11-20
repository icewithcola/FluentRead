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
// pageContext: optional structural page/section/preceding context for disambiguation
export function commonMsgTemplate(
  origin: string,
  pageSummary?: string,
  pageContext?: string,
): OpenAiRequest {
  let system = config.system_role[config.service] || defaultOption.system_role;
  const targetLanguage = formatTargetLanguageForPrompt(config.to);

  // 规范化原文：将 HTML 缩进产生的连续空白（换行/制表符/连续空格）折叠为单个空格，
  // 并去除首尾空白，避免这些无关空白被模型原样带入译文内容
  const cleanedOrigin = origin.replace(/\s+/g, ' ').trim();

  let user = (config.user_role[config.service] || defaultOption.user_role)
    .replace(/\{\{to\}\}/g, () => targetLanguage)
    .replace(/\{\{origin\}\}/g, () => cleanedOrigin);

  // Inject format-specific guardrails based on whether source contains inline HTML or code/math markers
  const hasHtmlTags = /<\/?[a-z][\s\S]*?>/i.test(cleanedOrigin);
  if (hasHtmlTags) {
    system += `\n\nFormatting & terminology rules:\n- The source contains inline HTML tags (e.g. <a>, <code>, <strong>, <em>, <span>, <kbd>, <samp>, <var>). Preserve all HTML tags, nesting order, and attributes intact.\n- Translate ONLY the natural-language text inside tags. NEVER translate or alter code identifiers, commands, or formulas inside <code>, <kbd>, <samp>, or <var> tags.`;
  } else if (/`[^`]+`|\$[^$]+\$/.test(cleanedOrigin)) {
    system += `\n\nFormatting & terminology rules:\n- Keep inline code wrapped in backticks (\`...\`) and mathematical expressions ($...$) in their exact original form; do not translate code identifiers, variable names, API symbols, or CLI flags.`;
  }

  // 如果是粤语，注入专属的粤语理解与意译Prompt
  if (isCantonese(origin)) {
    system += `\n\nNote: The source text is written in Cantonese (粤语/广东话) and may contain Cantonese slang, colloquial grammar, and internet abbreviations (e.g. 'po' means post/帖子, '劈' means drinking/chugging, etc.). Do NOT perform a word-for-word literal translation. Instead, fully understand the meaning, slang, and context of the Cantonese text, and translate it into standard, natural, and idiomatic ${targetLanguage}.`;
  }

  // Inject structural page & section context if available
  if (pageContext?.trim()) {
    system += `\n\nDocument & section context (for domain disambiguation, terminology consistency, and pronoun resolution only; NEVER translate or output this context):\n${pageContext.trim()}`;
  }

  // Inject page summary context into the system prompt if available
  if (pageSummary?.trim()) {
    system += `\n\nPage domain summary & terminology glossary (strictly follow these term translations for consistency):\n${pageSummary.trim()}`;
  }

  const body: OpenAiRequest = {
    model: openAiModel(config),
    temperature: 0.1,
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
    'You are a senior domain analyst and terminology lexicographer. Extract the precise academic/technical domain, core context, and a high-precision bilingual glossary from webpage content to guide a professional translator.';
  const user = `Analyze the following webpage content.
1. Identify the specific domain/sub-domain and document register (e.g. "Computer Science / Distributed Systems — Technical Documentation", "Biomedicine — Clinical Trial Paper", "Finance — Equity Research").
2. Provide a concise 1-2 sentence summary of the core topic.
3. Extract up to 25 key domain-specific terms, ambiguous polysemous terms, proper nouns, and technical acronyms with their authoritative translations in ${targetLanguage} (if a term or identifier should remain in its original form, map it to itself).
Format your response exactly as:
Domain: <domain, sub-domain, and register>
Context: <brief background>
Key terms: <term1> = <translation1>, <term2> = <translation2>, ...

${content}`;

  const body: any = {
    model: model,
    temperature: 0.2,
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
