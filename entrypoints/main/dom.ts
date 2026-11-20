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
  'nav',
  'aside',
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
  'header',
  'footer',
  'figcaption',
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
export const SCOPED_ATTR = 'data-fr-scoped';

const COMPOUND_DIRECT_TAGS = new Set(['li', 'dd', 'blockquote']);
const ALWAYS_STRUCTURAL_BLOCK_TAGS = new Set([
  'ul',
  'ol',
  'dl',
  'pre',
  'table',
  'blockquote',
  'details',
  'figure',
]);
const NESTED_BLOCK_CHILD_TAGS = new Set([
  ...ALWAYS_STRUCTURAL_BLOCK_TAGS,
  'p',
  'div',
  'section',
  'article',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
]);

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
  'samp',
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

export function isSkippedElement(element: Element): boolean {
  const tag = element.tagName.toLowerCase();
  if (skipSet.has(tag)) return true;
  const roles = element.getAttribute('role')?.toLowerCase().split(/\s+/u) ?? [];
  if (roles.some((role) => skipRoleSet.has(role))) return true;
  if (tag === 'header') {
    return !element.parentElement?.closest('article, main, section');
  }
  if (tag === 'footer') {
    return !element.parentElement?.closest('article, blockquote, section');
  }
  return false;
}

export function hasSkippedAncestor(element: Element): boolean {
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

const INLINE_CODE_LIKE_TAGS = new Set(['code', 'kbd', 'samp', 'var']);
const MATH_CONTAINER_SELECTOR =
  'math, mjx-container, .mwe-math-element, .katex, .MathJax, .math-inline, .math-tex';

function isInlineMathElement(element: Element): boolean {
  if (!element.matches(MATH_CONTAINER_SELECTOR)) return false;
  if (element.parentElement?.closest(MATH_CONTAINER_SELECTOR)) return false;
  return true;
}

function cleanTeXAnnotation(raw: string): string {
  return raw
    .replace(/^\s*\{\\displaystyle\s*([\s\S]*?)\}\s*$/, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractInlineMathText(element: Element): string {
  const annotation = element.querySelector('annotation[encoding*="tex" i]')?.textContent?.trim();
  const attrText =
    element.getAttribute('alttext') ||
    element.querySelector('[alttext]')?.getAttribute('alttext') ||
    element
      .querySelector('img.mwe-math-fallback-image-inline, img.mwe-math-fallback-image-display')
      ?.getAttribute('alt') ||
    element.getAttribute('aria-label');

  const tex = cleanTeXAnnotation(annotation || attrText || '');
  if (tex) {
    return tex.startsWith('$') ? tex : `$${tex}$`;
  }

  const mathNode =
    element.tagName.toLowerCase() === 'math' ? element : element.querySelector('math');
  if (mathNode) {
    const clone = mathNode.cloneNode(true) as Element;
    clone.querySelectorAll('annotation, annotation-xml').forEach((node) => node.remove());
    const mathText = clone.textContent?.replace(/\s+/g, ' ').trim() || '';
    if (mathText) return mathText;
  }

  return element.textContent?.replace(/\s+/g, ' ').trim() || '';
}

export function normalizeInlineCodeKey(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

function extractWrappableInlineCode(text: string): string | null {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (!cleaned) return null;
  if (/[A-Za-z_$/\\-]/.test(cleaned) && !cleaned.includes('`') && cleaned.length <= 80) {
    return cleaned;
  }
  return null;
}

function formatInlineCodeText(text: string): string {
  const wrappable = extractWrappableInlineCode(text);
  if (wrappable) {
    return `\`${wrappable}\``;
  }
  return text.replace(/\s+/g, ' ').trim();
}

function isElementAtOrAfterBoundary(parent: Element, child: Element, boundary: Element): boolean {
  if (boundary.parentNode !== parent) return false;
  let passedBoundary = false;
  for (const current of Array.from(parent.children)) {
    if (current === boundary) passedBoundary = true;
    if (current === child) return passedBoundary;
  }
  return false;
}

/**
 * Determine whether a direct child of a compound direct block (`li`, `dd`,
 * `blockquote`) starts a nested block subtree rather than inline prose.
 */
export function isNestedBlockChild(element: Element): boolean {
  if (isOwnedElement(element) || isInlineMathElement(element) || !isVisible(element)) {
    return false;
  }
  const tag = element.tagName.toLowerCase();
  if (!NESTED_BLOCK_CHILD_TAGS.has(tag)) return false;
  if (ALWAYS_STRUCTURAL_BLOCK_TAGS.has(tag)) return true;

  if (!hasMeaningfulText(element.textContent)) return false;
  let sibling = element.nextSibling;
  while (sibling) {
    if (sibling.nodeType === Node.TEXT_NODE && hasMeaningfulText(sibling.nodeValue)) {
      return false;
    }
    if (
      sibling instanceof Element &&
      inlineSet.has(sibling.tagName.toLowerCase()) &&
      !isOwnedElement(sibling) &&
      isVisible(sibling) &&
      hasMeaningfulText(sibling.textContent)
    ) {
      return false;
    }
    sibling = sibling.nextSibling;
  }
  return true;
}

export function findFirstNestedBlockChild(element: Element): Element | null {
  if (!COMPOUND_DIRECT_TAGS.has(element.tagName.toLowerCase())) return null;
  for (const child of Array.from(element.children)) {
    if (isNestedBlockChild(child)) return child;
  }
  return null;
}

export function getLeadChildNodes(element: Element, boundary: Element | null): ChildNode[] {
  const all = Array.from(element.childNodes);
  if (!boundary || boundary.parentNode !== element) return all;
  const lead: ChildNode[] = [];
  for (const child of all) {
    if (child === boundary) break;
    lead.push(child);
  }
  return lead;
}

export function getScopedOwnHTML(element: Element, boundary: Element | null): string {
  if (!boundary || boundary.parentNode !== element) return element.innerHTML;
  if (typeof document === 'undefined') return '';
  const wrapper = document.createElement('div');
  for (const child of getLeadChildNodes(element, boundary)) {
    wrapper.appendChild(child.cloneNode(true));
  }
  return wrapper.innerHTML;
}

function extractCleanInlineBoldText(element: Element): string | null {
  if (isSkippedElement(element) || !isVisible(element) || isOwnedElement(element)) return null;
  let hasUnsafeDescendant = false;
  let text = '';
  const walk = (node: Node): void => {
    if (hasUnsafeDescendant) return;
    if (node.nodeType === Node.TEXT_NODE) {
      if (node.nodeValue) text += node.nodeValue;
      return;
    }
    if (!(node instanceof Element)) return;
    const tag = node.tagName.toLowerCase();
    if (
      isOwnedElement(node) ||
      isSkippedElement(node) ||
      !isVisible(node) ||
      INLINE_CODE_LIKE_TAGS.has(tag) ||
      isInlineMathElement(node) ||
      tag === 'strong' ||
      tag === 'b'
    ) {
      hasUnsafeDescendant = true;
      return;
    }
    node.childNodes.forEach(walk);
  };
  element.childNodes.forEach(walk);
  if (hasUnsafeDescendant) return null;
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (!cleaned || cleaned.length > 120 || cleaned.includes('*') || cleaned.includes('$')) {
    return null;
  }
  return cleaned;
}

/**
 * Text that remains after removing non-content subtrees from a translation unit.
 * Inline code and math expressions can be retained as context without making a
 * code-only or math-only wrapper eligible for translation.
 */
export function getTranslatableText(
  element: Element,
  includeInlineCode = true,
  options?: { preserveBold?: boolean },
): string {
  if (hasSkippedAncestor(element)) return '';
  const preserveBold = Boolean(options?.preserveBold);
  const parts: string[] = [];
  const visit = (node: Node, isRoot = false): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      if (node.nodeValue) parts.push(node.nodeValue);
      return;
    }
    if (!(node instanceof Element)) return;
    if (isOwnedElement(node)) return;

    // Inline math containers (KaTeX, MathJax, Wikipedia MathML) often carry
    // `aria-hidden="true"` or `notranslate`, or use <math> which is in skipSet.
    // Extract their formula representation before visibility/skip checks so
    // surrounding sentences do not lose subjects or objects.
    if (isInlineMathElement(node)) {
      if (!includeInlineCode || node.hasAttribute('hidden')) return;
      const mathText = extractInlineMathText(node);
      if (mathText) parts.push(mathText);
      return;
    }

    // Code/kbd/samp/var are not standalone translation candidates, but inline
    // code often supplies an essential subject or API name for the surrounding
    // prose. Wrap ASCII/symbol identifiers in backticks so LLMs keep them intact.
    const tag = node.tagName.toLowerCase();
    if (INLINE_CODE_LIKE_TAGS.has(tag)) {
      if (!includeInlineCode || !isVisible(node)) return;
      const formatted = formatInlineCodeText(node.textContent || '');
      if (formatted) parts.push(formatted);
      return;
    }

    if (isSkippedElement(node) || !isVisible(node)) {
      return;
    }

    if (preserveBold && !isRoot && (tag === 'strong' || tag === 'b')) {
      const boldText = extractCleanInlineBoldText(node);
      if (boldText) {
        parts.push(`**${boldText}**`);
        return;
      }
    }

    node.childNodes.forEach((child) => visit(child, false));
  };

  if (isOwnedElement(element) || isSkippedElement(element) || !isVisible(element)) {
    return '';
  }
  const boundary = findFirstNestedBlockChild(element);
  if (boundary) {
    getLeadChildNodes(element, boundary).forEach((child) => visit(child, false));
  } else {
    visit(element, true);
  }
  return parts.join(' ');
}

/**
 * Collect normalized values of inline code elements (`code`/`kbd`/`samp`/`var`)
 * that `getTranslatableText` wrapped in synthetic backticks. Any value that also
 * appears inside literal backticks in the element's plain text is excluded so
 * real backticks in page prose or Markdown fences are never turned into `<code>`.
 */
export function getTranslatableInlineCodeValues(element: Element): Set<string> {
  const syntheticCodes = new Set<string>();
  if (
    hasSkippedAncestor(element) ||
    isOwnedElement(element) ||
    isSkippedElement(element) ||
    !isVisible(element)
  ) {
    return syntheticCodes;
  }

  const plainParts: string[] = [];
  const visit = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      if (node.nodeValue) plainParts.push(node.nodeValue);
      return;
    }
    if (!(node instanceof Element)) return;
    if (isOwnedElement(node)) return;

    if (isInlineMathElement(node)) {
      plainParts.push(' ');
      return;
    }

    const tag = node.tagName.toLowerCase();
    if (INLINE_CODE_LIKE_TAGS.has(tag)) {
      if (!isVisible(node)) return;
      plainParts.push(' ');
      const wrappable = extractWrappableInlineCode(node.textContent || '');
      if (wrappable) {
        syntheticCodes.add(normalizeInlineCodeKey(wrappable));
      }
      return;
    }

    if (isSkippedElement(node) || !isVisible(node)) {
      return;
    }

    node.childNodes.forEach(visit);
  };

  const boundary = findFirstNestedBlockChild(element);
  if (boundary) {
    getLeadChildNodes(element, boundary).forEach(visit);
  } else {
    visit(element);
  }

  if (syntheticCodes.size === 0) return syntheticCodes;

  const plainText = plainParts.join('');
  if (!plainText.includes('`')) return syntheticCodes;

  let i = 0;
  while (i < plainText.length) {
    if (plainText[i] !== '`') {
      i++;
      continue;
    }
    if (plainText[i + 1] === '`') {
      while (i < plainText.length && plainText[i] === '`') i++;
      continue;
    }
    const closeTick = plainText.indexOf('`', i + 1);
    if (closeTick > i + 1 && plainText[closeTick + 1] !== '`') {
      const val = plainText.slice(i + 1, closeTick);
      if (!val.includes('\n') && val.length <= 100) {
        const key = normalizeInlineCodeKey(val);
        if (syntheticCodes.has(key)) {
          syntheticCodes.delete(key);
          i = closeTick + 1;
          continue;
        }
      }
    }
    i++;
  }

  return syntheticCodes;
}

export function isOwnedElement(element: Element): boolean {
  return (
    element.hasAttribute(OWNED_ATTR) ||
    element.classList.contains('fluent-read-loading') ||
    element.classList.contains('fluent-read-bilingual-content') ||
    element.classList.contains('fluent-read-retry-wrapper')
  );
}

/**
 * Check whether an element or any ancestor is actively owned/translated, while
 * allowing nested block subtrees below a scoped compound parent boundary.
 */
export function hasActiveTranslatedAncestor(element: Element, includeSelf = false): boolean {
  if (
    includeSelf &&
    (isOwnedElement(element) ||
      element.hasAttribute(TRANSLATED_ATTR) ||
      element.hasAttribute(TRANSLATION_ID_ATTR) ||
      element.id?.startsWith('fluent-read-'))
  ) {
    return true;
  }

  let child: Element = element;
  let parent = element.parentElement;
  while (parent) {
    if (isOwnedElement(parent) || parent.id?.startsWith('fluent-read-')) {
      return true;
    }
    if (parent.hasAttribute(TRANSLATED_ATTR) || parent.hasAttribute(TRANSLATION_ID_ATTR)) {
      if (parent.hasAttribute(SCOPED_ATTR)) {
        const boundary = findFirstNestedBlockChild(parent);
        if (boundary && isElementAtOrAfterBoundary(parent, child, boundary)) {
          child = parent;
          parent = parent.parentElement;
          continue;
        }
      }
      return true;
    }
    child = parent;
    parent = parent.parentElement;
  }
  return false;
}

/**
 * Translation discovery must not descend into FluentRead UI, an existing
 * translation, or extension-owned status/retry markup. This is intentionally
 * separate from `isOwnedElement`: serialization runs inside a translated root
 * and only needs to remove the owned descendants themselves.
 */
function isInsideExcludedTree(element: Element): boolean {
  return hasActiveTranslatedAncestor(element, true);
}

/**
 * Check visibility without treating every jsdom/hidden-layout element as
 * invisible. The computed-style check is only used when it has an explicit
 * hidden value, which also handles fixed-position elements correctly.
 */
export function isVisible(element: Element): boolean {
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

    // Screen-reader-only controls are commonly hidden with a zero-area
    // legacy `clip: rect(...)` rule. Google search uses this for its skip
    // links until they receive focus. Unlike display:none, their containing
    // wrapper remains visible, so excluding the clipped descendant here keeps
    // that wrapper from becoming a translation unit.
    const clip = style.clip;
    const clipValues = clip.match(/^rect\(\s*([^,\s]+)\s*,?\s*([^,\s]+)\s*,?\s*([^,\s]+)\s*,?\s*([^,\s]+)\s*\)$/i);
    if (
      clipValues &&
      !clipValues.slice(1).some((value) => value.toLowerCase() === 'auto') &&
      clipValues[1] === clipValues[3] &&
      clipValues[2] === clipValues[4]
    ) {
      return false;
    }
  }
  return true;
}

function hasBlockDescendant(element: Element): boolean {
  return Array.from(element.children).some((child) => {
    const tag = child.tagName.toLowerCase();
    if (isSkippedElement(child) || isOwnedElement(child) || !isVisible(child)) return false;
    if (!hasMeaningfulText(child.textContent)) return false;
    // Inline wrappers such as Google Search's result link can contain a
    // heading. The heading is the stable translation unit; selecting the
    // wrapper instead appends bilingual text outside the title and lets the
    // site's layout reorder it.
    return !inlineSet.has(tag) || hasBlockDescendant(child);
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

const shortContentTagSet = new Set([
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'td',
  'th',
  'caption',
  'figcaption',
  'dt',
  'dd',
  'summary',
]);

export function minWordsForElement(element?: Element | null): number {
  if (!element) return 3;
  const tag = element.tagName.toLowerCase();
  if (shortContentTagSet.has(tag)) return 2;
  if (element.closest('td, th, figcaption, caption')) return 2;
  return 3;
}

const NON_CONTENT_LIST_ROLES = new Set([
  'navigation',
  'menu',
  'menubar',
  'tablist',
  'toolbar',
  'tree',
  'listbox',
  'breadcrumb',
]);
const CONTENT_LANDMARK_SELECTOR =
  'article, main, [role="main"], .markdown-body, .prose, .post-content, .article-content, .entry-content';
const ACRONYM_ONLY_RE = /^[A-Z0-9_-]{2,8}$/;

function getDirectListItems(list: Element): Element[] {
  return Array.from(list.children).filter(
    (child) => child.tagName.toLowerCase() === 'li' && !isOwnedElement(child) && isVisible(child),
  );
}

function getDirectDefinitionElements(dl: Element): { dts: Element[]; dds: Element[] } {
  const dts: Element[] = [];
  const dds: Element[] = [];
  for (const child of Array.from(dl.children)) {
    if (isOwnedElement(child) || !isVisible(child)) continue;
    const tag = child.tagName.toLowerCase();
    if (tag === 'dt') {
      dts.push(child);
    } else if (tag === 'dd') {
      dds.push(child);
    } else if (tag === 'div') {
      for (const nested of Array.from(child.children)) {
        if (isOwnedElement(nested) || !isVisible(nested)) continue;
        const nestedTag = nested.tagName.toLowerCase();
        if (nestedTag === 'dt') dts.push(nested);
        else if (nestedTag === 'dd') dds.push(nested);
      }
    }
  }
  return { dts, dds };
}

function isLinkOnlyShortListItem(item: Element): boolean {
  const significantChildren = Array.from(item.childNodes).filter((child) => {
    if (child.nodeType === Node.TEXT_NODE) return hasMeaningfulText(child.nodeValue);
    if (!(child instanceof Element)) return false;
    return !isOwnedElement(child) && isVisible(child);
  });
  if (significantChildren.length !== 1) return false;
  const only = significantChildren[0];
  if (!(only instanceof Element) || only.tagName.toLowerCase() !== 'a') return false;
  return countMeaningfulWords(getTranslatableText(item, false)) < 3;
}

export function isContentList(element: Element): boolean {
  const tag = element.tagName.toLowerCase();
  if (tag !== 'ul' && tag !== 'ol' && tag !== 'dl') return false;
  if (
    !element.isConnected ||
    !isVisible(element) ||
    isSkippedElement(element) ||
    hasSkippedAncestor(element) ||
    isInsideExcludedTree(element)
  ) {
    return false;
  }

  const roles = element.getAttribute('role')?.toLowerCase().split(/\s+/u).filter(Boolean) ?? [];
  if (roles.some((role) => NON_CONTENT_LIST_ROLES.has(role))) return false;
  if (
    element.closest(
      '[role="navigation"], [role="menu"], [role="menubar"], [role="tablist"], [role="toolbar"], [role="breadcrumb"]',
    )
  ) {
    return false;
  }
  const ariaLabel = element.getAttribute('aria-label') || '';
  if (/\b(?:pagination|breadcrumb)\b/i.test(ariaLabel)) return false;

  if (tag === 'dl') {
    const { dts, dds } = getDirectDefinitionElements(element);
    return dts.length >= 1 && dds.length >= 1;
  }

  const items = getDirectListItems(element);
  if (items.length < 2) return false;

  const interactiveCount = items.filter((item) =>
    Boolean(item.querySelector('button, select, textarea, input:not([type="checkbox"])')),
  ).length;
  if (interactiveCount / items.length > 0.5) return false;

  if (!element.closest(CONTENT_LANDMARK_SELECTOR)) {
    const linkOnlyCount = items.filter((item) => isLinkOnlyShortListItem(item)).length;
    if (linkOnlyCount / items.length > 0.8) return false;
  }

  return true;
}

export function isContentTable(element: Element): boolean {
  if (element.tagName.toLowerCase() !== 'table') return false;
  if (
    !element.isConnected ||
    !isVisible(element) ||
    isSkippedElement(element) ||
    hasSkippedAncestor(element) ||
    isInsideExcludedTree(element)
  ) {
    return false;
  }

  if (element.querySelector('table, article, section, main, form')) return false;

  const visibleRows = Array.from(element.querySelectorAll('tr')).filter(
    (tr) => tr.closest('table') === element && isVisible(tr),
  );
  if (visibleRows.length < 2 && !element.querySelector('thead, th')) return false;

  const cellsWithText = Array.from(element.querySelectorAll('td, th')).filter(
    (cell) =>
      cell.closest('table') === element &&
      isVisible(cell) &&
      hasMeaningfulText(getTranslatableText(cell, false)),
  );
  return cellsWithText.length >= 2;
}

function resolveStructuredHostItem(element: Element): { tag: string; host: Element } | null {
  const tag = element.tagName.toLowerCase();
  if (tag === 'li' || tag === 'dt' || tag === 'dd' || tag === 'td' || tag === 'th') {
    return { tag, host: element };
  }
  if (tag === 'p') {
    const parent = element.parentElement;
    if (!parent) return null;
    const parentTag = parent.tagName.toLowerCase();
    if (parentTag !== 'li' && parentTag !== 'dd' && parentTag !== 'td' && parentTag !== 'th') {
      return null;
    }
    const hasLeadDirectText = Array.from(parent.childNodes).some(
      (child) => child.nodeType === Node.TEXT_NODE && hasMeaningfulText(child.nodeValue),
    );
    if (hasLeadDirectText) return null;
    const directBlocks = Array.from(parent.children).filter(
      (child) =>
        !isOwnedElement(child) &&
        isVisible(child) &&
        !['ul', 'ol', 'dl'].includes(child.tagName.toLowerCase()),
    );
    if (directBlocks.length === 1 && directBlocks[0] === element) {
      return { tag: parentTag, host: parent };
    }
  }
  return null;
}

function findListLeadInSibling(list: Element): Element | null {
  let prev = list.previousElementSibling;
  let steps = 0;
  while (prev && steps < 2) {
    steps++;
    const tag = prev.tagName.toLowerCase();
    if (
      !isSkippedElement(prev) &&
      isVisible(prev) &&
      !isOwnedElement(prev) &&
      hasMeaningfulText(prev.textContent)
    ) {
      if (/^(?:p|h[2-6]|figcaption)$/.test(tag)) return prev;
      return null;
    }
    prev = prev.previousElementSibling;
  }
  return null;
}

export function canExemptShortStructuredItem(element: Element, plainText?: string): boolean {
  const resolved = resolveStructuredHostItem(element);
  if (!resolved) return false;

  const raw = plainText !== undefined ? plainText : getTranslatableText(element, false);
  const value = raw.replace(/\s+/gu, ' ').trim();
  if (!value || isPureCodeContent(value) || isNumericContent(value)) return false;
  if (ACRONYM_ONLY_RE.test(value)) return false;

  const letters = value.match(LETTERS_RE)?.length ?? 0;

  if (resolved.tag === 'li') {
    const list = resolved.host.closest('ul, ol');
    if (!list || !isContentList(list) || letters < 3) return false;

    const leadIn = findListLeadInSibling(list);
    if (leadIn && countMeaningfulWords(getTranslatableText(leadIn, false)) >= 2) {
      return true;
    }

    const siblings = getDirectListItems(list);
    const wordCounts = siblings.map((sib) => countMeaningfulWords(getTranslatableText(sib, false)));
    if (wordCounts.some((count) => count >= 3)) return true;
    const twoPlusCount = wordCounts.filter((count) => count >= 2).length;
    return siblings.length > 0 && twoPlusCount / siblings.length >= 0.4;
  }

  if (resolved.tag === 'dt') {
    const dl = resolved.host.closest('dl');
    if (!dl || !isContentList(dl) || letters < 2) return false;
    const { dds } = getDirectDefinitionElements(dl);
    return dds.some((dd) => countMeaningfulWords(getTranslatableText(dd, false)) >= 2);
  }

  if (resolved.tag === 'dd') {
    const dl = resolved.host.closest('dl');
    return Boolean(dl && isContentList(dl) && letters >= 2);
  }

  if (resolved.tag === 'td' || resolved.tag === 'th') {
    const table = resolved.host.closest('table');
    return Boolean(table && isContentTable(table) && letters >= 2);
  }

  return false;
}

export function shouldTranslateElement(element: Element): boolean {
  const text = getTranslatableText(element, false);
  if (shouldTranslateContent(text, minWordsForElement(element))) {
    return true;
  }
  if (canExemptShortStructuredItem(element, text)) {
    return shouldTranslateContent(text, 1, true);
  }
  return false;
}

function hasTranslatableText(element: Element): boolean {
  // Inline code enriches a prose translation, but code alone is not prose.
  return !isOwnedElement(element) && shouldTranslateElement(element);
}

function isMainlyNumericContent(element: Element): boolean {
  const text = stripWhitespace(getTranslatableText(element));
  if (!text) return false;
  if (text.length < 30 && isNumericContent(text)) return true;

  const textNodes: string[] = [];
  if (typeof document !== 'undefined') {
    const showText = typeof NodeFilter === 'undefined' ? 4 : NodeFilter.SHOW_TEXT;
    const boundary = findFirstNestedBlockChild(element);
    if (boundary) {
      for (const leadNode of getLeadChildNodes(element, boundary)) {
        if (leadNode.nodeType === Node.TEXT_NODE) {
          const value = stripWhitespace(leadNode.textContent || '');
          if (value) textNodes.push(value);
        } else if (leadNode instanceof Element && !isOwnedElement(leadNode)) {
          const walker = document.createTreeWalker(leadNode, showText);
          let current: Node | null;
          while ((current = walker.nextNode())) {
            const value = stripWhitespace(current.textContent || '');
            if (value) textNodes.push(value);
          }
        }
      }
    } else {
      const walker = document.createTreeWalker(element, showText);
      let current: Node | null;
      while ((current = walker.nextNode())) {
        const value = stripWhitespace(current.textContent || '');
        if (value) textNodes.push(value);
      }
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
    return !hasBlockDescendant(element);
  }

  // Standalone links and inline fragments are useful for hover translation,
  // but wrappers around a nested block must yield to that block.
  return (
    inlineSet.has(tag) &&
    !hasBlockDescendant(element) &&
    (hasMeaningfulText(element.textContent) || hasInlineContent(element))
  );
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
    if (isSkippedElement(element) || !isVisible(element) || isOwnedElement(element)) {
      return;
    }

    if (isInsideExcludedTree(element)) {
      if (element.hasAttribute(SCOPED_ATTR) && !hasActiveTranslatedAncestor(element, false)) {
        const nestedBoundary = findFirstNestedBlockChild(element);
        if (nestedBoundary) {
          let sibling: Element | null = nestedBoundary;
          while (sibling) {
            if (isNestedBlockChild(sibling) || !inlineSet.has(sibling.tagName.toLowerCase())) {
              visit(sibling);
            }
            sibling = sibling.nextElementSibling;
          }
        }
      }
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

    const nestedBoundary = findFirstNestedBlockChild(element);
    if (nestedBoundary) {
      if (candidate && !seen.has(candidate)) {
        seen.add(candidate);
        result.push(candidate);
      }
      let sibling: Element | null = nestedBoundary;
      while (sibling) {
        if (isNestedBlockChild(sibling) || !inlineSet.has(sibling.tagName.toLowerCase())) {
          visit(sibling);
        }
        sibling = sibling.nextElementSibling;
      }
      return;
    }

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

    const parent = element.parentElement;
    if (parent && COMPOUND_DIRECT_TAGS.has(parent.tagName.toLowerCase())) {
      const boundary = findFirstNestedBlockChild(parent);
      if (boundary && isElementAtOrAfterBoundary(parent, element, boundary)) {
        return inlineFallback;
      }
    }

    element = parent;
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

export function countMeaningfulWords(text: string): number {
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
export function shouldTranslateContent(
  text: string,
  minWords = 3,
  allowShortSingleToken = false,
): boolean {
  if (!text || typeof text !== 'string') return false;
  const value = text.replace(/\s+/gu, ' ').trim();
  if (!value || isPureCodeContent(value) || isNumericContent(value)) return false;

  const letters = value.match(LETTERS_RE)?.length ?? 0;
  if (letters < 2 || !LETTER_RE.test(value)) return false;

  // A one-token two-letter label (OK, Go, No, etc.) is normally a button
  // state, abbreviation, or name. Longer prose and CJK phrases remain valid.
  const words = value.split(/\s+/u).filter(Boolean);
  if (!allowShortSingleToken && words.length === 1 && letters <= 2) return false;

  // Require three meaningful words in the unit as a whole. A per-sentence
  // minimum previously rejected Wikipedia paragraphs because citation markers
  // such as "[8][9]" were treated as sentences and vetoed the entire block.
  return countMeaningfulWords(value) >= minWords;
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
    // Keep serialization consistent with getTranslatableText().
    if (isOwnedElement(current)) return '';

    if (isInlineMathElement(current)) {
      if (current.hasAttribute('hidden')) return '';
      const mathText = extractInlineMathText(current);
      if (!mathText) return '';
      const mathEl = document.createElement('var');
      mathEl.textContent = mathText;
      return mathEl.outerHTML;
    }

    // In particular, a visible parent may contain hidden or translate="no"
    // descendants that must not leak into the request.
    if (!isVisible(current)) return '';

    // Code-like inline elements must not become standalone translation units,
    // but must stay in an enclosing prose unit. Preserve only their literal
    // text: page-provided markup inside code is presentation, not translatable
    // structure, and could otherwise reintroduce a skipped subtree.
    if (INLINE_CODE_LIKE_TAGS.has(tag)) {
      const code = document.createElement(tag);
      code.textContent = current.textContent || '';
      return code.outerHTML;
    }

    if (isSkippedElement(current)) return '';

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

  const boundary = findFirstNestedBlockChild(node);
  const children = boundary ? getLeadChildNodes(node, boundary) : Array.from(node.childNodes);
  return children.map(serialize).join('');
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

/** Inline styles flattened for bilingual output, remembered for restore. */
const TRUNCATION_SNAPSHOT_ATTR = 'data-fr-truncation-snapshot';

interface TruncationSnapshot {
  lineClamp: string;
  maxHeight: string;
  flexWrap?: string;
  hadStyleAttribute: boolean;
}

function captureTruncationSnapshot(node: HTMLElement): void {
  if (node.hasAttribute(TRUNCATION_SNAPSHOT_ATTR)) return;
  const snapshot: TruncationSnapshot = {
    lineClamp: node.style.getPropertyValue('-webkit-line-clamp') || '',
    maxHeight: node.style.getPropertyValue('max-height') || '',
    flexWrap: node.style.getPropertyValue('flex-wrap') || '',
    hadStyleAttribute: node.hasAttribute('style'),
  };
  node.setAttribute(TRUNCATION_SNAPSHOT_ATTR, JSON.stringify(snapshot));
}

export function smashTruncationStyle(node: any) {
  if (!node?.style) return;
  // Bilingual output is taller than the translated line, so the site's clamp
  // has to go. Remember the site's own inline values first: restore has to put
  // them back, otherwise a `-webkit-line-clamp` set by the page silently stays
  // cancelled after the user turns translation off.
  if (node instanceof HTMLElement) {
    captureTruncationSnapshot(node);
  }
  checkAndRemoveStyle(node, 'webkitLineClamp');
  if (typeof node.style.setProperty === 'function') {
    node.style.setProperty('-webkit-line-clamp', 'unset');
    node.style.setProperty('max-height', 'unset');
  } else {
    node.style.webkitLineClamp = 'unset';
    node.style.maxHeight = 'unset';
  }
}

export function ensureFlexWrapForBilingual(node: HTMLElement): void {
  if (!node?.style) return;
  captureTruncationSnapshot(node);
  node.style.setProperty('flex-wrap', 'wrap', 'important');
}

/** Undo smashTruncationStyle and drop the snapshot marker. */
export function restoreTruncationStyle(node: any) {
  if (!(node instanceof HTMLElement)) return;
  const raw = node.getAttribute(TRUNCATION_SNAPSHOT_ATTR);
  if (raw === null) return;
  node.removeAttribute(TRUNCATION_SNAPSHOT_ATTR);

  let snapshot: TruncationSnapshot | null = null;
  try {
    snapshot = JSON.parse(raw) as TruncationSnapshot;
  } catch {
    return;
  }
  if (!snapshot) return;

  if (snapshot.lineClamp) node.style.setProperty('-webkit-line-clamp', snapshot.lineClamp);
  else node.style.removeProperty('-webkit-line-clamp');
  if (snapshot.maxHeight) node.style.setProperty('max-height', snapshot.maxHeight);
  else node.style.removeProperty('max-height');
  if ('flexWrap' in snapshot) {
    if (snapshot.flexWrap) node.style.setProperty('flex-wrap', snapshot.flexWrap);
    else node.style.removeProperty('flex-wrap');
  }

  // The page may not have had a style attribute at all; do not leave an empty
  // one behind, since some sites key their own styling off its presence.
  if (!snapshot.hadStyleAttribute && !node.getAttribute('style')?.trim()) {
    node.removeAttribute('style');
  }
}
