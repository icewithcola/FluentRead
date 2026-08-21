import type { CompatSite, SelectResult } from '../types';

function selectMvnRepository(node: Element): SelectResult {
  if (node.tagName.toLowerCase() === 'div' && node.classList.contains('im-description'))
    return node;
}

function selectAozora(node: Element): SelectResult {
  if (node.tagName.toLowerCase() === 'div' && node.classList.contains('main_text')) return node;
}

function selectWebtrees(node: Element): SelectResult {
  // class='kmsg'
  if (node.tagName.toLowerCase() === 'div' && node.classList.contains('kmsg')) return node;
}

export const mvnrepository: CompatSite = {
  domain: 'mvnrepository.com',
  select: selectMvnRepository,
};

export const aozora: CompatSite = {
  domain: 'aozora.gr.jp',
  select: selectAozora,
};

export const webtrees: CompatSite = {
  domain: 'webtrees.net',
  select: selectWebtrees,
};
