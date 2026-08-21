import { findMatchingElement } from '@/entrypoints/utils/common';
import type { CompatSite, SelectResult } from '../types';

/**
 * 判断是否应该跳过Medium网站上的特定元素
 */
function shouldSkipMediumElement(node: Element): boolean {
  // 如果当前节点或其祖先节点匹配这些选择器，则跳过
  const skipSelectors = [
    // 导航栏和工具栏
    'nav',
    'div.metabar',
    'div.js-metabar',
    // 侧边栏
    'div.js-sidebarContainer',
    'div.js-sidebar',
    // UI元素
    'button',
    'input',
    'textarea',
    // 代码块
    'pre',
    'code',
    // 底部元素
    'footer',
    // 作者资料卡
    'div.pw-multi-author-card',
    // 推荐文章卡片上的标题/描述以外的内容
    'div.pw-card-body div.pw-card-description ~ *',
    // 分享按钮和响应按钮
    'div.pw-post-actions',
    'div.pw-responses-header',
  ];

  // 检查当前节点是否匹配跳过选择器
  for (const selector of skipSelectors) {
    if (node.matches?.(selector)) return true;

    // 检查祖先节点
    let parent = node.parentElement;
    while (parent) {
      if (parent.matches?.(selector)) return true;
      parent = parent.parentElement;
    }
  }

  // 检查节点的类名是否包含特定关键字
  const skipClassKeywords = ['js-', 'btn', 'button', 'u-', 'overlay', 'postActionsBar'];

  if (node.className && typeof node.className === 'string') {
    for (const keyword of skipClassKeywords) {
      if (node.className.includes(keyword)) return true;
    }
  }

  // 忽略代码片段
  if (node.tagName?.toLowerCase() === 'pre' || node.tagName?.toLowerCase() === 'code') return true;

  // 忽略图片图标
  if (node.tagName?.toLowerCase() === 'svg' || node.tagName?.toLowerCase() === 'img') return true;

  return false;
}

function selectMedium(node: Element): SelectResult {
  // 判断是否应该跳过该节点
  if (shouldSkipMediumElement(node)) {
    return { skip: true };
  }

  // 文章标题
  const articleTitle = findMatchingElement(node, 'h1');
  if (articleTitle) return articleTitle;

  // 文章副标题
  const articleSubtitle = findMatchingElement(node, 'h2');
  if (articleSubtitle) return articleSubtitle;

  // 文章段落
  const articleParagraph = findMatchingElement(node, 'p');
  if (articleParagraph) return articleParagraph;

  // 文章列表项
  const articleListItem = findMatchingElement(node, 'li');
  if (articleListItem) return articleListItem;

  // 引用内容
  const blockquote = findMatchingElement(node, 'blockquote');
  if (blockquote) return blockquote;

  // 文章正文容器
  const articleBody = findMatchingElement(node, 'article section');
  if (articleBody) return articleBody;

  // 作者简介
  const authorBio = findMatchingElement(node, 'p.pw-author-note');
  if (authorBio) return authorBio;

  // 评论内容
  const comment = findMatchingElement(node, 'div.pw-responses-thread p');
  if (comment) return comment;

  // 默认不翻译
  return false;
}

export const medium: CompatSite = {
  domain: 'medium.com',
  select: selectMedium,
};
