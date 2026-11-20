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

const BATCH_SEGMENT_MARKER_TEST_RE = /\[\[@FR_SEG_\d+@\]\]/;
const BATCH_SEGMENT_MARKER_SPLIT_RE = /(\[\[@FR_SEG_\d+@\]\])/;

const GROUP_CONTEXT_PREFIX_RE =
  /^(?:Group|List lead-in|Parent item|Table columns|Related items|Slot roles):/;

/**
 * Split structural page context into cache-friendly layers ordered from
 * page-static (document meta) to section-semi-static to paragraph-dynamic.
 */
function splitPageContext(pageContext?: string): {
  documentMeta: string;
  sectionContext: string;
  groupContext: string;
  precedingContext: string;
} {
  if (!pageContext?.trim()) {
    return { documentMeta: '', sectionContext: '', groupContext: '', precedingContext: '' };
  }

  const docLines: string[] = [];
  const sectionLines: string[] = [];
  const groupLines: string[] = [];
  const precedingLines: string[] = [];

  for (const rawLine of pageContext.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('Section:')) {
      sectionLines.push(line);
    } else if (GROUP_CONTEXT_PREFIX_RE.test(line)) {
      groupLines.push(line);
    } else if (line.startsWith('Preceding text:')) {
      precedingLines.push(line);
    } else {
      docLines.push(line);
    }
  }

  return {
    documentMeta: docLines.join('\n'),
    sectionContext: sectionLines.join('\n'),
    groupContext: groupLines.join('\n'),
    precedingContext: precedingLines.join('\n'),
  };
}

/**
 * Collapse redundant indentation whitespace in source text while keeping
 * batch segment markers on their own lines.
 */
function normalizePromptOrigin(origin: string): string {
  if (!BATCH_SEGMENT_MARKER_TEST_RE.test(origin)) {
    return origin.replace(/\s+/g, ' ').trim();
  }

  const parts = origin.split(BATCH_SEGMENT_MARKER_SPLIT_RE);
  const lines: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part) continue;
    if (BATCH_SEGMENT_MARKER_TEST_RE.test(part)) {
      const next = parts[i + 1];
      const normalizedSegment =
        next && !BATCH_SEGMENT_MARKER_TEST_RE.test(next) ? next.replace(/\s+/g, ' ').trim() : '';
      if (normalizedSegment) {
        lines.push(`${part}\n${normalizedSegment}`);
        i++;
      } else {
        lines.push(part);
      }
    } else {
      const normalized = part.replace(/\s+/g, ' ').trim();
      if (normalized) lines.push(normalized);
    }
  }
  return lines.join('\n');
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
  // 并去除首尾空白，避免这些无关空白被模型原样带入译文内容；批量分段标记保留独立成行
  const cleanedOrigin = normalizePromptOrigin(origin);

  let user = (config.user_role[config.service] || defaultOption.user_role)
    .replace(/\{\{to\}\}/g, () => targetLanguage)
    .replace(/\{\{origin\}\}/g, () => cleanedOrigin);

  // Layer 2: Global static formatting, terminology, and batch segmentation rules
  system += `\n\nFormatting & terminology rules:\n- If the source contains inline HTML tags (e.g. <a>, <code>, <strong>, <em>, <span>, <kbd>, <samp>, <var>), preserve all HTML tags, nesting order, and attributes intact, and translate ONLY the natural-language text inside tags. If the source is plain text without HTML tags, output plain text only and never invent HTML tags. If the source wraps inline emphasis in **...**, preserve the corresponding **...** emphasis in the translation.\n- Keep inline code wrapped in backticks (\`...\`), mathematical expressions ($...$), and content inside <code>, <kbd>, <samp>, or <var> tags in their exact original form; NEVER translate or alter code identifiers, variable names, API symbols, commands, CLI flags, or formulas.\n- If the source contains batch segment markers ([[@FR_SEG_0@]], [[@FR_SEG_1@]], ...), keep the exact same [[@FR_SEG_N@]] marker before each corresponding translated segment in order, and never merge, split, omit, reorder, or add segment markers.\n- When segments belong to a structured group (list, nested outline, term-definition pairs, or table) or when structured group context is provided, use the shared logical structure to maintain consistent terminology, grammatical parallelism, tone, and implicit subjects/verbs across items while keeping each segment translation strictly 1-to-1 aligned with its source segment. Never prepend bullet symbols or numbering (-, *, •, 1., 1)) unless the source segment text itself starts with one.`;

  // Layer 3: Page-static document metadata (Title / Site / Meta)
  const { documentMeta, sectionContext, groupContext, precedingContext } = splitPageContext(pageContext);
  if (documentMeta) {
    system += `\n\nDocument metadata (for domain disambiguation and terminology consistency only; NEVER translate or output this metadata):\n${documentMeta}`;
  }

  // Layer 4: Page-static domain summary & terminology glossary (before per-section/per-paragraph context)
  if (pageSummary?.trim()) {
    system += `\n\nPage domain summary & terminology glossary (strictly follow these term translations for consistency):\n${pageSummary.trim()}`;
  }

  // Layer 5: Section-semi-static context
  if (sectionContext) {
    system += `\n\nCurrent section context (for disambiguation only; NEVER translate or output this context):\n${sectionContext}`;
  }

  // Layer 6: Structured group & paragraph-dynamic context at the very end to preserve prefix caching
  if (groupContext) {
    system += `\n\nStructured group context (use for grammatical parallelism, terminology consistency, and disambiguation; NEVER translate or output this context):\n${groupContext}`;
  }
  if (precedingContext) {
    system += `\n\nPreceding text context (for pronoun resolution and flow only; NEVER translate or output this context):\n${precedingContext}`;
  }

  // 如果是粤语，注入专属的粤语理解与意译Prompt
  if (isCantonese(origin)) {
    system += `\n\nNote: The source text is written in Cantonese (粤语/广东话) and may contain Cantonese slang, colloquial grammar, and internet abbreviations (e.g. 'po' means post/帖子, '劈' means drinking/chugging, etc.). Do NOT perform a word-for-word literal translation. Instead, fully understand the meaning, slang, and context of the Cantonese text, and translate it into standard, natural, and idiomatic ${targetLanguage}.`;
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
