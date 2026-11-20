import { checkConfig, searchClassName, skipNode } from '../utils/check';
import { cache } from '../utils/cache';
import { options, servicesType } from '../utils/option';
import { insertFailedTip, insertLoadingSpinner } from '../utils/icon';
import { styles } from '@/entrypoints/utils/constant';
import {
  beautyHTML,
  countMeaningfulWords,
  ensureFlexWrapForBilingual,
  findFirstNestedBlockChild,
  getLeadChildNodes,
  getScopedOwnHTML,
  grabNode,
  grabAllNode,
  hasActiveTranslatedAncestor,
  isVisible,
  LLMStandardHTML,
  getTranslatableText,
  restoreTruncationStyle,
  sanitizeTranslationHTML,
  SCOPED_ATTR,
  shouldTranslateElement,
  smashTruncationStyle,
  shouldTranslateContent,
} from '@/entrypoints/main/dom';
import {
  buildSingleItemStructuredContext,
  buildStructuredGroupContext,
  getStructuredGroupInfo,
  partitionBatchItems,
  selectSiblingWindow,
  type StructuredGroupInfo,
} from '@/entrypoints/main/structuredGroup';
import { detectlang, getCjkLanguageTag, throttle } from '@/entrypoints/utils/common';
import { getMainDomain, replaceCompatFn } from '@/entrypoints/main/compat';
import { config } from '@/entrypoints/utils/config';
import {
  translateBatch,
  translateText,
  translateTextStream,
  cancelAllTranslations,
  incrementTranslationCount,
  type BatchTranslationRequestItem,
} from '@/entrypoints/utils/translateApi';
import {
  buildPageContext,
  requestPageSummary,
  cancelSummaryRequest,
  clearCurrentPageSummary,
  warmUpPageSummary,
} from '@/entrypoints/utils/pageSummary';

const TRANSLATED_ATTR = 'data-fr-translated';
const TRANSLATED_ID_ATTR = 'data-fr-node-id';
const OWNED_ATTR = 'data-fr-owned';
const BILINGUAL_CLASS = 'fluent-read-bilingual';
const BILINGUAL_CONTENT_CLASS = 'fluent-read-bilingual-content';
const RTL_TEXT_RE = /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufeff]/;
const BILINGUAL_CACHE_KEY_PREFIX = 'bilingual-v2:';
const BILINGUAL_RICH_CACHE_KEY_PREFIX = 'bilingual-v3:';
const SINGLE_CACHE_KEY_PREFIX = 'single-v2:';

type RecordStatus = 'pending' | 'translating' | 'translated' | 'failed';

export interface BilingualToken {
  type: 'text' | 'bold' | 'code';
  value: string;
}

interface BilingualFormatHint {
  allowBold: boolean;
  allowCode: boolean;
}

interface TranslationRecord {
  id: string;
  element: HTMLElement;
  originalHTML: string;
  originalOuterHTML: string;
  originalText: string;
  requestHTML: string;
  contextInfo: string;
  generation: number;
  status: RecordStatus;
  lastOwnedHTML: string;
  boundary: Element | null;
  groupInfo: StructuredGroupInfo | null;
  sourceHasBold: boolean;
  sourceHasCode: boolean;
  originalFragment?: DocumentFragment;
  preservedLeadingControls?: Node[];
}

interface TranslationContext {
  element: HTMLElement;
  record?: TranslationRecord;
  generation: number;
  sourceHTML: string;
  sourceOuterHTML: string;
  sourceText: string;
  requestHTML: string;
  contextInfo: string;
  lastOwnedHTML: string;
  boundary: Element | null;
  groupInfo: StructuredGroupInfo | null;
  sourceHasBold: boolean;
  sourceHasCode: boolean;
  spinner?: HTMLElement;
  originalFragment?: DocumentFragment;
  preservedLeadingControls?: Node[];
}

let hoverTimer: ReturnType<typeof setTimeout> | undefined;
let nodeIdCounter = 0;
let isAutoTranslating = false;
let sessionGeneration = 0;
let observer: IntersectionObserver | null = null;
let mutationObserver: MutationObserver | null = null;
const inFlightNodes = new Set<Element>();
const records = new WeakMap<Element, TranslationRecord>();
const activeRecords = new Set<TranslationRecord>();
const groupRegistry = new Map<Element, HTMLElement[]>();

const AUTO_BATCH_WINDOW_MS = 25;
const MAX_BATCH_ITEMS = 6;
const MAX_BATCH_CHARS = 1800;

interface PendingAutoItem {
  context: TranslationContext;
  origin: string;
  cacheKey: string;
  isBilingual: boolean;
  groupInfo: StructuredGroupInfo | null;
  element: HTMLElement;
}

let autoBatchQueue: HTMLElement[] = [];
let autoBatchTimer: ReturnType<typeof setTimeout> | undefined;

/** Kept for compatibility with callers that inspect the previous public map. */
export const originalContents = new Map<string, string>();

function markOwned(element: Element | null | undefined): void {
  element?.setAttribute(OWNED_ATTR, 'true');
}

function isOwnedElement(element: Element): boolean {
  return (
    element.hasAttribute(OWNED_ATTR) ||
    element.classList.contains('fluent-read-loading') ||
    element.classList.contains(BILINGUAL_CONTENT_CLASS) ||
    element.classList.contains('fluent-read-retry-wrapper')
  );
}

function getActiveBoundary(context: Pick<TranslationContext, 'element' | 'boundary'>): Element | null {
  return context.boundary && context.boundary.parentNode === context.element
    ? context.boundary
    : null;
}

function findOwnedNodesForHost(
  host: Element,
  selector: string,
  boundary: Element | null,
): HTMLElement[] {
  const matched: HTMLElement[] = [];
  const leadNodes = getLeadChildNodes(host, boundary);
  const visit = (node: Node): void => {
    if (!(node instanceof Element)) return;
    if (
      node !== host &&
      (node.hasAttribute(TRANSLATED_ATTR) || node.hasAttribute(TRANSLATED_ID_ATTR))
    ) {
      return;
    }
    if (node instanceof HTMLElement && node.matches(selector)) {
      matched.push(node);
      return;
    }
    Array.from(node.children).forEach(visit);
  };
  for (const lead of leadNodes) {
    visit(lead);
  }
  return matched;
}

function removeOwnedForHost(host: Element, boundary: Element | null): void {
  findOwnedNodesForHost(
    host,
    `[${OWNED_ATTR}], .fluent-read-loading, .${BILINGUAL_CONTENT_CLASS}, .fluent-read-retry-wrapper`,
    boundary,
  ).forEach((owned) => owned.remove());
}

function removeOwnedDescendants(element: Element): void {
  element
    .querySelectorAll(
      `[${OWNED_ATTR}], .fluent-read-loading, .${BILINGUAL_CONTENT_CLASS}, .fluent-read-retry-wrapper`,
    )
    .forEach((owned) => owned.remove());
}

function stripOwnedHTML(value: string): string {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = value;
  removeOwnedDescendants(wrapper);
  return wrapper.innerHTML;
}

function contentMatches(context: TranslationContext): boolean {
  const current = getScopedOwnHTML(context.element, getActiveBoundary(context));
  return (
    current === context.lastOwnedHTML ||
    stripOwnedHTML(current) === stripOwnedHTML(context.lastOwnedHTML)
  );
}

function syncOwnedContent(context: TranslationContext): void {
  context.lastOwnedHTML = getScopedOwnHTML(context.element, getActiveBoundary(context));
  if (context.record) context.record.lastOwnedHTML = context.lastOwnedHTML;
}

function normalizeCacheSource(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

// v2 includes inline <code> in translation input; v3 preserves **bold** emphasis for LLM output.
// Short 1-2 word structured slots include a structural context hash to avoid cross-context collisions.
function bilingualCacheKey(context: TranslationContext): string {
  const prefix = context.sourceHasBold
    ? BILINGUAL_RICH_CACHE_KEY_PREFIX
    : BILINGUAL_CACHE_KEY_PREFIX;
  const shortPrefix =
    context.groupInfo && countMeaningfulWords(context.sourceText) <= 2
      ? `ctx-${context.groupInfo.shortContextHash}:`
      : '';
  return `${prefix}${shortPrefix}${normalizeCacheSource(context.sourceText)}`;
}

function singleCacheKey(context: TranslationContext): string {
  const shortPrefix =
    context.groupInfo && countMeaningfulWords(context.sourceText) <= 2
      ? `ctx-${context.groupInfo.shortContextHash}:`
      : '';
  return `${SINGLE_CACHE_KEY_PREFIX}${shortPrefix}${normalizeCacheSource(
    context.requestHTML || context.sourceHTML,
  )}`;
}

function isLeadingTaskCheckbox(node: Node): boolean {
  return (
    typeof HTMLInputElement !== 'undefined' &&
    node instanceof HTMLInputElement &&
    node.type.toLowerCase() === 'checkbox'
  );
}

/** Move the original live children out before replacing lead/inner HTML. */
function captureOriginalChildren(context: TranslationContext): void {
  const record = context.record;
  if (record?.originalFragment || context.originalFragment || !context.element.firstChild) return;

  const activeBoundary = getActiveBoundary(context);
  const leadNodes = getLeadChildNodes(context.element, activeBoundary);
  if (leadNodes.length === 0) return;

  const fragment = document.createDocumentFragment();
  const preservedControls: Node[] = [];
  let sawMeaningfulLead = false;

  for (const child of leadNodes) {
    if (child instanceof Element && isOwnedElement(child)) continue;
    if (!sawMeaningfulLead && isLeadingTaskCheckbox(child)) {
      preservedControls.push(child);
      continue;
    }
    if (
      (child.nodeType === Node.TEXT_NODE && Boolean(child.nodeValue?.trim())) ||
      (child instanceof Element && Boolean(child.textContent?.trim()))
    ) {
      sawMeaningfulLead = true;
    }
    fragment.appendChild(child);
  }

  if (record) {
    record.originalFragment = fragment;
    record.preservedLeadingControls = preservedControls.length > 0 ? preservedControls : undefined;
  } else {
    context.originalFragment = fragment;
    context.preservedLeadingControls = preservedControls.length > 0 ? preservedControls : undefined;
  }
}

/** Restore original child node identity, including listeners attached by page code. */
function restoreCapturedChildren(context: TranslationContext): boolean {
  const fragment = context.record?.originalFragment ?? context.originalFragment;
  if (!fragment || !fragment.firstChild || !context.element.isConnected) return false;

  const activeBoundary = getActiveBoundary(context);
  const preservedSet = new Set<Node>(
    context.record?.preservedLeadingControls ?? context.preservedLeadingControls ?? [],
  );

  for (const child of getLeadChildNodes(context.element, activeBoundary)) {
    if (!preservedSet.has(child)) {
      child.parentNode?.removeChild(child);
    }
  }

  context.element.insertBefore(fragment, activeBoundary);
  syncOwnedContent(context);
  return true;
}

function clearCapturedChildren(context: TranslationContext): void {
  if (context.record) {
    context.record.originalFragment = undefined;
    context.record.preservedLeadingControls = undefined;
  }
  context.originalFragment = undefined;
  context.preservedLeadingControls = undefined;
}

function restoreAfterApplyFailure(context: TranslationContext): void {
  if (!restoreCapturedChildren(context)) return;
  context.lastOwnedHTML = context.sourceHTML;
  if (context.record) context.record.lastOwnedHTML = context.lastOwnedHTML;
  clearCapturedChildren(context);
}

function recordIsCurrent(record: TranslationRecord): boolean {
  const element = record.element;
  return (
    records.get(element) === record &&
    activeRecords.has(record) &&
    record.generation === sessionGeneration &&
    element.isConnected &&
    element.getAttribute(TRANSLATED_ID_ATTR) === record.id
  );
}

function contextIsCurrent(context: TranslationContext): boolean {
  if (!context.element.isConnected || context.generation !== sessionGeneration) return false;
  if (context.record && !recordIsCurrent(context.record)) return false;
  return contentMatches(context);
}

function removeSpinner(context: TranslationContext): void {
  context.spinner?.remove();
  context.spinner = undefined;
}

function removeFailureMarker(element: Element, boundary: Element | null = null): void {
  element.classList.remove('fluent-read-failure');
  removeOwnedForHost(element, boundary);
}

function setRecordStatus(record: TranslationRecord, status: RecordStatus): void {
  record.status = status;
  if (!record.element.isConnected) return;
  record.element.setAttribute(TRANSLATED_ATTR, status === 'translated' ? 'true' : status);
}

function releaseRecord(record: TranslationRecord): void {
  activeRecords.delete(record);
  originalContents.delete(record.id);
  if (records.get(record.element) === record) records.delete(record.element);
  if (record.element.getAttribute(TRANSLATED_ID_ATTR) === record.id) {
    record.element.removeAttribute(TRANSLATED_ID_ATTR);
    record.element.removeAttribute(TRANSLATED_ATTR);
    record.element.removeAttribute(SCOPED_ATTR);
  }
}

function createRecord(element: Element, generation: number): TranslationRecord | null {
  if (!(element instanceof HTMLElement) || !element.isConnected) return null;
  if (element.hasAttribute(TRANSLATED_ID_ATTR) || element.hasAttribute(TRANSLATED_ATTR)) return null;
  if (!shouldTranslateElement(element)) {
    return null;
  }

  const boundary = findFirstNestedBlockChild(element);
  const isLlm = servicesType.isUseModel(config.service);
  const originalText = getTranslatableText(element, true, { preserveBold: isLlm });
  const originalHTML = getScopedOwnHTML(element, boundary);

  const record: TranslationRecord = {
    id: `fr-node-${nodeIdCounter++}`,
    element,
    originalHTML,
    originalOuterHTML: element.outerHTML,
    originalText,
    requestHTML: LLMStandardHTML(element),
    contextInfo: buildPageContext(element),
    generation,
    status: 'pending',
    lastOwnedHTML: originalHTML,
    boundary,
    groupInfo: getStructuredGroupInfo(element),
    sourceHasBold: isLlm && /\*\*[^*]+\*\*/.test(originalText),
    sourceHasCode: /`[^`]+`/.test(originalText),
  };
  records.set(element, record);
  activeRecords.add(record);
  originalContents.set(record.id, record.originalHTML);
  element.setAttribute(TRANSLATED_ID_ATTR, record.id);
  element.setAttribute(TRANSLATED_ATTR, 'pending');
  if (boundary) element.setAttribute(SCOPED_ATTR, 'true');
  return record;
}

function beginContext(element: HTMLElement, forceRetry = false): TranslationContext | null {
  const record = records.get(element);
  // Manual hover calls can bypass DOM discovery, so apply the same cheap gate
  // before allocating request state. Existing records keep their captured
  // source, which also makes retries stable if the page changed meanwhile.
  if (!record && !shouldTranslateElement(element)) {
    return null;
  }
  if (record) {
    if (!recordIsCurrent(record)) return null;
    if (record.status === 'translating') return null;
    if (record.status === 'translated' && !forceRetry) return null;

    const activeBoundary =
      record.boundary && record.boundary.parentNode === element ? record.boundary : null;
    // A retry may remove only extension-owned failure UI. If the page changed
    // meanwhile, do not replace the user's current content.
    const beforeCleanup = getScopedOwnHTML(element, activeBoundary);
    if (stripOwnedHTML(beforeCleanup) !== stripOwnedHTML(record.lastOwnedHTML)) return null;
    removeFailureMarker(element, activeBoundary);
    if (record.originalFragment?.firstChild) {
      const preservedSet = new Set<Node>(record.preservedLeadingControls ?? []);
      for (const child of getLeadChildNodes(element, activeBoundary)) {
        if (!preservedSet.has(child)) {
          child.parentNode?.removeChild(child);
        }
      }
      element.insertBefore(record.originalFragment, activeBoundary);
      record.originalFragment = undefined;
      record.preservedLeadingControls = undefined;
    }
    record.status = 'translating';
    record.lastOwnedHTML = record.originalHTML;
    element.setAttribute(TRANSLATED_ATTR, 'pending');
  } else {
    if (inFlightNodes.has(element)) return null;
    inFlightNodes.add(element);
  }

  const boundary = record ? record.boundary : findFirstNestedBlockChild(element);
  const isLlm = servicesType.isUseModel(config.service);
  const sourceText =
    record?.originalText ?? getTranslatableText(element, true, { preserveBold: isLlm });
  const sourceHTML = record?.originalHTML ?? getScopedOwnHTML(element, boundary);

  const context: TranslationContext = {
    element,
    record,
    generation: sessionGeneration,
    sourceHTML,
    sourceOuterHTML: record?.originalOuterHTML ?? element.outerHTML,
    sourceText,
    requestHTML: record?.requestHTML ?? LLMStandardHTML(element),
    contextInfo: record?.contextInfo ?? buildPageContext(element),
    lastOwnedHTML: sourceHTML,
    boundary,
    groupInfo: record ? record.groupInfo : getStructuredGroupInfo(element),
    sourceHasBold: record ? record.sourceHasBold : isLlm && /\*\*[^*]+\*\*/.test(sourceText),
    sourceHasCode: record ? record.sourceHasCode : /`[^`]+`/.test(sourceText),
  };
  return context;
}

function finishWithoutTranslation(context: TranslationContext): void {
  removeSpinner(context);
  if (context.record) {
    restoreCapturedChildren(context);
    clearCapturedChildren(context);
    releaseRecord(context.record);
  } else {
    restoreCapturedChildren(context);
    clearCapturedChildren(context);
    inFlightNodes.delete(context.element);
  }
}

function invalidateContext(context: TranslationContext): void {
  removeSpinner(context);
  // A stale/cancelled stream may have replaced the live children. Restore
  // them only while the current DOM still matches our last applied output;
  // otherwise preserve an independent page mutation.
  const canRestore = context.element.isConnected && contentMatches(context);
  if (!canRestore || !restoreCapturedChildren(context)) {
    if (context.element.isConnected) {
      removeOwnedForHost(context.element, getActiveBoundary(context));
    }
  }
  clearCapturedChildren(context);
  if (context.record && activeRecords.has(context.record)) {
    releaseRecord(context.record);
  } else {
    inFlightNodes.delete(context.element);
  }
}

function finishTranslated(context: TranslationContext): void {
  removeSpinner(context);
  syncOwnedContent(context);
  incrementTranslationCount();
  if (context.record) {
    setRecordStatus(context.record, 'translated');
  } else {
    clearCapturedChildren(context);
    inFlightNodes.delete(context.element);
  }
}

function finishFailed(context: TranslationContext, error: unknown): void {
  if (!contextIsCurrent(context)) {
    invalidateContext(context);
    return;
  }
  const spinner = context.spinner;
  removeSpinner(context);
  restoreAfterApplyFailure(context);
  const activeBoundary = getActiveBoundary(context);
  clearBilingualOutput(context.element, activeBoundary);
  insertFailedTip(
    context.element,
    String(error || '翻译失败'),
    spinner as HTMLElement,
    activeBoundary,
  );
  findOwnedNodesForHost(context.element, '.fluent-read-retry-wrapper', activeBoundary).forEach(
    markOwned,
  );
  syncOwnedContent(context);
  if (context.record) {
    setRecordStatus(context.record, 'failed');
  } else {
    inFlightNodes.delete(context.element);
  }
}

function formatHintForContext(context: Pick<TranslationContext, 'sourceHasBold' | 'sourceHasCode'>): BilingualFormatHint {
  return {
    allowBold: context.sourceHasBold,
    allowCode: context.sourceHasCode,
  };
}

export function tokenizeBilingualFormatting(
  text: string,
  options: { allowBold: boolean; allowCode: boolean },
): BilingualToken[] {
  if (!text) return [];
  const { allowBold, allowCode } = options;
  if (!allowBold && !allowCode) return [{ type: 'text', value: text }];

  const tokens: BilingualToken[] = [];
  let textBuf = '';
  const flushText = () => {
    if (textBuf) {
      tokens.push({ type: 'text', value: textBuf });
      textBuf = '';
    }
  };

  let i = 0;
  while (i < text.length) {
    const ch = text[i];

    // Keep $...$ inline math expressions untouched as plain text while not swallowing $100 ... $200 currency spans.
    if (ch === '$') {
      const closeDollar = text.indexOf('$', i + 1);
      if (closeDollar > i) {
        const inner = text.slice(i + 1, closeDollar);
        if (!inner.includes('\n') && !/^\d+(?:\.\d+)?\s/.test(inner)) {
          textBuf += text.slice(i, closeDollar + 1);
          i = closeDollar + 1;
          continue;
        }
      }
    }

    if (allowCode && ch === '`') {
      const closeTick = text.indexOf('`', i + 1);
      if (closeTick > i + 1) {
        const codeVal = text.slice(i + 1, closeTick);
        if (!codeVal.includes('\n') && codeVal.length <= 100) {
          flushText();
          tokens.push({ type: 'code', value: codeVal });
          i = closeTick + 1;
          continue;
        }
      }
    }

    if (allowBold && ch === '*' && text[i + 1] === '*') {
      const closeBold = text.indexOf('**', i + 2);
      if (closeBold > i + 2) {
        const boldVal = text.slice(i + 2, closeBold);
        if (!boldVal.includes('\n') && boldVal.length <= 140 && boldVal.trim().length > 0) {
          flushText();
          tokens.push({ type: 'bold', value: boldVal });
          i = closeBold + 2;
          continue;
        }
      }
    }

    textBuf += ch;
    i++;
  }

  flushText();
  return tokens;
}

const NON_MOUNTABLE_FLEX_CHILD_TAGS = new Set([
  'svg',
  'img',
  'br',
  'wbr',
  'hr',
  'input',
  'a',
  'code',
  'kbd',
  'samp',
  'var',
]);

function resolveBilingualMountTarget(
  element: HTMLElement,
  boundary: Element | null,
): { mountParent: HTMLElement; beforeNode: Element | null; useFlexBreak: boolean } {
  if (boundary && boundary.parentNode === element) {
    return { mountParent: element, beforeNode: boundary, useFlexBreak: false };
  }

  if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
    const computed = window.getComputedStyle(element);
    const isFlex = computed.display === 'flex' || computed.display === 'inline-flex';
    const isRow = computed.flexDirection === 'row' || computed.flexDirection === 'row-reverse';
    if (isFlex && isRow && computed.flexWrap === 'nowrap') {
      const hasDirectText = Array.from(element.childNodes).some(
        (child) => child.nodeType === Node.TEXT_NODE && Boolean(child.nodeValue?.trim()),
      );
      if (!hasDirectText) {
        const parentTextLen = getTranslatableText(element, false).replace(/\s+/g, '').length;
        if (parentTextLen > 0) {
          for (const child of Array.from(element.children)) {
            if (
              !(child instanceof HTMLElement) ||
              isOwnedElement(child) ||
              !isVisible(child) ||
              NON_MOUNTABLE_FLEX_CHILD_TAGS.has(child.tagName.toLowerCase())
            ) {
              continue;
            }
            const childTextLen = getTranslatableText(child, false).replace(/\s+/g, '').length;
            if (childTextLen / parentTextLen >= 0.9) {
              const childStyle = window.getComputedStyle(child);
              const childRowNowrap =
                (childStyle.display === 'flex' || childStyle.display === 'inline-flex') &&
                childStyle.flexDirection.startsWith('row') &&
                childStyle.flexWrap === 'nowrap';
              if (!childRowNowrap) {
                return { mountParent: child, beforeNode: null, useFlexBreak: false };
              }
            }
          }
        }
      }
      ensureFlexWrapForBilingual(element);
      return { mountParent: element, beforeNode: null, useFlexBreak: true };
    }
  }

  return { mountParent: element, beforeNode: null, useFlexBreak: false };
}

function appendBilingualContent(
  element: HTMLElement,
  text: string,
  optionsArg: { boundary?: Element | null; formatHint?: BilingualFormatHint } = {},
): HTMLElement {
  element.classList.add(BILINGUAL_CLASS);
  const content = document.createElement('span');
  content.className = BILINGUAL_CONTENT_CLASS;
  const cjkLanguage = getCjkLanguageTag(config.to);
  if (cjkLanguage) content.lang = cjkLanguage;
  markOwned(content);
  const style = options.styles.find((item) => item.value === config.style && !item.disabled);
  if (style?.class) content.classList.add(style.class);

  const boundary =
    optionsArg.boundary && optionsArg.boundary.parentNode === element ? optionsArg.boundary : null;
  const { mountParent, beforeNode, useFlexBreak } = resolveBilingualMountTarget(element, boundary);
  if (useFlexBreak) {
    content.classList.add('fluent-read-bilingual-flex-break');
  }

  setTranslationText(content, text, optionsArg.formatHint);
  stabilizeTranslationPlacement(content, mountParent);
  smashTruncationStyle(element);
  if (mountParent !== element) {
    smashTruncationStyle(mountParent);
  }
  if (beforeNode && beforeNode.parentNode === mountParent) {
    mountParent.insertBefore(content, beforeNode);
  } else {
    mountParent.appendChild(content);
  }
  return content;
}

function setTranslationText(
  content: HTMLElement,
  text: string,
  formatHint?: BilingualFormatHint,
): void {
  content.dir = RTL_TEXT_RE.test(text) ? 'rtl' : 'ltr';
  if (!formatHint || (!formatHint.allowBold && !formatHint.allowCode)) {
    content.textContent = text;
    return;
  }

  const tokens = tokenizeBilingualFormatting(text, formatHint);
  while (content.firstChild) content.firstChild.remove();
  for (const token of tokens) {
    if (token.type === 'bold') {
      const strong = document.createElement('strong');
      strong.textContent = token.value;
      content.appendChild(strong);
    } else if (token.type === 'code') {
      const code = document.createElement('code');
      code.className = 'fluent-read-inline-code';
      code.textContent = token.value;
      content.appendChild(code);
    } else {
      content.appendChild(document.createTextNode(token.value));
    }
  }
}

function stabilizeTranslationPlacement(content: HTMLElement, host: HTMLElement): void {
  if (typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') return;
  const computed = window.getComputedStyle(host);
  if (computed.display === 'grid' || computed.display === 'inline-grid') {
    // Appended translations otherwise enter the next available grid cell,
    // which can be a narrow label/marker column on list items.
    content.style.setProperty('grid-column', '1 / -1', 'important');
    return;
  }
  if (computed.display !== 'flex' && computed.display !== 'inline-flex') return;

  // A reversed flex axis makes the last DOM child render before the source.
  // Use an extreme order in the opposite direction so the translation stays
  // visually after the original text on both normal and reversed hosts.
  const reverse = computed.flexDirection.endsWith('-reverse');
  content.style.setProperty('order', reverse ? '-1000000' : '1000000', 'important');
}

function clearBilingualOutput(element: HTMLElement, boundary: Element | null = null): void {
  findOwnedNodesForHost(element, `.${BILINGUAL_CONTENT_CLASS}`, boundary).forEach((content) => {
    const mountParent = content.parentElement;
    content.remove();
    if (mountParent && mountParent !== element) {
      restoreTruncationStyle(mountParent);
    }
  });
  element.classList.remove(BILINGUAL_CLASS);
  restoreTruncationStyle(element);
}

function replaceScopedLeadHTML(
  context: TranslationContext,
  htmlContent: string,
  parsedNodeWrapper?: Element | null,
): string {
  const element = context.element;
  const activeBoundary = getActiveBoundary(context);
  const preservedSet = new Set<Node>(
    context.record?.preservedLeadingControls ?? context.preservedLeadingControls ?? [],
  );
  const finalHTML = parsedNodeWrapper ? parsedNodeWrapper.innerHTML : htmlContent;

  if (!activeBoundary && preservedSet.size === 0) {
    element.innerHTML = finalHTML;
    return element.innerHTML;
  }

  for (const child of getLeadChildNodes(element, activeBoundary)) {
    if (!preservedSet.has(child)) {
      child.parentNode?.removeChild(child);
    }
  }

  const parsed = document.createElement('div');
  parsed.innerHTML = finalHTML;
  const cacheValue = parsed.innerHTML;
  const fragment = document.createDocumentFragment();
  while (parsed.firstChild) fragment.appendChild(parsed.firstChild);
  element.insertBefore(fragment, activeBoundary);
  return cacheValue;
}

function applyCachedHTML(context: TranslationContext, cached: string): boolean {
  const element = context.element;
  const safeCached = sanitizeTranslationHTML(cached, context.sourceHTML);
  const activeBoundary = getActiveBoundary(context);
  const preservedCount = (
    context.record?.preservedLeadingControls ?? context.preservedLeadingControls ?? []
  ).length;
  const replace = replaceCompatFn[getMainDomain(document.location.hostname)];
  const parsed = document.createElement('div');
  parsed.innerHTML = safeCached;
  const replacement = parsed.firstElementChild;
  const hasMatchingOuter =
    !!replacement &&
    replacement.tagName.toLowerCase() === element.tagName.toLowerCase() &&
    parsed.childNodes.length === 1;
  if (replace && hasMatchingOuter && !activeBoundary && preservedCount === 0) {
    replace(element, safeCached);
    return !!element.innerHTML.trim();
  }

  // Cache entries historically contain the full outerHTML. Keep the live
  // element identity and update only its lead children; fall back to the raw value
  // for older/innerHTML-only cache entries.
  const matchingWrapper =
    replacement && replacement.tagName.toLowerCase() === element.tagName.toLowerCase()
      ? replacement
      : null;
  const written = replaceScopedLeadHTML(context, safeCached, matchingWrapper);
  return !!written.trim();
}

function applyTranslatedHTML(context: TranslationContext, translated: string): boolean {
  if (!contextIsCurrent(context)) return false;
  const text = sanitizeTranslationHTML(beautyHTML(translated), context.sourceHTML);
  if (!text || text === context.sourceHTML) {
    finishWithoutTranslation(context);
    return true;
  }

  const element = context.element;
  const activeBoundary = getActiveBoundary(context);
  const replace = replaceCompatFn[getMainDomain(document.location.hostname)];
  removeSpinner(context);
  captureOriginalChildren(context);
  const preservedCount = (
    context.record?.preservedLeadingControls ?? context.preservedLeadingControls ?? []
  ).length;
  const parsed = document.createElement('div');
  parsed.innerHTML = text;
  const matchingOuter =
    parsed.firstElementChild &&
    parsed.firstElementChild.tagName.toLowerCase() === element.tagName.toLowerCase() &&
    parsed.childNodes.length === 1;
  let cacheValue: string;
  if (replace && matchingOuter && !activeBoundary && preservedCount === 0) {
    replace(element, text);
    cacheValue = element.innerHTML;
  } else {
    cacheValue = replaceScopedLeadHTML(
      context,
      text,
      matchingOuter ? parsed.firstElementChild : null,
    );
  }
  syncOwnedContent(context);
  void cache.localSet(singleCacheKey(context), cacheValue);
  finishTranslated(context);
  return true;
}

function applyBilingualStreamChunk(context: TranslationContext, accumulated: string): void {
  if (!accumulated?.trim()) return;
  if (!contextIsCurrent(context)) return;
  const element = context.element;
  const activeBoundary = getActiveBoundary(context);
  const formatHint = formatHintForContext(context);
  let streamNode = findOwnedNodesForHost(
    element,
    `.${BILINGUAL_CONTENT_CLASS}`,
    activeBoundary,
  )[0];
  if (!streamNode) {
    removeSpinner(context);
    streamNode = appendBilingualContent(element, '', {
      boundary: activeBoundary,
      formatHint,
    });
  }
  setTranslationText(streamNode, accumulated, formatHint);
  syncOwnedContent(context);
}

function applyBilingualResult(context: TranslationContext, text: string): void {
  if (!contextIsCurrent(context)) {
    invalidateContext(context);
    return;
  }
  const element = context.element;
  const activeBoundary = getActiveBoundary(context);
  const formatHint = formatHintForContext(context);
  if (!text?.trim()) {
    clearBilingualOutput(element, activeBoundary);
    finishWithoutTranslation(context);
    return;
  }
  removeSpinner(context);
  const existing = findOwnedNodesForHost(
    element,
    `.${BILINGUAL_CONTENT_CLASS}`,
    activeBoundary,
  )[0];
  if (!existing) {
    appendBilingualContent(element, text, {
      boundary: activeBoundary,
      formatHint,
    });
  } else {
    setTranslationText(existing, text, formatHint);
  }
  finishTranslated(context);
}

function applySingleStreamChunk(context: TranslationContext, accumulated: string): void {
  if (!contextIsCurrent(context)) return;
  const element = context.element;
  removeSpinner(context);
  const safeChunk = sanitizeTranslationHTML(accumulated, context.sourceHTML);
  captureOriginalChildren(context);
  const parsed = document.createElement('div');
  parsed.innerHTML = safeChunk;
  const matchingOuter =
    parsed.firstElementChild &&
    parsed.firstElementChild.tagName.toLowerCase() === element.tagName.toLowerCase() &&
    parsed.childNodes.length === 1;
  replaceScopedLeadHTML(context, safeChunk, matchingOuter ? parsed.firstElementChild : null);
  syncOwnedContent(context);
}

function renderCachedBilingualResult(context: TranslationContext, cached: string): void {
  const node = context.element;
  const activeBoundary = getActiveBoundary(context);
  context.spinner = insertLoadingSpinner(node, true, activeBoundary);
  markOwned(context.spinner);
  setTimeout(() => {
    if (!contextIsCurrent(context)) {
      invalidateContext(context);
      return;
    }
    removeSpinner(context);
    try {
      appendBilingualContent(node, cached, {
        boundary: getActiveBoundary(context),
        formatHint: formatHintForContext(context),
      });
      finishTranslated(context);
    } catch (error) {
      finishFailed(context, error);
    }
  }, 250);
}

function renderCachedSingleResult(context: TranslationContext, cached: string): void {
  const node = context.element;
  const activeBoundary = getActiveBoundary(context);
  context.spinner = insertLoadingSpinner(node, true, activeBoundary);
  markOwned(context.spinner);
  setTimeout(() => {
    if (!contextIsCurrent(context)) {
      invalidateContext(context);
      return;
    }
    removeSpinner(context);
    try {
      captureOriginalChildren(context);
      if (!applyCachedHTML(context, cached)) finishWithoutTranslation(context);
      else {
        syncOwnedContent(context);
        finishTranslated(context);
      }
    } catch (error) {
      restoreAfterApplyFailure(context);
      finishFailed(context, error);
    }
  }, 250);
}

const LIST_SLOT_TAGS = new Set(['li', 'dt', 'dd']);

function isListSlotElement(element: Element, groupInfo: StructuredGroupInfo | null): boolean {
  return Boolean(groupInfo) || LIST_SLOT_TAGS.has(element.tagName.toLowerCase());
}

function runBilingualTranslation(context: TranslationContext, forceBypassCache: boolean): void {
  const element = context.element;
  const origin = context.sourceText;
  if (detectlang(origin.replace(/[\s\u3000]/g, '')) === config.to) {
    finishWithoutTranslation(context);
    return;
  }

  context.spinner = insertLoadingSpinner(element, false, getActiveBoundary(context));
  markOwned(context.spinner);

  const onStreamChunk = (accumulated: string) => applyBilingualStreamChunk(context, accumulated);

  if (config.enablePageSummary && servicesType.isUseModel(config.service) && !isAutoTranslating) {
    warmUpPageSummary();
  }

  const isListSlot = isListSlotElement(element, context.groupInfo);
  const request = config.useStream && servicesType.isCustom(config.service)
    ? translateTextStream(origin, context.contextInfo, onStreamChunk, {
        bypassCacheRead: forceBypassCache,
        cacheKey: bilingualCacheKey(context),
        isListSlot,
      })
    : translateText(origin, context.contextInfo, {
        bypassCacheRead: forceBypassCache,
        cacheKey: bilingualCacheKey(context),
        isListSlot,
      });

  request
    .then((text) => applyBilingualResult(context, text))
    .catch((error) => finishFailed(context, error));
}

function runSingleTranslation(context: TranslationContext, forceBypassCache: boolean): void {
  const element = context.element;
  // Always translate the captured source. A failed stream may have replaced
  // the live children with a partial result; serializing that result would
  // feed the model its own output on retry.
  const origin = context.requestHTML;
  if (detectlang(context.sourceText.replace(/[\s\u3000]/g, '')) === config.to) {
    finishWithoutTranslation(context);
    return;
  }

  context.spinner = insertLoadingSpinner(element, false, getActiveBoundary(context));
  markOwned(context.spinner);

  const onStreamChunk = (accumulated: string) => applySingleStreamChunk(context, accumulated);

  if (config.enablePageSummary && servicesType.isUseModel(config.service) && !isAutoTranslating) {
    warmUpPageSummary();
  }

  const isListSlot = isListSlotElement(element, context.groupInfo);
  const request = config.useStream && servicesType.isCustom(config.service)
    ? translateTextStream(origin, context.contextInfo, onStreamChunk, {
        bypassCacheRead: forceBypassCache,
        cacheKey: singleCacheKey(context),
        isListSlot,
      })
    : translateText(origin, context.contextInfo, {
        bypassCacheRead: forceBypassCache,
        cacheKey: singleCacheKey(context),
        isListSlot,
      });

  request
    .then((text) => {
      try {
        if (!applyTranslatedHTML(context, text)) invalidateContext(context);
      } catch (error) {
        restoreAfterApplyFailure(context);
        finishFailed(context, error);
      }
    })
    .catch((error) => finishFailed(context, error));
}

export function restoreOriginalContent(): void {
  sessionGeneration++;
  isAutoTranslating = false;
  if (hoverTimer) clearTimeout(hoverTimer);
  hoverTimer = undefined;
  if (autoBatchTimer) {
    clearTimeout(autoBatchTimer);
    autoBatchTimer = undefined;
  }
  autoBatchQueue = [];
  groupRegistry.clear();
  cancelAllTranslations();
  cancelSummaryRequest();
  clearCurrentPageSummary();

  observer?.disconnect();
  observer = null;
  mutationObserver?.disconnect();
  mutationObserver = null;

  Array.from(activeRecords).forEach((record) => {
    const element = record.element;
    const context: TranslationContext = {
      element,
      record,
      generation: record.generation,
      sourceHTML: record.originalHTML,
      sourceOuterHTML: record.originalOuterHTML,
      sourceText: record.originalText,
      requestHTML: record.requestHTML,
      contextInfo: record.contextInfo,
      lastOwnedHTML: record.lastOwnedHTML,
      boundary: record.boundary,
      groupInfo: record.groupInfo,
      sourceHasBold: record.sourceHasBold,
      sourceHasCode: record.sourceHasCode,
      preservedLeadingControls: record.preservedLeadingControls,
    };
    const activeBoundary = getActiveBoundary(context);
    const canRestore = element.isConnected && contentMatches(context);
    removeOwnedForHost(element, activeBoundary);
    if (canRestore) {
      if (!restoreCapturedChildren(context)) {
        const currentOwn = getScopedOwnHTML(element, activeBoundary);
        if (currentOwn !== record.originalHTML) {
          replaceScopedLeadHTML(context, record.originalHTML);
        }
      }
      clearCapturedChildren(context);
    } else {
      // The page changed independently while translation was active. Do not
      // reinsert detached live children into an element we no longer own.
      clearCapturedChildren(context);
    }
    element.classList.remove(BILINGUAL_CLASS, 'fluent-read-failure');
    restoreTruncationStyle(element);
    if (element.getAttribute(TRANSLATED_ID_ATTR) === record.id) {
      element.removeAttribute(TRANSLATED_ID_ATTR);
      element.removeAttribute(TRANSLATED_ATTR);
      element.removeAttribute(SCOPED_ATTR);
    }
    if (records.get(element) === record) records.delete(element);
  });
  activeRecords.clear();
  originalContents.clear();
  inFlightNodes.clear();

  // Clean markers from interrupted records and legacy extension markup that
  // predates the WeakMap state.
  document.querySelectorAll(`[${TRANSLATED_ATTR}], [${TRANSLATED_ID_ATTR}], [${SCOPED_ATTR}]`).forEach((node) => {
    node.removeAttribute(TRANSLATED_ATTR);
    node.removeAttribute(TRANSLATED_ID_ATTR);
    node.removeAttribute(SCOPED_ATTR);
  });
  document
    .querySelectorAll(
      `[${OWNED_ATTR}], .fluent-read-loading, .fluent-read-bilingual-content, .fluent-read-retry-wrapper`,
    )
    .forEach((node) => node.remove());
  document.querySelectorAll(`.${BILINGUAL_CLASS}`).forEach((node) => node.classList.remove(BILINGUAL_CLASS));
  // Legacy/interrupted markup can leave the flattening snapshot behind.
  document.querySelectorAll('[data-fr-truncation-snapshot]').forEach((node) => restoreTruncationStyle(node));
  document.querySelectorAll('style[data-fr-temp-style]').forEach((node) => node.remove());
  nodeIdCounter = 0;
}

interface BatchBucket {
  segId: number;
  origin: string;
  cacheKey: string;
  firstItem: PendingAutoItem;
  contexts: TranslationContext[];
}

function buildBatchBuckets(group: PendingAutoItem[]): {
  buckets: BatchBucket[];
  itemEntries: Array<{ item: PendingAutoItem; segId: number }>;
} {
  const segByCacheKey = new Map<string, BatchBucket>();
  const itemEntries: Array<{ item: PendingAutoItem; segId: number }> = [];
  let nextSegId = 0;

  for (const item of group) {
    const normalizedKey = normalizeCacheSource(item.cacheKey);
    let bucket = segByCacheKey.get(normalizedKey);
    if (!bucket) {
      bucket = {
        segId: nextSegId++,
        origin: item.origin,
        cacheKey: item.cacheKey,
        firstItem: item,
        contexts: [],
      };
      segByCacheKey.set(normalizedKey, bucket);
    }
    bucket.contexts.push(item.context);
    itemEntries.push({ item, segId: bucket.segId });
  }

  return { buckets: Array.from(segByCacheKey.values()), itemEntries };
}

function runBatchGroup(
  group: PendingAutoItem[],
  isBilingual: boolean,
  overrideContextInfo?: string,
  precomputed?: {
    buckets: BatchBucket[];
    itemEntries: Array<{ item: PendingAutoItem; segId: number }>;
  },
): void {
  const { buckets, itemEntries } = precomputed ?? buildBatchBuckets(group);

  // If in-batch deduplication leaves only one unique text, fall back to the
  // single-item path so in-flight deduplication handles all duplicates.
  if (buckets.length === 1) {
    for (const item of group) {
      if (overrideContextInfo) item.context.contextInfo = overrideContextInfo;
      if (isBilingual) runBilingualTranslation(item.context, false);
      else runSingleTranslation(item.context, false);
    }
    return;
  }

  for (const item of group) {
    item.context.spinner = insertLoadingSpinner(
      item.context.element,
      false,
      getActiveBoundary(item.context),
    );
    markOwned(item.context.spinner);
  }

  const batchContextInfo =
    overrideContextInfo ||
    buildPageContext(group[0].context.element, {
      includePreceding: false,
    });

  const requestItems: BatchTranslationRequestItem[] = buckets.map((bucket) => ({
    id: bucket.segId,
    origin: bucket.origin,
    cacheKey: bucket.cacheKey,
    isListSlot: isListSlotElement(bucket.firstItem.element, bucket.firstItem.groupInfo),
    allowIdentity: Boolean(
      bucket.firstItem.groupInfo && countMeaningfulWords(bucket.firstItem.context.sourceText) <= 2,
    ),
    onChunk: (accumulated: string) => {
      for (const ctx of bucket.contexts) {
        if (isBilingual) applyBilingualStreamChunk(ctx, accumulated);
        else applySingleStreamChunk(ctx, accumulated);
      }
    },
  }));

  translateBatch(requestItems, batchContextInfo)
    .then((resultMap) => {
      for (const { item, segId } of itemEntries) {
        const ctx = item.context;
        if (!contextIsCurrent(ctx)) {
          invalidateContext(ctx);
          continue;
        }

        const translated = resultMap.get(segId);
        if (translated && translated.trim()) {
          const normalizedItemOrigin = item.origin.replace(/\s+/g, ' ').trim();
          if (translated === item.origin || translated === normalizedItemOrigin) {
            finishWithoutTranslation(ctx);
            continue;
          }
          if (isBilingual) {
            applyBilingualResult(ctx, translated);
          } else {
            try {
              if (!applyTranslatedHTML(ctx, translated)) invalidateContext(ctx);
            } catch (error) {
              restoreAfterApplyFailure(ctx);
              finishFailed(ctx, error);
            }
          }
          continue;
        }

        // Graceful fallback for any segment omitted or malformed in the batch response
        removeSpinner(ctx);
        ctx.contextInfo = buildPageContext(ctx.element);
        if (isBilingual) {
          clearBilingualOutput(ctx.element, getActiveBoundary(ctx));
          syncOwnedContent(ctx);
          runBilingualTranslation(ctx, false);
        } else {
          restoreAfterApplyFailure(ctx);
          runSingleTranslation(ctx, false);
        }
      }
    })
    .catch((error) => {
      for (const item of group) {
        finishFailed(item.context, error);
      }
    });
}

function collectTranslatedSiblingsForGroup(
  groupRoot: Element,
  cachedInBatch: string[] | undefined,
  excluded: Set<Element>,
): string[] {
  const siblings: string[] = [...(cachedInBatch ?? [])];
  if (siblings.length >= 3) return siblings;

  const registered = groupRegistry.get(groupRoot);
  if (!registered) return siblings;

  for (const el of registered) {
    if (excluded.has(el)) continue;
    const rec = records.get(el);
    if (rec && rec.status === 'translated' && rec.originalText) {
      siblings.push(rec.originalText);
      if (siblings.length >= 4) break;
    }
  }
  return siblings;
}

async function flushAutoBatchQueue(generation: number): Promise<void> {
  const elements = autoBatchQueue.splice(0);
  if (!isAutoTranslating || generation !== sessionGeneration || elements.length === 0) return;

  const isBilingual = config.display === styles.bilingualTranslation;
  const candidates: PendingAutoItem[] = [];

  for (const element of elements) {
    if (!isAutoTranslating || generation !== sessionGeneration) return;
    if (!element.isConnected) continue;
    const context = beginContext(element, false);
    if (!context) continue;

    if (detectlang(context.sourceText.replace(/[\s\u3000]/g, '')) === config.to) {
      finishWithoutTranslation(context);
      continue;
    }

    const origin = isBilingual ? context.sourceText : context.requestHTML;
    const cacheKey = isBilingual ? bilingualCacheKey(context) : singleCacheKey(context);
    candidates.push({
      context,
      origin,
      cacheKey,
      isBilingual,
      groupInfo: context.groupInfo,
      element: context.element,
    });
  }

  if (candidates.length === 0) return;

  const cachedResults = await Promise.all(
    candidates.map((item) => cache.localGet(item.cacheKey)),
  );

  if (!isAutoTranslating || generation !== sessionGeneration) {
    for (const item of candidates) invalidateContext(item.context);
    return;
  }

  const cachedByGroup = new Map<Element, string[]>();
  const uncached: PendingAutoItem[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const item = candidates[i];
    if (!contextIsCurrent(item.context)) {
      invalidateContext(item.context);
      continue;
    }
    const cached = cachedResults[i];
    if (cached) {
      if (item.groupInfo) {
        const list = cachedByGroup.get(item.groupInfo.groupRoot) ?? [];
        list.push(normalizeCacheSource(item.context.sourceText));
        cachedByGroup.set(item.groupInfo.groupRoot, list);
      }
      if (item.isBilingual) renderCachedBilingualResult(item.context, cached);
      else renderCachedSingleResult(item.context, cached);
    } else {
      uncached.push(item);
    }
  }

  if (uncached.length === 0) return;

  const partitioned = partitionBatchItems(uncached, {
    maxNormalItems: MAX_BATCH_ITEMS,
    maxNormalChars: MAX_BATCH_CHARS,
    maxGroupItems: 10,
    maxGroupChars: 2400,
  });

  for (const batch of partitioned) {
    if (batch.groupRoot !== null) {
      const precomputed = buildBatchBuckets(batch.items);
      const batchElements = new Set(batch.items.map((item) => item.element));
      const leadInIncludedInBatch = batch.items.some(
        (item) =>
          !item.groupInfo &&
          batch.items.some((other) => other.groupInfo?.leadInElement === item.element),
      );
      const cachedSiblings = collectTranslatedSiblingsForGroup(
        batch.groupRoot,
        cachedByGroup.get(batch.groupRoot),
        batchElements,
      );
      const slotMeta = precomputed.buckets.map((bucket) => ({
        segId: bucket.segId,
        role: bucket.firstItem.groupInfo?.slotRole ?? ('lead-in' as const),
        label: bucket.firstItem.groupInfo?.hierarchyLabel ?? 'lead-in',
        groupInfo: bucket.firstItem.groupInfo,
        text: bucket.firstItem.context.sourceText,
      }));
      const structuredCtx = buildStructuredGroupContext(slotMeta, {
        groupKind: batch.groupKind,
        leadInIncludedInBatch,
        cachedSiblings,
        previousTailTexts: batch.previousTailTexts,
      });
      const basePageCtx = buildPageContext(batch.items[0].element, { includePreceding: false });
      const groupPageCtx = [basePageCtx, structuredCtx].filter(Boolean).join('\n');

      if (batch.items.length === 1 || precomputed.buckets.length === 1) {
        for (const item of batch.items) {
          if (groupPageCtx) item.context.contextInfo = groupPageCtx;
          if (item.isBilingual) runBilingualTranslation(item.context, false);
          else runSingleTranslation(item.context, false);
        }
      } else {
        runBatchGroup(batch.items, isBilingual, groupPageCtx, precomputed);
      }
      continue;
    }

    if (batch.items.length === 1) {
      const only = batch.items[0];
      if (only.isBilingual) runBilingualTranslation(only.context, false);
      else runSingleTranslation(only.context, false);
    } else {
      runBatchGroup(batch.items, isBilingual);
    }
  }
}

function dispatchAutoTranslation(element: HTMLElement, generation: number): void {
  if (!isAutoTranslating || generation !== sessionGeneration || !element.isConnected) return;
  if (element.hasAttribute(TRANSLATED_ATTR) || element.hasAttribute(TRANSLATED_ID_ATTR)) return;
  const record = createRecord(element, generation);
  if (!record) return;

  if (!servicesType.isUseModel(config.service)) {
    if (config.display === styles.bilingualTranslation) {
      handleBilingualTranslation(element, false);
    } else {
      handleSingleTranslation(element, false);
    }
    return;
  }

  autoBatchQueue.push(element);
  if (!autoBatchTimer) {
    autoBatchTimer = setTimeout(() => {
      autoBatchTimer = undefined;
      void flushAutoBatchQueue(generation);
    }, AUTO_BATCH_WINDOW_MS);
  }
}

function registerGroupCandidates(elements: Iterable<Element>): void {
  for (const el of elements) {
    if (!(el instanceof HTMLElement)) continue;
    const info = getStructuredGroupInfo(el);
    if (!info) continue;
    let groupList = groupRegistry.get(info.groupRoot);
    if (!groupList) {
      groupList = [];
      groupRegistry.set(info.groupRoot, groupList);
    }
    if (!groupList.includes(el)) {
      groupList.push(el);
    }
  }
}

function observeCandidate(element: Element, generation: number): void {
  if (!(element instanceof HTMLElement) || !element.isConnected) return;
  if (element.hasAttribute(TRANSLATED_ATTR) || element.hasAttribute(TRANSLATED_ID_ATTR)) return;
  if (hasActiveTranslatedAncestor(element, false)) {
    return;
  }
  observer?.observe(element);
}

function scanMutationRoots(roots: Set<Node>, generation: number): void {
  if (!isAutoTranslating || generation !== sessionGeneration) return;
  const candidates = new Set<Element>();
  roots.forEach((root) => grabAllNode(root).forEach((candidate) => candidates.add(candidate)));
  registerGroupCandidates(candidates);
  candidates.forEach((candidate) => {
    if (observer) observeCandidate(candidate, generation);
    else if (candidate instanceof HTMLElement) dispatchAutoTranslation(candidate, generation);
  });
}

/** Start lazy full-page translation with generation-guarded observers. */
export async function autoTranslateEnglishPage(): Promise<void> {
  if (isAutoTranslating) return;
  const nodes = grabAllNode(document.body);
  if (!nodes.length) return;

  isAutoTranslating = true;
  const generation = ++sessionGeneration;
  registerGroupCandidates(nodes);

  if (config.enablePageSummary && servicesType.isUseModel(config.service)) {
    try {
      await requestPageSummary();
    } catch (error) {
      if (config.debugMode) console.warn('[FluentRead] Page summary failed:', error);
    }
    if (!isAutoTranslating || generation !== sessionGeneration) return;
  }

  const processEntry = (element: Element) => {
    if (element instanceof HTMLElement) dispatchAutoTranslation(element, generation);
  };

  if (typeof IntersectionObserver !== 'undefined') {
    observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting || !isAutoTranslating || generation !== sessionGeneration) return;
        const target = entry.target;
        observer?.unobserve(target);
        if (!(target instanceof HTMLElement)) return;

        if (servicesType.isUseModel(config.service)) {
          const info = getStructuredGroupInfo(target);
          const groupList = info ? groupRegistry.get(info.groupRoot) : undefined;
          if (groupList && groupList.length > 1) {
            const windowElements = selectSiblingWindow(target, groupList, {
              maxItems: 10,
              maxChars: 2400,
              getCharLength: (el) => getTranslatableText(el, true).length,
              isAvailable: (el) =>
                el.isConnected &&
                !el.hasAttribute(TRANSLATED_ATTR) &&
                !el.hasAttribute(TRANSLATED_ID_ATTR) &&
                !hasActiveTranslatedAncestor(el, false),
            });
            if (windowElements.length > 0) {
              for (const el of windowElements) {
                observer?.unobserve(el);
                processEntry(el);
              }
              return;
            }
          }
        }

        processEntry(target);
      });
    }, { root: null, rootMargin: '100px', threshold: 0.01 });
    nodes.forEach((node) => observeCandidate(node, generation));
  } else {
    nodes.forEach(processEntry);
  }

  if (typeof MutationObserver !== 'undefined' && document.body) {
    mutationObserver = new MutationObserver((mutations) => {
      if (!isAutoTranslating || generation !== sessionGeneration) return;
      const roots = new Set<Node>();
      mutations.forEach((mutation) => {
        const target = mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
        if (
          target &&
          (target.hasAttribute(TRANSLATED_ATTR) ||
            target.hasAttribute(TRANSLATED_ID_ATTR) ||
            isOwnedElement(target))
        ) {
          return;
        }
        if (mutation.type === 'characterData' && mutation.target.parentElement) {
          roots.add(mutation.target.parentElement);
        }
        mutation.addedNodes.forEach((added) => {
          if (added.nodeType === Node.ELEMENT_NODE && !isOwnedElement(added as Element)) roots.add(added);
          else if (added.nodeType === Node.TEXT_NODE && added.parentElement) roots.add(added.parentElement);
        });
      });
      scanMutationRoots(roots, generation);
    });
    mutationObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
  }
}

function applyCachedOrTranslate(
  context: TranslationContext,
  forceBypassCache: boolean,
  origin: string,
  onHit: (cached: string) => void,
  onMiss: () => void,
): void {
  void (async () => {
    const cached = forceBypassCache ? null : await cache.localGet(origin);
    if (!contextIsCurrent(context)) {
      invalidateContext(context);
      return;
    }
    if (cached) {
      onHit(cached);
      return;
    }
    onMiss();
  })();
}

/** Translate the live element beneath a mouse/touch point. */
export function handleTranslation(mouseX: number, mouseY: number, delayTime = 0): void {
  if (!checkConfig()) return;
  if (hoverTimer) clearTimeout(hoverTimer);
  hoverTimer = setTimeout(() => {
    const node = grabNode(document.elementFromPoint(mouseX, mouseY));
    if (!(node instanceof HTMLElement) || skipNode(node)) return;
    if (config.display === styles.bilingualTranslation) {
      handleBilingualTranslation(node, delayTime > 0);
    } else {
      handleSingleTranslation(node, delayTime > 0);
    }
  }, delayTime);
}

function findOwnBilingualHost(node: HTMLElement): HTMLElement | null {
  if (node.classList.contains(BILINGUAL_CLASS)) return node;
  const boundary = findFirstNestedBlockChild(node);
  for (const lead of getLeadChildNodes(node, boundary)) {
    if (!(lead instanceof Element)) continue;
    if (lead.hasAttribute(TRANSLATED_ATTR) || lead.hasAttribute(TRANSLATED_ID_ATTR)) continue;
    if (lead instanceof HTMLElement && lead.classList.contains(BILINGUAL_CLASS)) return lead;
    const nested = searchClassName(lead, BILINGUAL_CLASS);
    if (
      nested instanceof HTMLElement &&
      !nested.hasAttribute(TRANSLATED_ATTR) &&
      !nested.hasAttribute(TRANSLATED_ID_ATTR)
    ) {
      return nested;
    }
  }
  return null;
}

export function handleBilingualTranslation(
  node: HTMLElement,
  slide: boolean,
  forceBypassCache = false,
): void {
  const bilingualNode = findOwnBilingualHost(node);
  if (bilingualNode) {
    if (slide) return;
    const record = records.get(bilingualNode);
    const boundary =
      record && record.boundary && record.boundary.parentNode === bilingualNode
        ? record.boundary
        : findFirstNestedBlockChild(bilingualNode);
    const spinner = insertLoadingSpinner(bilingualNode, true, boundary);
    markOwned(spinner);
    const toggleGeneration = sessionGeneration;
    const expectedHTML = getScopedOwnHTML(bilingualNode, boundary);
    setTimeout(() => {
      const currentBoundary =
        record && record.boundary && record.boundary.parentNode === bilingualNode
          ? record.boundary
          : findFirstNestedBlockChild(bilingualNode);
      if (
        toggleGeneration !== sessionGeneration ||
        !bilingualNode.isConnected ||
        stripOwnedHTML(getScopedOwnHTML(bilingualNode, currentBoundary)) !==
          stripOwnedHTML(expectedHTML)
      ) {
        spinner.remove();
        return;
      }
      spinner.remove();
      clearBilingualOutput(bilingualNode, currentBoundary);
    }, 250);
    return;
  }

  const context = beginContext(node, forceBypassCache);
  if (!context) return;
  void applyCachedOrTranslate(context, forceBypassCache, bilingualCacheKey(context), (cached) => {
    renderCachedBilingualResult(context, cached);
  }, () => {
    runBilingualTranslation(context, forceBypassCache);
  });
}

export function handleSingleTranslation(
  node: HTMLElement,
  _slide: boolean,
  forceBypassCache = false,
): void {
  const context = beginContext(node, forceBypassCache);
  if (!context) return;
  void applyCachedOrTranslate(context, forceBypassCache, singleCacheKey(context), (cached) => {
    renderCachedSingleResult(context, cached);
  }, () => {
    runSingleTranslation(context, forceBypassCache);
  });
}

/** Legacy helper retained for callers; button controls are intentionally skipped. */
export const handleBtnTranslation = throttle((node: HTMLElement) => {
  if (node.tagName.toLowerCase() === 'button' || node.closest('button')) return;
  const origin = node.innerText;
  const generation = sessionGeneration;
  if (!shouldTranslateContent(origin)) return;
  void cache.localGet(origin).then((cached) => {
    if (cached) {
      if (node.isConnected && node.innerText === origin) node.innerText = cached;
      return;
    }

    translateText(origin, document.title)
      .then((text) => {
        if (generation === sessionGeneration && node.isConnected && node.innerText === origin && text) {
          node.innerText = text;
          incrementTranslationCount();
        }
      })
      .catch((error) => console.error('调用失败:', error));
  });
}, 250);
