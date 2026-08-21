import { findMatchingElement } from '@/entrypoints/utils/common';
import type { CompatSite, SelectResult } from '../types';

/**
 * 判断是否应该跳过Stack Overflow网站上的特定元素
 */
function shouldSkipStackOverflowElement(node: Element): boolean {
  // 如果当前节点或其祖先节点匹配这些选择器，则跳过
  const skipSelectors = [
    // 导航栏
    'nav.s-topbar',
    'div.s-topbar',
    // 侧边栏
    'div.s-sidebarwidget',
    // 表单元素
    'form',
    'input',
    'textarea',
    'button',
    // 代码块
    'pre.s-code-block',
    'code',
    // 操作按钮
    'div.js-voting-container',
    'div.js-post-menu',
    // 链接和标签
    'div.post-taglist',
    'div.module.community-bulletin',
    // 统计信息
    'div.-flair',
    'div.s-stats',
    'div.s-badge',
    // 页脚
    'footer',
    'div.site-footer',
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
  const skipClassKeywords = ['js-', 'icon', 'btn', 'badge', 'vote', 'tag', 's-btn', 'vote-count'];

  if (node.className && typeof node.className === 'string') {
    for (const keyword of skipClassKeywords) {
      if (node.className.includes(keyword)) return true;
    }
  }

  // 忽略代码片段
  if (node.tagName?.toLowerCase() === 'pre' || node.tagName?.toLowerCase() === 'code') return true;

  // 忽略图标
  if (node.tagName?.toLowerCase() === 'svg') return true;

  return false;
}

function selectStackOverflow(node: Element): SelectResult {
  // 判断是否应该跳过该节点
  if (shouldSkipStackOverflowElement(node)) {
    return { skip: true };
  }

  // 首先翻译最重要的内容

  // 然后翻译次要但仍然重要的内容

  // 问题标题
  const questionTitle = findMatchingElement(node, 'h1.question-hyperlink');
  if (questionTitle) return questionTitle;

  // 问题描述摘要
  const excerpt = findMatchingElement(node, 'div.excerpt');
  if (excerpt) return excerpt;

  // 最后翻译其他辅助内容

  // 问题状态提示
  const status = findMatchingElement(node, 'div.question-status');
  if (status) return status;

  // 用户简介
  const userProfile = findMatchingElement(node, 'div.profile-about');
  if (userProfile) return userProfile;

  // 错误提示
  const errorMessage = findMatchingElement(node, 'div.s-notice');
  if (errorMessage) return errorMessage;

  // 默认不翻译
  return false;
}

export const stackoverflow: CompatSite = {
  domain: 'stackoverflow.com',
  select: selectStackOverflow,
};
