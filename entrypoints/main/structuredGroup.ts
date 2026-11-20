import {
  getTranslatableText,
  isContentList,
  isContentTable,
  isOwnedElement,
  isSkippedElement,
  isVisible,
} from './dom';

export type StructuredGroupKind = 'unordered-list' | 'ordered-list' | 'definition-list' | 'table';
export type StructuredSlotRole =
  | 'lead-in'
  | 'item'
  | 'sub-item'
  | 'term'
  | 'definition'
  | 'header'
  | 'cell';

export interface StructuredGroupInfo {
  groupRoot: Element;
  groupKind: StructuredGroupKind;
  slotRole: StructuredSlotRole;
  hierarchyLabel: string;
  depth: number;
  leadInElement: HTMLElement | null;
  leadInText: string;
  parentItemText: string;
  tableHeaders: string[];
  columnHeader: string;
  rowElement: Element | null;
  dlTermElement: Element | null;
  shortContextHash: string;
}

const STRUCTURAL_CHILD_BLOCK_SELECTOR =
  'p, ul, ol, dl, table, div, section, article, blockquote, pre, h1, h2, h3, h4, h5, h6';
const STRUCTURED_HOST_TAGS = new Set(['li', 'dt', 'dd', 'td', 'th']);

function cleanElementText(element: Element): string {
  return getTranslatableText(element, true).replace(/\s+/g, ' ').trim();
}

function fnv1aHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function groupKindDescription(kind: StructuredGroupKind): string {
  switch (kind) {
    case 'unordered-list':
      return 'unordered list (parallel items)';
    case 'ordered-list':
      return 'ordered list (sequential steps)';
    case 'definition-list':
      return 'definition list (term-definition pairs)';
    case 'table':
      return 'table rows (aligned columns)';
  }
}

function isFlatLeadInCandidate(element: Element): boolean {
  const tag = element.tagName.toLowerCase();
  if (/^(?:p|h[2-6]|figcaption)$/.test(tag)) return true;
  if (tag === 'div') {
    return !element.querySelector(STRUCTURAL_CHILD_BLOCK_SELECTOR);
  }
  return false;
}

export function findGroupLeadIn(groupRoot: Element): HTMLElement | null {
  if (groupRoot.tagName.toLowerCase() === 'table') {
    const caption = Array.from(groupRoot.children).find(
      (child) =>
        child.tagName.toLowerCase() === 'caption' &&
        !isOwnedElement(child) &&
        !isSkippedElement(child) &&
        isVisible(child),
    );
    if (caption instanceof HTMLElement) {
      const text = cleanElementText(caption);
      if (text.length >= 4 && text.length <= 280) {
        return caption;
      }
    }
  }

  let prev = groupRoot.previousElementSibling;
  let inspected = 0;
  while (prev && inspected < 2) {
    inspected++;
    const tag = prev.tagName.toLowerCase();
    if (tag === 'hr' || tag === 'script' || tag === 'style' || isOwnedElement(prev)) {
      prev = prev.previousElementSibling;
      continue;
    }
    if (isSkippedElement(prev) || !isVisible(prev)) {
      prev = prev.previousElementSibling;
      continue;
    }
    const text = cleanElementText(prev);
    if (!text) {
      prev = prev.previousElementSibling;
      continue;
    }
    if (prev instanceof HTMLElement && isFlatLeadInCandidate(prev) && text.length >= 4 && text.length <= 280) {
      return prev;
    }
    return null;
  }
  return null;
}

interface TableHeaderInfo {
  headers: string[];
  expandedHeaders: string[];
  headerRow: Element | null;
}

function inspectTableHeaders(table: Element): TableHeaderInfo {
  const directThead = Array.from(table.children).find(
    (child) => child.tagName.toLowerCase() === 'thead' && isVisible(child),
  );
  let headerRow: Element | null = null;
  if (directThead) {
    const theadRows = Array.from(directThead.querySelectorAll('tr')).filter(
      (tr) => tr.closest('table') === table && isVisible(tr),
    );
    headerRow = theadRows[theadRows.length - 1] ?? null;
  }

  if (!headerRow) {
    const tableRows = Array.from(table.querySelectorAll('tr')).filter(
      (tr) => tr.closest('table') === table && isVisible(tr),
    );
    headerRow =
      tableRows.find((tr) =>
        Array.from(tr.children).some((cell) => cell.tagName.toLowerCase() === 'th'),
      ) ?? null;
  }

  if (!headerRow) {
    return { headers: [], expandedHeaders: [], headerRow: null };
  }

  const headers: string[] = [];
  const expandedHeaders: string[] = [];
  for (const cell of Array.from(headerRow.children)) {
    const tag = cell.tagName.toLowerCase();
    if ((tag !== 'th' && tag !== 'td') || !isVisible(cell)) continue;
    const label = cleanElementText(cell).slice(0, 40).trim();
    const spanRaw = Number(cell.getAttribute('colspan') || 1);
    const span = Number.isFinite(spanRaw) && spanRaw > 1 ? Math.min(12, Math.floor(spanRaw)) : 1;
    if (label && headers.length < 12) headers.push(label);
    for (let i = 0; i < span && expandedHeaders.length < 12; i++) {
      expandedHeaders.push(label);
    }
    if (expandedHeaders.length >= 12) break;
  }

  return { headers, expandedHeaders, headerRow };
}

export function extractTableHeaders(table: Element): string[] {
  return inspectTableHeaders(table).headers;
}

function getVisibleDirectListItems(list: Element): Element[] {
  return Array.from(list.children).filter(
    (child) => child.tagName.toLowerCase() === 'li' && !isOwnedElement(child) && isVisible(child),
  );
}

function getVisibleDefinitionNodes(dl: Element): Element[] {
  const nodes: Element[] = [];
  for (const child of Array.from(dl.children)) {
    if (isOwnedElement(child) || !isVisible(child)) continue;
    const tag = child.tagName.toLowerCase();
    if (tag === 'dt' || tag === 'dd') {
      nodes.push(child);
    } else if (tag === 'div') {
      for (const nested of Array.from(child.children)) {
        if (isOwnedElement(nested) || !isVisible(nested)) continue;
        const nestedTag = nested.tagName.toLowerCase();
        if (nestedTag === 'dt' || nestedTag === 'dd') nodes.push(nested);
      }
    }
  }
  return nodes;
}

function resolveHostStructuredElement(element: Element): Element | null {
  const tag = element.tagName.toLowerCase();
  if (STRUCTURED_HOST_TAGS.has(tag)) return element;
  if (tag === 'p' || (tag === 'div' && !element.querySelector(STRUCTURAL_CHILD_BLOCK_SELECTOR))) {
    const parent = element.parentElement;
    if (parent && STRUCTURED_HOST_TAGS.has(parent.tagName.toLowerCase())) {
      return parent;
    }
  }
  return null;
}

export function getStructuredGroupInfo(element: Element): StructuredGroupInfo | null {
  const hostItem = resolveHostStructuredElement(element);
  if (!hostItem) return null;

  const hostTag = hostItem.tagName.toLowerCase();

  if (hostTag === 'li') {
    const chain: Array<{ list: Element; li: Element }> = [];
    let currentLi: Element | null = hostItem;
    while (currentLi) {
      const parentList: Element | null = currentLi.parentElement?.closest('ul, ol') ?? null;
      if (!parentList || !isContentList(parentList)) break;
      chain.push({ list: parentList, li: currentLi });
      const boundaryContainer: Element | null =
        parentList.parentElement?.closest('li, article, section, main, td, th, blockquote') ?? null;
      currentLi =
        boundaryContainer && boundaryContainer.tagName.toLowerCase() === 'li'
          ? boundaryContainer
          : null;
    }

    if (chain.length === 0) return null;
    chain.reverse();

    const groupRoot = chain[0].list;
    const groupKind: StructuredGroupKind =
      groupRoot.tagName.toLowerCase() === 'ol' ? 'ordered-list' : 'unordered-list';
    const depth = chain.length - 1;
    const slotRole: StructuredSlotRole = depth === 0 ? 'item' : 'sub-item';

    const indices = chain.map(({ list, li }) => {
      const items = getVisibleDirectListItems(list);
      const idx = items.indexOf(li);
      return idx >= 0 ? idx + 1 : 1;
    });
    const hierarchyLabel = `${slotRole} ${indices.join('.')}`;

    const parentItemText =
      depth > 0 ? cleanElementText(chain[chain.length - 2].li).slice(0, 140) : '';
    const leadInElement = findGroupLeadIn(groupRoot);
    const leadInText = leadInElement ? cleanElementText(leadInElement) : '';

    const immediateList = chain[chain.length - 1].list;
    const siblingSamples = getVisibleDirectListItems(immediateList)
      .slice(0, 3)
      .map((sib) => cleanElementText(sib).slice(0, 60));

    const shortContextHash = fnv1aHash(
      [groupKind, leadInText, parentItemText, '', ...siblingSamples].join('|'),
    );

    return {
      groupRoot,
      groupKind,
      slotRole,
      hierarchyLabel,
      depth,
      leadInElement,
      leadInText,
      parentItemText,
      tableHeaders: [],
      columnHeader: '',
      rowElement: null,
      dlTermElement: null,
      shortContextHash,
    };
  }

  if (hostTag === 'dt' || hostTag === 'dd') {
    const dl = hostItem.closest('dl');
    if (!dl || !isContentList(dl)) return null;

    const nodes = getVisibleDefinitionNodes(dl);
    let pairIdx = 0;
    let currentTerm: Element | null = null;
    let prevWasDd = false;
    let resolvedPairIdx = 1;
    let pairedTerm: Element | null = null;

    for (const node of nodes) {
      const tag = node.tagName.toLowerCase();
      if (tag === 'dt') {
        if (pairIdx === 0 || prevWasDd) pairIdx++;
        currentTerm = node;
        prevWasDd = false;
      } else {
        if (pairIdx === 0) pairIdx = 1;
        prevWasDd = true;
      }
      if (node === hostItem) {
        resolvedPairIdx = pairIdx;
        pairedTerm = tag === 'dd' ? currentTerm : null;
        break;
      }
    }

    const slotRole: StructuredSlotRole = hostTag === 'dt' ? 'term' : 'definition';
    const hierarchyLabel = `pair ${resolvedPairIdx} ${slotRole}`;
    const parentItemText = pairedTerm ? cleanElementText(pairedTerm).slice(0, 140) : '';
    const leadInElement = findGroupLeadIn(dl);
    const leadInText = leadInElement ? cleanElementText(leadInElement) : '';
    const siblingSamples = nodes.slice(0, 3).map((node) => cleanElementText(node).slice(0, 60));
    const shortContextHash = fnv1aHash(
      ['definition-list', leadInText, parentItemText, '', ...siblingSamples].join('|'),
    );

    return {
      groupRoot: dl,
      groupKind: 'definition-list',
      slotRole,
      hierarchyLabel,
      depth: 0,
      leadInElement,
      leadInText,
      parentItemText,
      tableHeaders: [],
      columnHeader: '',
      rowElement: null,
      dlTermElement: pairedTerm,
      shortContextHash,
    };
  }

  if (hostTag === 'td' || hostTag === 'th') {
    const table = hostItem.closest('table');
    if (!table || !isContentTable(table)) return null;

    const headerInfo = inspectTableHeaders(table);
    const rowElement = hostItem.closest('tr');
    const visibleRows = Array.from(table.querySelectorAll('tr')).filter(
      (tr) => tr.closest('table') === table && isVisible(tr),
    );
    const rowIdx = rowElement ? Math.max(1, visibleRows.indexOf(rowElement) + 1) : 1;

    let colStart = 0;
    if (rowElement) {
      for (const cell of Array.from(rowElement.children)) {
        const tag = cell.tagName.toLowerCase();
        if ((tag !== 'td' && tag !== 'th') || !isVisible(cell)) continue;
        if (cell === hostItem) break;
        const spanRaw = Number(cell.getAttribute('colspan') || 1);
        colStart += Number.isFinite(spanRaw) && spanRaw > 1 ? Math.floor(spanRaw) : 1;
      }
    }

    const isHeaderCell =
      rowElement === headerInfo.headerRow ||
      (hostTag === 'th' && Boolean(hostItem.closest('thead')));
    const slotRole: StructuredSlotRole = isHeaderCell ? 'header' : 'cell';
    const columnHeader = isHeaderCell ? '' : headerInfo.expandedHeaders[colStart] || '';
    const hierarchyLabel = isHeaderCell
      ? `header ${colStart + 1}`
      : columnHeader
        ? `row ${rowIdx} / ${columnHeader}`
        : `row ${rowIdx} col ${colStart + 1}`;

    const leadInElement = findGroupLeadIn(table);
    const leadInText = leadInElement ? cleanElementText(leadInElement) : '';
    const rowSamples = rowElement
      ? Array.from(rowElement.children)
          .slice(0, 3)
          .map((cell) => cleanElementText(cell).slice(0, 40))
      : [];
    const shortContextHash = fnv1aHash(
      ['table', leadInText, '', columnHeader, ...rowSamples].join('|'),
    );

    return {
      groupRoot: table,
      groupKind: 'table',
      slotRole,
      hierarchyLabel,
      depth: 0,
      leadInElement,
      leadInText,
      parentItemText: '',
      tableHeaders: headerInfo.headers,
      columnHeader,
      rowElement,
      dlTermElement: null,
      shortContextHash,
    };
  }

  return null;
}

export function selectSiblingWindow(
  triggerElement: HTMLElement,
  groupElements: HTMLElement[],
  options: {
    maxItems: number;
    maxChars: number;
    getCharLength: (el: HTMLElement) => number;
    isAvailable: (el: HTMLElement) => boolean;
  },
): HTMLElement[] {
  const { maxItems, maxChars, getCharLength, isAvailable } = options;
  const triggerIdx = groupElements.indexOf(triggerElement);
  if (triggerIdx < 0) {
    return isAvailable(triggerElement) ? [triggerElement] : [];
  }

  const infoCache = new Map<HTMLElement, StructuredGroupInfo | null>();
  const infoOf = (el: HTMLElement): StructuredGroupInfo | null => {
    if (!infoCache.has(el)) infoCache.set(el, getStructuredGroupInfo(el));
    return infoCache.get(el) ?? null;
  };

  let startIdx = triggerIdx;
  const triggerInfo = infoOf(triggerElement);

  // Pull paired <dt> when a <dd> triggers translation.
  if (triggerInfo?.dlTermElement && startIdx > 0) {
    let idx = startIdx - 1;
    while (idx >= 0) {
      const candidate = groupElements[idx];
      if (!isAvailable(candidate)) break;
      if (candidate === triggerInfo.dlTermElement || triggerInfo.dlTermElement.contains(candidate)) {
        startIdx = idx;
      } else {
        break;
      }
      idx--;
    }
  }

  // Start from the beginning of the table row when any cell in that row triggers.
  if (triggerInfo?.rowElement && startIdx > 0) {
    let idx = startIdx - 1;
    while (idx >= 0) {
      const candidate = groupElements[idx];
      if (!isAvailable(candidate)) break;
      if (infoOf(candidate)?.rowElement === triggerInfo.rowElement) {
        startIdx = idx;
        idx--;
      } else {
        break;
      }
    }
  }

  const selected: HTMLElement[] = [];
  const selectedSet = new Set<HTMLElement>();
  let totalChars = 0;

  // Include group lead-in when starting near the top of the group.
  if (triggerIdx <= 2 && triggerInfo?.leadInElement) {
    const leadIn = triggerInfo.leadInElement;
    if (isAvailable(leadIn) && !groupElements.includes(leadIn)) {
      const leadLen = getCharLength(leadIn);
      if (selected.length < maxItems && totalChars + leadLen <= maxChars) {
        selected.push(leadIn);
        selectedSet.add(leadIn);
        totalChars += leadLen;
      }
    }
  }

  const scanLimit = Math.min(groupElements.length, startIdx + maxItems * 2);
  for (let i = startIdx; i < scanLimit; i++) {
    const el = groupElements[i];
    if (selectedSet.has(el) || !isAvailable(el)) continue;

    const len = getCharLength(el);
    const info = infoOf(el);

    if (selected.length > 0 && (selected.length >= maxItems || totalChars + len > maxChars)) {
      break;
    }

    // Avoid pulling a <dt> alone at the end of a window when its paired <dd> would spill over.
    if (
      selected.length > 0 &&
      info?.slotRole === 'term' &&
      i + 1 < groupElements.length &&
      isAvailable(groupElements[i + 1]) &&
      infoOf(groupElements[i + 1])?.slotRole === 'definition'
    ) {
      const pairChars = len + getCharLength(groupElements[i + 1]);
      if (selected.length + 2 > maxItems || totalChars + pairChars > maxChars) {
        break;
      }
    }

    // Avoid starting a new table row if the entire row cannot fit in this window.
    if (selected.length > 0 && info?.rowElement) {
      const prevEl = selected[selected.length - 1];
      if (infoOf(prevEl)?.rowElement !== info.rowElement) {
        let rowCount = 0;
        let rowChars = 0;
        for (let j = i; j < groupElements.length; j++) {
          const rowEl = groupElements[j];
          if (infoOf(rowEl)?.rowElement !== info.rowElement) break;
          if (!isAvailable(rowEl)) continue;
          rowCount++;
          rowChars += getCharLength(rowEl);
        }
        if (
          rowCount > 1 &&
          (selected.length + rowCount > maxItems || totalChars + rowChars > maxChars)
        ) {
          break;
        }
      }
    }

    selected.push(el);
    selectedSet.add(el);
    totalChars += len;
  }

  return selected;
}

export interface PartitionableBatchItem {
  origin: string;
  groupInfo: StructuredGroupInfo | null;
  element: HTMLElement;
}

export interface PartitionedBatch<T extends PartitionableBatchItem> {
  groupRoot: Element | null;
  groupKind: StructuredGroupKind | null;
  items: T[];
  previousTailTexts: string[];
}

function summarizeElementTextForTail(item: PartitionableBatchItem): string {
  const clean = cleanElementText(item.element);
  if (clean) return clean.slice(0, 140);
  return item.origin.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 140);
}

function splitGroupRun<T extends PartitionableBatchItem>(
  groupRoot: Element,
  groupKind: StructuredGroupKind,
  runItems: T[],
  maxItems: number,
  maxChars: number,
): PartitionedBatch<T>[] {
  const chunks: PartitionedBatch<T>[] = [];
  const accumulatedTails: string[] = [];
  let current: T[] = [];
  let currentChars = 0;

  const flushChunk = () => {
    if (current.length === 0) return;
    chunks.push({
      groupRoot,
      groupKind,
      items: current,
      previousTailTexts: accumulatedTails.slice(-2),
    });
    for (const item of current.slice(-2)) {
      const tail = summarizeElementTextForTail(item);
      if (tail) accumulatedTails.push(tail);
    }
    current = [];
    currentChars = 0;
  };

  for (let i = 0; i < runItems.length; i++) {
    const item = runItems[i];
    const len = item.origin.length;

    if (len > maxChars && current.length > 0) {
      flushChunk();
    }

    const wouldExceed =
      current.length > 0 && (current.length >= maxItems || currentChars + len > maxChars);

    if (wouldExceed) {
      // Never separate a <dd> from its preceding <dt> if the <dt> was just pushed alone.
      if (
        item.groupInfo?.slotRole === 'definition' &&
        current.length >= 2 &&
        current[current.length - 1].groupInfo?.slotRole === 'term'
      ) {
        const orphanTerm = current.pop()!;
        flushChunk();
        current.push(orphanTerm);
        currentChars = orphanTerm.origin.length;
      } else if (
        item.groupInfo?.depth &&
        item.groupInfo.depth > 0 &&
        current.length >= 3
      ) {
        // Look back up to 2 slots for a top-level item boundary so a nested outline isn't split mid-branch.
        let topIdx = -1;
        for (let k = current.length - 1; k >= Math.max(1, current.length - 2); k--) {
          if (current[k].groupInfo?.depth === 0) {
            topIdx = k;
            break;
          }
        }
        if (topIdx > 0) {
          const moved = current.splice(topIdx);
          flushChunk();
          for (const m of moved) {
            current.push(m);
            currentChars += m.origin.length;
          }
        } else {
          flushChunk();
        }
      } else {
        flushChunk();
      }
    }

    // Keep table rows together when starting a new row that won't completely fit.
    const rowEl = item.groupInfo?.rowElement;
    if (
      current.length > 0 &&
      rowEl &&
      current[current.length - 1].groupInfo?.rowElement !== rowEl
    ) {
      let rowCount = 0;
      let rowChars = 0;
      for (let j = i; j < runItems.length && runItems[j].groupInfo?.rowElement === rowEl; j++) {
        rowCount++;
        rowChars += runItems[j].origin.length;
      }
      if (rowCount > 1 && (current.length + rowCount > maxItems || currentChars + rowChars > maxChars)) {
        flushChunk();
      }
    }

    current.push(item);
    currentChars += len;
  }

  flushChunk();
  return chunks;
}

export function partitionBatchItems<T extends PartitionableBatchItem>(
  items: T[],
  limits: {
    maxNormalItems?: number;
    maxNormalChars?: number;
    maxGroupItems?: number;
    maxGroupChars?: number;
  } = {},
): PartitionedBatch<T>[] {
  const maxNormalItems = limits.maxNormalItems ?? 6;
  const maxNormalChars = limits.maxNormalChars ?? 1800;
  const maxGroupItems = limits.maxGroupItems ?? 10;
  const maxGroupChars = limits.maxGroupChars ?? 2400;

  const result: PartitionedBatch<T>[] = [];
  let normalBuffer: T[] = [];
  let normalChars = 0;

  const flushNormalBuffer = () => {
    if (normalBuffer.length === 0) return;
    result.push({
      groupRoot: null,
      groupKind: null,
      items: normalBuffer,
      previousTailTexts: [],
    });
    normalBuffer = [];
    normalChars = 0;
  };

  let i = 0;
  while (i < items.length) {
    const item = items[i];
    const nextGroupInfo = i + 1 < items.length ? items[i + 1].groupInfo : null;
    const isLeadInForNext = !item.groupInfo && nextGroupInfo?.leadInElement === item.element;
    const effectiveGroupRoot = isLeadInForNext
      ? nextGroupInfo!.groupRoot
      : item.groupInfo?.groupRoot ?? null;
    const effectiveGroupKind = isLeadInForNext
      ? nextGroupInfo!.groupKind
      : item.groupInfo?.groupKind ?? null;

    if (effectiveGroupRoot && effectiveGroupKind) {
      flushNormalBuffer();
      const runItems: T[] = [item];
      let j = i + 1;
      while (j < items.length && items[j].groupInfo?.groupRoot === effectiveGroupRoot) {
        runItems.push(items[j]);
        j++;
      }
      result.push(
        ...splitGroupRun(
          effectiveGroupRoot,
          effectiveGroupKind,
          runItems,
          maxGroupItems,
          maxGroupChars,
        ),
      );
      i = j;
      continue;
    }

    const len = item.origin.length;
    if (len > maxNormalChars) {
      flushNormalBuffer();
      result.push({
        groupRoot: null,
        groupKind: null,
        items: [item],
        previousTailTexts: [],
      });
      i++;
      continue;
    }

    if (
      normalBuffer.length > 0 &&
      (normalBuffer.length >= maxNormalItems || normalChars + len > maxNormalChars)
    ) {
      flushNormalBuffer();
    }

    normalBuffer.push(item);
    normalChars += len;
    i++;
  }

  flushNormalBuffer();
  return result;
}

function buildCompactRelatedLine(candidates: string[], excludedTexts: Set<string>, budget = 400): string {
  const chosen: string[] = [];
  const seen = new Set<string>();
  let totalLen = 0;

  for (const raw of candidates) {
    const cleaned = raw.replace(/\s+/g, ' ').trim();
    if (!cleaned || excludedTexts.has(cleaned) || seen.has(cleaned)) continue;
    const snippet = cleaned.length > 140 ? `${cleaned.slice(0, 137)}...` : cleaned;
    const sepLen = chosen.length === 0 ? 0 : 3;
    if (chosen.length > 0 && totalLen + sepLen + snippet.length > budget) break;
    seen.add(cleaned);
    chosen.push(snippet);
    totalLen += sepLen + snippet.length;
  }

  return chosen.join(' | ');
}

export function buildStructuredGroupContext(
  batchItems: Array<{
    segId: number;
    role: StructuredSlotRole;
    label: string;
    groupInfo: StructuredGroupInfo | null;
    text: string;
  }>,
  options: {
    groupKind?: StructuredGroupKind | null;
    leadInText?: string;
    leadInIncludedInBatch?: boolean;
    parentItemText?: string;
    tableHeaders?: string[];
    cachedSiblings?: string[];
    previousTailTexts?: string[];
  } = {},
): string {
  const firstGroupInfo = batchItems.find((item) => item.groupInfo)?.groupInfo ?? null;
  const groupKind = options.groupKind ?? firstGroupInfo?.groupKind ?? null;
  if (!groupKind) return '';

  const lines: string[] = [`Group: ${groupKindDescription(groupKind)}`];

  const leadInText = (options.leadInText ?? firstGroupInfo?.leadInText ?? '').trim();
  if (leadInText && !options.leadInIncludedInBatch) {
    lines.push(`List lead-in: ${leadInText.slice(0, 220)}`);
  }

  const normalizeComparableText = (value: string): string =>
    value
      .replace(/<[^>]*>/g, ' ')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\s+/g, ' ')
      .trim();

  const firstItemInfo = batchItems[0]?.groupInfo ?? firstGroupInfo;
  const parentItemText = (options.parentItemText ?? firstItemInfo?.parentItemText ?? '').trim();
  if (parentItemText) {
    const comparableParent = normalizeComparableText(parentItemText);
    const parentAlreadyInBatch = batchItems.some(
      (item) => normalizeComparableText(item.text) === comparableParent,
    );
    if (!parentAlreadyInBatch) {
      lines.push(`Parent item: ${parentItemText.slice(0, 180)}`);
    }
  }

  const tableHeaders = options.tableHeaders ?? firstGroupInfo?.tableHeaders ?? [];
  if (tableHeaders.length > 0) {
    lines.push(`Table columns: ${tableHeaders.join(' | ').slice(0, 260)}`);
  }

  const batchTextSet = new Set(
    batchItems.map((item) => normalizeComparableText(item.text)).filter(Boolean),
  );
  const relatedCandidates = [
    ...(options.previousTailTexts ?? []),
    ...(options.cachedSiblings ?? []),
  ]
    .map((c) => c.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const excludedRelated = new Set([
    ...batchTextSet,
    ...relatedCandidates.filter((c) => batchTextSet.has(normalizeComparableText(c))),
  ]);
  const relatedLine = buildCompactRelatedLine(relatedCandidates, excludedRelated, 400);
  if (relatedLine) {
    lines.push(`Related items: ${relatedLine}`);
  }

  if (batchItems.length > 1) {
    const slotParts = batchItems.map((item) => `SEG_${item.segId}=${item.label || item.role}`);
    const slotSummary: string[] = [];
    let slotLen = 0;
    for (const part of slotParts) {
      const sep = slotSummary.length === 0 ? 0 : 2;
      if (slotSummary.length > 0 && slotLen + sep + part.length > 300) {
        slotSummary.push('...');
        break;
      }
      slotSummary.push(part);
      slotLen += sep + part.length;
    }
    if (slotSummary.length > 0) {
      lines.push(`Slot roles: ${slotSummary.join(', ')}`);
    }
  }

  return lines.join('\n');
}

export function buildSingleItemStructuredContext(element: Element): string {
  const info = getStructuredGroupInfo(element);
  if (!info) return '';

  const lines: string[] = [`Group: ${groupKindDescription(info.groupKind)}`];
  if (info.leadInText) {
    lines.push(`List lead-in: ${info.leadInText.slice(0, 220)}`);
  }
  if (info.parentItemText) {
    lines.push(`Parent item: ${info.parentItemText.slice(0, 180)}`);
  }
  if (info.tableHeaders.length > 0) {
    lines.push(`Table columns: ${info.tableHeaders.join(' | ').slice(0, 260)}`);
  }

  const hostItem = resolveHostStructuredElement(element) ?? element;
  const selfText = cleanElementText(hostItem);
  const siblingTexts: string[] = [];

  if (info.groupKind === 'unordered-list' || info.groupKind === 'ordered-list') {
    const immediateList = hostItem.parentElement?.closest('ul, ol');
    if (immediateList) {
      const items = getVisibleDirectListItems(immediateList);
      const idx = items.indexOf(hostItem);
      if (idx >= 0) {
        const start = Math.max(0, idx - 2);
        const end = Math.min(items.length, idx + 3);
        for (let i = start; i < end; i++) {
          if (i === idx) continue;
          const t = cleanElementText(items[i]);
          if (t) siblingTexts.push(t);
        }
      }
    }
  } else if (info.groupKind === 'definition-list') {
    const nodes = getVisibleDefinitionNodes(info.groupRoot);
    const idx = nodes.indexOf(hostItem);
    if (idx >= 0) {
      const start = Math.max(0, idx - 1);
      const end = Math.min(nodes.length, idx + 3);
      for (let i = start; i < end; i++) {
        if (i === idx) continue;
        const t = cleanElementText(nodes[i]);
        if (t) siblingTexts.push(t);
      }
    }
  } else if (info.groupKind === 'table' && info.rowElement) {
    const headerInfo = inspectTableHeaders(info.groupRoot);
    let colCursor = 0;
    for (const cell of Array.from(info.rowElement.children)) {
      const tag = cell.tagName.toLowerCase();
      if ((tag !== 'td' && tag !== 'th') || !isVisible(cell)) continue;
      const spanRaw = Number(cell.getAttribute('colspan') || 1);
      const span = Number.isFinite(spanRaw) && spanRaw > 1 ? Math.floor(spanRaw) : 1;
      if (cell !== hostItem) {
        const cellText = cleanElementText(cell);
        if (cellText) {
          const header = headerInfo.expandedHeaders[colCursor];
          siblingTexts.push(header ? `${header}: ${cellText}` : cellText);
        }
      }
      colCursor += span;
    }
  }

  const excluded = new Set<string>([selfText, info.parentItemText].filter(Boolean));
  const related = buildCompactRelatedLine(siblingTexts, excluded, 400);
  if (related) {
    lines.push(`Related items: ${related}`);
  }

  return lines.join('\n');
}
