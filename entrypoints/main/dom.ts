import { html } from 'js-beautify';
import { getMainDomain, isSelectSkip, selectCompatFn } from '@/entrypoints/main/compat';

/**
 * DOM selection and serialization primitives used by the translation layer.
 *
 * This module intentionally has no translation side effects. The previous
 * implementation called the button translator while walking the DOM and
 * imported `trans.ts`, creating a cycle and making a read operation mutate the
 * page. Callers now receive stable element candidates and decide what to do
 * with them.
 */

export const directSet = new Set([
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'p',
  'blockquote',
  'li',
  'dt',
  'dd',
]);

/** Elements and subtrees that must never be sent to a translation service. */
export const skipSet = new Set([
  'html',
  'body',
  'head',
  'title',
  'base',
  'meta',
  'link',
  'script',
  'style',
  'noscript',
  'iframe',
  'object',
  'embed',
  'template',
  'input',
  'textarea',
  'select',
  'button',
  'code',
  'pre',
  'kbd',
  'samp',
  'figcaption',
  'nav',
  'aside',
  'header',
  'footer',
  'audio',
  'video',
  'canvas',
  'svg',
  'math',
  'picture',
  'source',
  'track',
  'map',
  'area',
  'portal',
]);

/** ARIA landmarks equivalent to the semantic header/footer elements above. */
const skipRoleSet = new Set(['banner', 'contentinfo']);

/** Inline markup which can safely remain inside a translation unit. */
export const inlineSet = new Set([
  'a',
  'b',
  'strong',
  'span',
  'em',
  'i',
  'u',
  'small',
  'sub',
  'sup',
  'font',
  'mark',
  'cite',
  'q',
  'abbr',
  'time',
  'ruby',
  'bdi',
  'bdo',
  'img',
  'br',
  'wbr',
]);

const containerSet = new Set([
  'article',
  'section',
  'main',
  'div',
  'label',
  'td',
  'th',
  'caption',
  'summary',
  'form',
  'fieldset',
  'details',
]);

const TRANSLATED_ATTR = 'data-fr-translated';
const TRANSLATION_ID_ATTR = 'data-fr-node-id';
const OWNED_ATTR = 'data-fr-owned';

const allowedTranslationTags = new Set([
  'a',
  'abbr',
  'b',
  'bdi',
  'bdo',
  'blockquote',
  'br',
  'cite',
  'code',
  'del',
  'dd',
  'div',
  'dl',
  'dt',
  'em',
  'i',
  'img',
  'ins',
  'kbd',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'li',
  'mark',
  'ol',
  'p',
  'q',
  'ruby',
  'rp',
  'rt',
  's',
  'small',
  'span',
  'strong',
  'sub',
  'sup',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'time',
  'thead',
  'tr',
  'u',
  'ul',
  'var',
  'wbr',
]);

const removedTranslationTags = new Set([
  'base',
  'button',
  'canvas',
  'embed',
  'form',
  'iframe',
  'input',
  'link',
  'meta',
  'object',
  'script',
  'select',
  'style',
  'svg',
  'template',
  'textarea',
  'video',
]);

const allowedTranslationAttributes = new Set([
  'aria-label',
  'alt',
  'class',
  'colspan',
  'dir',
  'height',
  'href',
  'lang',
  'rel',
  'rowspan',
  'src',
  'target',
  'title',
  'width',
]);

const UNICODE_WHITESPACE_RE =
  /^[\s\u00A0\u1680\u180E\u2000-\u200D\u2028\u2029\u202F\u205F\u2060\u3000\uFEFF]+|[\s\u00A0\u1680\u180E\u2000-\u200D\u2028\u2029\u202F\u205F\u2060\u3000\uFEFF]+$/g;

function stripWhitespace(text: string): string {
  return text.replace(UNICODE_WHITESPACE_RE, '');
}

function isSafeTranslationUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  return /^(?:https?:|mailto:|tel:|#|\/|\.\/)/i.test(trimmed);
}

/**
 * Sanitize markup returned by a translation service before it reaches the live
 * page. Unknown formatting tags are unwrapped, executable/container tags are
 * removed, event/style attributes are discarded, and URL attributes accept
 * only navigational protocols.
 */
export function sanitizeTranslationHTML(value: string, trustedSourceHTML?: string): string {
  if (!value || typeof document === 'undefined') return value || '';
  const container = document.createElement('div');
  container.innerHTML = value;

  // When source markup is available, attributes must come from that trusted
  // page-authored structure rather than from the translation response. Lists
  // are keyed by tag so harmless wrapper changes do not shift every match.
  const trustedAttributes =
    trustedSourceHTML === undefined ? null : new Map<string, Element[]>();
  if (trustedAttributes) {
    const trustedContainer = document.createElement('div');
    trustedContainer.innerHTML = trustedSourceHTML ?? '';
    trustedContainer.querySelectorAll('*').forEach((element) => {
      const tag = element.tagName.toLowerCase();
      const elements = trustedAttributes.get(tag) ?? [];
      elements.push(element);
      trustedAttributes.set(tag, elements);
    });
  }

  const isAllowedAttribute = (name: string, value: string): boolean => {
    if (!allowedTranslationAttributes.has(name)) return false;
    if ((name === 'href' || name === 'src') && !isSafeTranslationUrl(value)) return false;
    if (name === 'target' && !['_blank', '_self', '_parent', '_top'].includes(value)) {
      return false;
    }
    return true;
  };

  const sanitizeChildren = (parent: ParentNode): void => {
    Array.from(parent.childNodes).forEach((child) => {
      if (child.nodeType !== Node.ELEMENT_NODE) {
        if (child.nodeType === Node.COMMENT_NODE) child.remove();
        return;
      }

      const element = child as Element;
      const tag = element.tagName.toLowerCase();
      if (removedTranslationTags.has(tag)) {
        element.remove();
        return;
      }

      sanitizeChildren(element);
      if (!allowedTranslationTags.has(tag)) {
        // Preserve readable text/formatting from harmless unknown tags while
        // removing the tag itself.
        const fragment = document.createDocumentFragment();
        while (element.firstChild) fragment.appendChild(element.firstChild);
        element.replaceWith(fragment);
        return;
      }

      if (trustedAttributes) {
        const trusted = trustedAttributes.get(tag)?.shift();
        Array.from(element.attributes).forEach((attribute) => {
          element.removeAttribute(attribute.name);
        });
        trusted && Array.from(trusted.attributes).forEach((attribute) => {
          const name = attribute.name.toLowerCase();
          if (isAllowedAttribute(name, attribute.value)) {
            element.setAttribute(attribute.name, attribute.value);
          }
        });
      } else {
        Array.from(element.attributes).forEach((attribute) => {
          const name = attribute.name.toLowerCase();
          if (!isAllowedAttribute(name, attribute.value)) {
            element.removeAttribute(attribute.name);
          }
        });
      }
    });
  };

  sanitizeChildren(container);
  return container.innerHTML;
}

function hasMeaningfulText(text: string | null | undefined): boolean {
  return !!text && stripWhitespace(text).length > 0;
}

function isSkippedElement(element: Element): boolean {
  if (skipSet.has(element.tagName.toLowerCase())) return true;
  const roles = element.getAttribute('role')?.toLowerCase().split(/\s+/u) ?? [];
  return roles.some((role) => skipRoleSet.has(role));
}

function hasSkippedAncestor(element: Element): boolean {
  let current = element.parentElement;
  while (current) {
    const tag = current.tagName.toLowerCase();
    // html/body are scan wrappers, not skipped content boundaries.
    if (tag !== 'html' && tag !== 'body' && isSkippedElement(current)) {
      return true;
    }
    current = current.parentElement;
  }
  return false;
}

/** Text that remains after removing non-content subtrees from a translation unit. */
export function getTranslatableText(element: Element): string {
  if (hasSkippedAncestor(element)) return '';
  const parts: string[] = [];
  const visit = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      if (node.nodeValue) parts.push(node.nodeValue);
      return;
    }
    if (!(node instanceof Element)) return;
    if (
      isSkippedElement(node) ||
      isOwnedElement(node) ||
      !isVisible(node)
    ) {
      return;
    }
    node.childNodes.forEach(visit);
  };
  visit(element);
  return parts.join(' ');
}

function isOwnedElement(element: Element): boolean {
  return (
    element.hasAttribute(OWNED_ATTR) ||
    element.classList.contains('fluent-read-loading') ||
    element.classList.contains('fluent-read-bilingual-content') ||
    element.classList.contains('fluent-read-retry-wrapper')
  );
}

/**
 * Translation discovery must not descend into FluentRead UI, an existing
 * translation, or extension-owned status/retry markup. This is intentionally
 * separate from `isOwnedElement`: serialization runs inside a translated root
 * and only needs to remove the owned descendants themselves.
 */
function isInsideExcludedTree(element: Element): boolean {
  return Boolean(
    element.closest(
      `[${OWNED_ATTR}], [${TRANSLATED_ATTR}], [${TRANSLATION_ID_ATTR}], [id^="fluent-read-"]`,
    ),
  );
}

/**
 * Check visibility without treating every jsdom/hidden-layout element as
 * invisible. The computed-style check is only used when it has an explicit
 * hidden value, which also handles fixed-position elements correctly.
 */
function isVisible(element: Element): boolean {
  let current: Element | null = element;
  while (current) {
    if (
      current.hasAttribute('hidden') ||
      current.classList.contains('sr-only') ||
      current.classList.contains('notranslate') ||
      current.getAttribute('translate')?.toLowerCase() === 'no' ||
      current.hasAttribute('data-no-translate') ||
      current.getAttribute('aria-hidden') === 'true'
    ) {
      return false;
    }
    current = current.parentElement;
  }

  if (
    typeof window !== 'undefined' &&
    typeof window.getComputedStyle === 'function' &&
    typeof HTMLElement !== 'undefined' &&
    element instanceof HTMLElement
  ) {
    const style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      return false;
    }
  }
  return true;
}

function hasBlockChild(element: Element): boolean {
  return Array.from(element.children).some((child) => {
    const tag = child.tagName.toLowerCase();
    if (isSkippedElement(child) || isOwnedElement(child)) return false;
    if (!hasMeaningfulText(child.textContent)) return false;
    return !inlineSet.has(tag);
  });
}

function hasInlineContent(element: Element): boolean {
  return Array.from(element.childNodes).some((child) => {
    if (child.nodeType === Node.TEXT_NODE) return hasMeaningfulText(child.textContent);
    if (child.nodeType !== Node.ELEMENT_NODE) return false;
    const childElement = child as Element;
    return !isOwnedElement(childElement) && inlineSet.has(childElement.tagName.toLowerCase());
  });
}

function hasTranslatableText(element: Element): boolean {
  return !isOwnedElement(element) && shouldTranslateContent(getTranslatableText(element));
}

function isMainlyNumericContent(element: Element): boolean {
  const text = stripWhitespace(getTranslatableText(element));
  if (!text) return false;
  if (text.length < 30 && isNumericContent(text)) return true;

  const textNodes: string[] = [];
  if (typeof document !== 'undefined') {
    const showText = typeof NodeFilter === 'undefined' ? 4 : NodeFilter.SHOW_TEXT;
    const walker = document.createTreeWalker(element, showText);
    let current: Node | null;
    while ((current = walker.nextNode())) {
      const value = stripWhitespace(current.textContent || '');
      if (value) textNodes.push(value);
    }
  }
  return (
    (textNodes.length === 1 && isNumericContent(textNodes[0])) ||
    (textNodes.length > 0 && textNodes.every((value) => isNumericContent(value)))
  );
}

function isSafeElement(element: Element): boolean {
  if (!(element instanceof Element)) return false;
  return (
    !isSkippedElement(element) &&
    !hasSkippedAncestor(element) &&
    !isInsideExcludedTree(element) &&
    !element.hasAttribute(TRANSLATED_ATTR) &&
    !element.hasAttribute(TRANSLATION_ID_ATTR) &&
    !(typeof HTMLElement !== 'undefined' && element instanceof HTMLElement && element.isContentEditable) &&
    isVisible(element) &&
    hasTranslatableText(element) &&
    !isMainlyNumericContent(element)
  );
}

/** Return whether an element is a complete translation unit. */
export function isTranslationCandidate(element: Element): boolean {
  if (!isSafeElement(element)) return false;

  const tag = element.tagName.toLowerCase();
  if (directSet.has(tag)) return true;

  if (containerSet.has(tag)) {
    // Containers containing a nested block are traversed so the smallest
    // meaningful units win. Inline markup remains part of the parent unit.
    return !hasBlockChild(element);
  }

  // Standalone links and inline fragments are useful for hover translation,
  // but wrappers with no text are not.
  return inlineSet.has(tag) && (hasMeaningfulText(element.textContent) || hasInlineContent(element));
}

type CompatResolution = { candidate?: Element; skip: boolean };

function resolveCompat(element: Element): CompatResolution {
  if (typeof location === 'undefined') return { skip: false };
  const handler = selectCompatFn[getMainDomain(location.href.split('?')[0])];
  if (!handler) return { skip: false };

  const result = handler(element);
  if (isSelectSkip(result)) return { skip: true };
  if (result instanceof Element && result.isConnected && isSafeElement(result)) {
    return { candidate: result, skip: false };
  }
  return { skip: false };
}

/**
 * Collect the smallest stable translation units below `rootNode`.
 *
 * The old TreeWalker rejected a parent and accidentally rejected its entire
 * subtree, omitted a root element, and then recursively re-selected the same
 * inline parent. An explicit walk makes those boundaries unambiguous and
 * stops as soon as a unit is selected.
 */
export function grabAllNode(rootNode: Node): Element[] {
  if (!rootNode) return [];

  const result: Element[] = [];
  const seen = new Set<Element>();

  const visit = (element: Element) => {
    if (!element || !element.isConnected) return;
    if (
      isSkippedElement(element) ||
      !isVisible(element) ||
      isOwnedElement(element) ||
      isInsideExcludedTree(element)
    ) {
      return;
    }

    const compat = resolveCompat(element);
    // A compatibility handler may find a descendant while this element is a
    // generic wrapper. Let the recursive walk reach that descendant instead
    // of skipping all sibling content in the wrapper.
    const candidate = compat.skip
      ? false
      : compat.candidate === element
        ? element
        : isTranslationCandidate(element)
          ? element
          : false;

    if (candidate && !seen.has(candidate)) {
      seen.add(candidate);
      result.push(candidate);
      return;
    }

    // A directSet element (p, h1, li, etc.) is a self-contained prose unit.
    // If it was rejected (e.g. numeric or non-prose), descending into its
    // inline children (links, spans) would translate them without the
    // surrounding text context, producing broken fragments. Skip entirely.
    if (!candidate && directSet.has(element.tagName.toLowerCase())) {
      return;
    }

    Array.from(element.children).forEach(visit);
  };

  if (rootNode instanceof Element) {
    // `document.body` is a scan root, not a translation boundary. The same
    // applies to callers passing an html/body wrapper explicitly.
    if (['html', 'body'].includes(rootNode.tagName.toLowerCase())) {
      Array.from(rootNode.children).forEach(visit);
    } else {
      visit(rootNode);
    }
  } else if (rootNode.nodeType === Node.DOCUMENT_NODE && document.body) {
    visit(document.body);
  } else {
    Array.from(rootNode.childNodes).forEach((child) => {
      if (child instanceof Element) visit(child);
    });
  }

  return result.filter((element) => element.isConnected && !element.hasAttribute(TRANSLATED_ATTR));
}

/** Resolve the unit under a hover/text node without mutating anything. */
export function grabNode(node: Node | null | undefined): Element | false {
  if (!node) return false;
  let element: Element | null = node instanceof Element ? node : node.parentElement;
  let inlineFallback: Element | false = false;
  const visited = new Set<Element>();

  while (element && !visited.has(element)) {
    visited.add(element);
    const tag = element.tagName.toLowerCase();
    if (isSkippedElement(element)) return false;
    if (element.hasAttribute(TRANSLATED_ATTR) || element.hasAttribute(TRANSLATION_ID_ATTR)) {
      return false;
    }

    const compat = resolveCompat(element);
    if (compat.skip) return false;
    if (compat.candidate) return compat.candidate;

    if (isTranslationCandidate(element)) {
      if (inlineSet.has(tag)) {
        inlineFallback = element;
      } else {
        return element;
      }
    }

    element = element.parentElement;
  }

  return inlineFallback;
}

const LETTER_RE = /[\p{L}]/u;
const LETTERS_RE = /[\p{L}\p{M}]/gu;
const UNSPACED_SCRIPT_RE =
  /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af\u0e00-\u0e7f]/gu;

interface TextSegment {
  segment: string;
  isWordLike?: boolean;
}

interface TextSegmenter {
  segment(text: string): Iterable<TextSegment>;
}

type SegmenterConstructor = new (
  locales?: string | string[],
  options?: { granularity: 'word' },
) => TextSegmenter;

function createWordSegmenter(): TextSegmenter | null {
  if (typeof Intl === 'undefined') return null;
  const segmenter = (Intl as typeof Intl & { Segmenter?: SegmenterConstructor }).Segmenter;
  if (!segmenter) return null;
  try {
    return new segmenter(undefined, { granularity: 'word' });
  } catch {
    return null;
  }
}

function countMeaningfulWords(text: string): number {
  const segmenter = createWordSegmenter();
  if (segmenter) {
    let count = 0;
    for (const part of segmenter.segment(text)) {
      if (part.isWordLike !== false && LETTER_RE.test(part.segment)) count++;
    }
    return count;
  }

  // Older browsers do not expose Intl.Segmenter. Count unspaced CJK,
  // Japanese, Korean, and Thai characters separately instead of collapsing
  // the entire sentence into one whitespace-delimited token.
  const scriptCharacters = text.match(UNSPACED_SCRIPT_RE)?.length ?? 0;
  const remaining = text.replace(UNSPACED_SCRIPT_RE, ' ');
  const ordinaryWords = remaining.match(/[\p{L}\p{M}]+/gu)?.length ?? 0;
  return scriptCharacters + ordinaryWords;
}

/**
 * Detect source-like values which can appear in ordinary elements (for
 * example a release hash rendered in a badge). Code/pre are excluded by the
 * DOM walk, but this check also protects against code accidentally wrapped in
 * a div or span.
 */
export function isPureCodeContent(text: string): boolean {
  if (!text || typeof text !== 'string') return false;
  const value = text.replace(/\s+/gu, ' ').trim();
  if (!value) return false;

  // Real listings live in pre/code. This helper only catches short identifier-
  // like values in ordinary elements. Long prose is never "pure code", even
  // when it embeds a formula, citation, or equals sign — Wikipedia science
  // paragraphs routinely contain LaTeX `{...}` and `=` and must still translate.
  if (countMeaningfulWords(value) >= 8) return false;

  // URLs, email addresses, markup, paths, UUIDs and long hexadecimal hashes
  // are identifiers rather than prose.
  if (
    /^(?:https?:\/\/|ftp:\/\/|www\.)\S+$/i.test(value) ||
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ||
    /^<\/?[A-Za-z][^>]*>$/.test(value) ||
    /^(?:[A-Za-z]:[\\/]|\.{0,2}\/|~\/)[^\s]+$/.test(value) ||
    /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|[0-9a-f]{16,})$/i.test(
      value,
    )
  ) {
    return true;
  }

  // Shell/package-manager and VCS commands are commonly rendered in logs or
  // documentation without a <code> wrapper. The verb/subcommand anchors keep
  // ordinary prose such as “install the package” eligible.
  if (
    /^(?:sudo\s+)?(?:npm|pnpm|yarn|bun|npx)\s+(?:install|i|add|remove|uninstall|update|upgrade|run|exec|dlx|test|build|start|publish)\b/i.test(
      value,
    ) ||
    /^(?:git|hg|svn)\s+(?:clone|checkout|commit|push|pull|fetch|branch|merge|rebase|status|diff|log|show|reset|stash|add|rm|mv|tag|remote|config)\b/i.test(
      value,
    )
  ) {
    return true;
  }

  // Uppercase SQL keywords are a useful signal that this is a query rather
  // than an instruction such as “select an option”.
  if (
    /^(?:SELECT\b[\s\S]*\bFROM\b|INSERT\s+INTO\b|UPDATE\s+\S+\s+SET\b|DELETE\s+FROM\b|(?:CREATE|ALTER|DROP)\s+(?:TABLE|INDEX|VIEW|DATABASE|SCHEMA)\b|WITH\s+\w+\s+AS\s*\()/i.test(
      value,
    ) &&
    /\b(?:SELECT|FROM|INTO|UPDATE|DELETE|CREATE|ALTER|DROP|WHERE|JOIN|SET|VALUES|AS)\b/.test(
      value,
    )
  ) {
    return true;
  }

  // JSON/config payloads and common programming-language statements.
  if (/^[{[][^\n]*[}\]]$/.test(value) && /["':,]/.test(value)) return true;
  if (
    /^(?:(?:async\s+)?(?:const|let|var|function|interface|type|enum|import|export)\b.*[=;{}()<>]|(?:if|for|while|switch|catch)\s*\([^)]*\)|(?:return|throw|new)\b.*[;{}()=]|#!?\/)/.test(
      value,
    )
  ) {
    return true;
  }
  if (
    /^(?:[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\([^)]*\)\s*;?$/.test(value) ||
    /^[\w$.[\]"']+\s*(?:===?|!==?|=>)\s*[^;]+;?$/.test(value) ||
    /^(?:[^{}]+)\{[^{}]*:[^{}]*\}$/.test(value) ||
    /(?:=>|===|!==|&&|\|\||\+\+|--|::)/.test(value)
  ) {
    return true;
  }

  // A single identifier/version token with code punctuation or digits is
  // overwhelmingly a slug, package name, selector, or version number. Keep
  // ordinary hyphenated words eligible for translation.
  if (
    !/\s/.test(value) &&
    /^[A-Za-z0-9_$./\\-]+$/.test(value) &&
    (value.includes('_') ||
      value.includes('.') ||
      value.includes('/') ||
      value.includes('\\') ||
      /\d/.test(value) ||
      /^[a-z]+[A-Z][A-Za-z0-9]*$/.test(value))
  ) {
    return true;
  }

  // Operators/braces only count as code when there is also an assignment or
  // a code-like identifier; a normal sentence containing punctuation should
  // not be rejected.
  return (
    /[{};]/.test(value) &&
    /(?:=|=>|\b(?:true|false|null|undefined|return|function|class)\b)/.test(value)
  );
}

/**
 * Cheap, conservative gate used before a request is queued. It filters
 * one/two-letter labels, symbols, identifiers, code, and values for which
 * a translation cannot add useful information. Length is not a reason to
 * skip: a Wikipedia paragraph of any size remains eligible.
 */
export function shouldTranslateContent(text: string): boolean {
  if (!text || typeof text !== 'string') return false;
  const value = text.replace(/\s+/gu, ' ').trim();
  if (!value || isPureCodeContent(value) || isNumericContent(value)) return false;

  const letters = value.match(LETTERS_RE)?.length ?? 0;
  if (letters < 2 || !LETTER_RE.test(value)) return false;

  // A one-token two-letter label (OK, Go, No, etc.) is normally a button
  // state, abbreviation, or name. Longer prose and CJK phrases remain valid.
  const words = value.split(/\s+/u).filter(Boolean);
  if (words.length === 1 && letters <= 2) return false;

  // Require three meaningful words in the unit as a whole. A per-sentence
  // minimum previously rejected Wikipedia paragraphs because citation markers
  // such as "[8][9]" were treated as sentences and vetoed the entire block.
  return countMeaningfulWords(value) >= 3;
}

function isUserIdentifier(text: string): boolean {
  const trimmed = stripWhitespace(text);
  if (!trimmed) return false;
  if (/^@\w+/.test(trimmed) || /^u\/\w+/.test(trimmed)) return true;
  if (/^id@https?:\/\/(x\.com|twitter\.com)\/[\w-]+\/status\/[0-9]+/.test(trimmed)) return true;
  // Twitter/Weibo follow-row chrome is short ("Follow @name", "关注用户").
  // Do not match ordinary prose such as Wikipedia "Following the …" / "Followed by …".
  if (
    trimmed.length < 50 &&
    (/^关注/.test(trimmed) || /^Follow\b/i.test(trimmed))
  ) {
    return true;
  }
  if (/^(?=.*[0-9_])[A-Za-z0-9_]{1,15}$/.test(trimmed)) return true;
  if (/点击.*\w+/.test(trimmed) && trimmed.length < 50) return true;
  return false;
}

/**
 * Identify numeric/identifier-only content. Deliberately uses ASCII digits
 * rather than `\d`, so Arabic-Indic and Devanagari numerals remain translatable.
 */
export function isNumericContent(text: string): boolean {
  if (!text || typeof text !== 'string') return false;
  const trimmed = stripWhitespace(text);
  if (!trimmed) return false;
  if (isUserIdentifier(trimmed)) return true;
  if (/\s+/.test(trimmed.replace(/[0-9,.\-%+]/g, ''))) return false;

  return (
    /^-?[0-9]+$/.test(trimmed) ||
    /^-?([0-9]{1,3}(,[0-9]{3})+)$/.test(trimmed) ||
    /^[0-9]+\s*[-~]\s*[0-9]+$/.test(trimmed) ||
    /^-?[0-9]+\.[0-9]+$/.test(trimmed) ||
    /^-?[0-9]+(\.[0-9]+)?%$/.test(trimmed) ||
    /^-?[0-9]+(\.[0-9]+)?(e[-+]?[0-9]+)?$/i.test(trimmed) ||
    /^[$€¥£₹₽₩]?\s*-?[0-9]+(,[0-9]{3})*(\.[0-9]+)?$/.test(trimmed) ||
    /^([0-9]{4}[-/][0-9]{1,2}[-/][0-9]{1,2}|[0-9]{1,2}[-/][0-9]{1,2}[-/][0-9]{4}|[0-9]{1,2}[-/][0-9]{1,2}[-/][0-9]{1,2})$/.test(
      trimmed,
    ) ||
    /^[0-9]{1,2}:[0-9]{2}(:[0-9]{2})?$/.test(trimmed) ||
    /^[0-9]+(\.[0-9]+){1,3}(-[a-zA-Z0-9]+)?$/.test(trimmed) ||
    /^id@https?:\/\/(x\.com|twitter\.com)\/[\w-]+\/status\/[0-9]+/.test(trimmed) ||
    /^ID[:：]?\s*[0-9]+$/.test(trimmed) ||
    /^No[\.:]?\s*[0-9]+$/i.test(trimmed) ||
    /^#[0-9]+$/.test(trimmed)
  );
}

/**
 * Produce the HTML shape sent to an LLM while preserving inline formatting.
 * Extension-owned nodes are omitted, preventing a retry/observer from ever
 * sending a spinner or a previous bilingual result back to the service.
 */
export function LLMStandardHTML(node: Element): string {
  const rootTag = node.tagName.toLowerCase();
  if (
    hasSkippedAncestor(node) ||
    (!['html', 'body'].includes(rootTag) &&
      (isSkippedElement(node) || !isVisible(node)))
  ) {
    return '';
  }

  const serialize = (current: Node): string => {
    if (current.nodeType === Node.TEXT_NODE) return current.nodeValue || '';
    if (!(current instanceof Element)) return '';

    const tag = current.tagName.toLowerCase();
    // Keep serialization consistent with getTranslatableText(). In
    // particular, a visible parent may contain hidden or translate="no"
    // descendants that must not leak into the request.
    if (isOwnedElement(current) || isSkippedElement(current) || !isVisible(current)) return '';

    if (inlineSet.has(tag)) {
      // Serialize children through the same skip rules. A deep clone would
      // accidentally put nested <code>, <svg>, or extension UI back into the
      // request even though those subtrees are excluded at the root walk.
      const clone = current.cloneNode(false) as Element;
      clone.innerHTML = Array.from(current.childNodes).map(serialize).join('');
      clone.removeAttribute(TRANSLATED_ATTR);
      clone.removeAttribute(TRANSLATION_ID_ATTR);
      // Image descriptions belong to the image, not the surrounding prose.
      // Remove them from every nested image as well as a direct <img>/<br>
      // unit, while leaving the live page attributes untouched.
      [clone, ...clone.querySelectorAll('img, br, wbr')].forEach((element) => {
        element.removeAttribute('alt');
        element.removeAttribute('title');
        element.removeAttribute('aria-label');
      });
      return clone.outerHTML;
    }

    return Array.from(current.childNodes).map(serialize).join('');
  };

  return Array.from(node.childNodes).map(serialize).join('');
}

export function beautyHTML(text: string): string {
  if (!text) return '';
  return html(replaceSensitiveWords(text));
}

function replaceSensitiveWords(text: string): string {
  return text.replace(
    /viewbox|preserveaspectratio|clippathunits|gradienttransform|patterncontentunits|lineargradient|clippath/gi,
    (match) => {
      switch (match.toLowerCase()) {
        case 'viewbox':
          return 'viewBox';
        case 'preserveaspectratio':
          return 'preserveAspectRatio';
        case 'clippathunits':
          return 'clipPathUnits';
        case 'gradienttransform':
          return 'gradientTransform';
        case 'patterncontentunits':
          return 'patternContentUnits';
        case 'lineargradient':
          return 'linearGradient';
        case 'clippath':
          return 'clipPath';
        default:
          return match;
      }
    },
  );
}

export function checkAndRemoveStyle(node: any, styleProperty: any) {
  if (node?.style && node.style[styleProperty] !== undefined) node.style[styleProperty] = '';
}

export function smashTruncationStyle(node: any) {
  if (!node?.style) return;
  checkAndRemoveStyle(node, 'webkitLineClamp');
  node.style.webkitLineClamp = 'unset';
  node.style.maxHeight = 'unset';
}
