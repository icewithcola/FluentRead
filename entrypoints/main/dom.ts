import { html } from 'js-beautify';
import { getMainDomain, selectCompatFn } from '@/entrypoints/main/compat';

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
  'script',
  'style',
  'noscript',
  'iframe',
  'input',
  'textarea',
  'select',
  'code',
  'pre',
  'figcaption',
  'nav',
  'aside',
  'header',
  'footer',
  'audio',
  'video',
  'canvas',
  'svg',
]);

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
    if (skipSet.has(tag) || isOwnedElement(child)) return false;
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
  return !isOwnedElement(element) && hasMeaningfulText(element.textContent);
}

function isOversized(element: Element): boolean {
  const text = element.textContent || '';
  const meaningfulLength = countMeaningfulChars(stripWhitespace(text));
  return text.length > 3072 || element.outerHTML.length > 4096 || meaningfulLength === 0;
}

function isMainlyNumericContent(element: Element): boolean {
  const text = stripWhitespace(element.textContent || '');
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
  const tag = element.tagName.toLowerCase();
  return (
    !skipSet.has(tag) &&
    !isInsideExcludedTree(element) &&
    !element.hasAttribute(TRANSLATED_ATTR) &&
    !element.hasAttribute(TRANSLATION_ID_ATTR) &&
    !(typeof HTMLElement !== 'undefined' && element instanceof HTMLElement && element.isContentEditable) &&
    isVisible(element) &&
    hasTranslatableText(element) &&
    !isMainlyNumericContent(element) &&
    !isOversized(element)
  );
}

/** Return whether an element is a complete translation unit. */
export function isTranslationCandidate(element: Element): boolean {
  if (!isSafeElement(element)) return false;

  const tag = element.tagName.toLowerCase();
  if (tag === 'button' || directSet.has(tag)) return true;

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
  if (result && typeof result === 'object' && result.skip === true) return { skip: true };
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
    const tag = element.tagName.toLowerCase();
    if (
      skipSet.has(tag) ||
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

    Array.from(element.children).forEach(visit);
  };

  if (rootNode instanceof Element) {
    // `document.body` is a scan root, not a translation boundary. The same
    // applies to callers passing an html/body wrapper explicitly.
    if (skipSet.has(rootNode.tagName.toLowerCase())) {
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
    if (skipSet.has(tag)) return false;
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

function countMeaningfulChars(text: string): number {
  const matches = text.match(/[a-zA-Z0-9\u4e00-\u9fff\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF]/g);
  return matches ? matches.length : 0;
}

function isUserIdentifier(text: string): boolean {
  const trimmed = stripWhitespace(text);
  if (!trimmed) return false;
  if (/^@\w+/.test(trimmed) || /^u\/\w+/.test(trimmed)) return true;
  if (/^id@https?:\/\/(x\.com|twitter\.com)\/[\w-]+\/status\/[0-9]+/.test(trimmed)) return true;
  if (/关注.*\w+/.test(trimmed) || /Follow.*\w+/.test(trimmed)) return true;
  if (/^[A-Za-z0-9_]{1,15}$/.test(trimmed)) return true;
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
  const serialize = (current: Node): string => {
    if (current.nodeType === Node.TEXT_NODE) return current.nodeValue || '';
    if (!(current instanceof Element)) return '';

    const tag = current.tagName.toLowerCase();
    if (isOwnedElement(current) || skipSet.has(tag)) return '';

    if (inlineSet.has(tag)) {
      const clone = current.cloneNode(true) as Element;
      clone.querySelectorAll(`[${OWNED_ATTR}], .fluent-read-loading, .fluent-read-retry-wrapper`).forEach(
        (owned) => owned.remove(),
      );
      clone.removeAttribute(TRANSLATED_ATTR);
      clone.removeAttribute(TRANSLATION_ID_ATTR);
      if (tag === 'img' || tag === 'br' || tag === 'wbr') {
        clone.removeAttribute('alt');
        clone.removeAttribute('title');
        clone.removeAttribute('aria-label');
      }
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
