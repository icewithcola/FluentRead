import { findMatchingElement } from '@/entrypoints/utils/common';
import { debugLog } from '../debug';
import { isSpecialContent } from '../special';
import type { CompatSite, SelectResult } from '../types';

/**
 * 判断是否应该跳过Twitter网站上的特定元素
 */
function shouldSkipTwitterElement(node: Element): boolean {
  // 检查是否为特殊内容（URL、邮箱、用户名等）
  if (node.textContent && isSpecialContent(node.textContent)) {
    debugLog('Twitter', '特殊内容', node.textContent);
    return true;
  }

  // 如果当前节点或其祖先节点匹配这些选择器，则跳过
  const skipSelectors = [
    // 侧边栏导航
    // 'nav[aria-label="Primary"]',
    'div[data-testid="sidebarColumn"]',
    // 趋势栏
    'div[aria-label="Timeline: Trending now"]',
    'aside[aria-label="Who to follow"]',
    // 搜索栏
    'div[data-testid="SearchBox_Search_Input"]',
    // 各种按钮和UI元素
    'div[role="button"]',
    'div[data-testid="BottomBar"]',
    // 未展开的帖子操作区域
    'div[role="group"][aria-label]',
    // 推荐关注
    'div[data-testid="suggestedUserHover"]',
    // 各种图标和操作按钮
    'div[aria-label*="icon"]',
    'div[data-testid*="icon"]',
    // 顶部应用栏
    'header[role="banner"]',
    // 字数限制计数器
    'div[data-testid="characterCount"]',
    // 用户名称相关
    'div[data-testid="User-Name"]',
    'div[data-testid="UserName"]',
    'span[data-testid="tweetText"] span.r-bcqeeo',
    // 用户ID和用户名相关
    'div[data-testid="HoverCard"]',
    'div[data-testid="UserCell"]',
    'a[role="link"][href*="/status/"]',
    // 关注按钮
    'div[role="button"][data-testid="follow"]',
    'div[role="button"][data-testid="unfollow"]',
    // 包含"关注"文本的元素
    'div[dir="auto"][id^="id__"]',
  ];

  // 检查当前节点是否匹配跳过选择器
  for (const selector of skipSelectors) {
    if (node.matches?.(selector)) {
      debugLog('Twitter', '选择器匹配跳过', selector, node.textContent);
      return true;
    }
  }

  // 检查节点的类名、属性等特征
  const nodeTag = node.tagName?.toLowerCase();
  if (nodeTag === 'svg' || nodeTag === 'path' || nodeTag === 'g') {
    debugLog('Twitter', 'SVG元素跳过', node.textContent);
    return true;
  }

  // 检查是否为操作按钮文本（点赞、转发、评论等）
  if (node.textContent?.trim().match(/^(\d+|Like|Reply|Retweet|Share)$/)) {
    debugLog('Twitter', '操作按钮跳过', node.textContent);
    return true;
  }

  // 检查是否为用户名或用户ID
  const textContent = node.textContent?.trim();
  if (textContent) {
    // 检查是否为用户名格式
    if (textContent.startsWith('@')) {
      debugLog('Twitter', '用户名跳过', node.textContent);
      return true;
    }

    // 检查是否为用户ID格式
    if (textContent.startsWith('id@')) {
      debugLog('Twitter', '用户ID跳过', node.textContent);
      return true;
    }

    // 检查是否包含关注字样
    if (textContent.includes('关注') || textContent.includes('Follow')) {
      debugLog('Twitter', '关注按钮跳过', node.textContent);
      return true;
    }

    // 检查是否为Twitter用户名标签
    if (/^([A-Za-z0-9_]{1,15})$/.test(textContent)) {
      debugLog('Twitter', '用户名标签跳过', node.textContent);
      return true;
    }
  }

  // 检查常见的Twitter UI元素类名
  const classList = node.classList;
  if (classList) {
    // Twitter常用的UI类名前缀
    for (const className of classList) {
      if (className.startsWith('r-') || className.startsWith('css-')) {
        // 进一步检查节点内容是否为纯UI元素
        const text = node.textContent?.trim();
        if (!text || text.length < 10) {
          debugLog('Twitter', 'UI元素跳过', node.textContent);
          return true;
        }
      }
    }
  }

  // 检查ID属性
  if (node.id && node.id.startsWith('id__')) {
    debugLog('Twitter', 'ID属性跳过', node.textContent);
    return true;
  }

  return false;
}

function selectTwitter(node: Element): SelectResult {
  // 需要先检查是否为应该跳过的元素
  if (shouldSkipTwitterElement(node)) {
    // 开发模式下记录被跳过的Twitter元素
    debugLog('Compat', '跳过Twitter元素:', node.textContent);
    return { skip: true };
  }

  // 个人简介
  const userDescription = findMatchingElement(node, 'div[data-testid="UserDescription"]');
  if (userDescription) return userDescription;

  // 推文正文 - 但不包括用户名提及部分
  const tweetText = findMatchingElement(node, 'div[data-testid="tweetText"]');
  if (tweetText) return tweetText;

  // 评论内容
  const reply = findMatchingElement(node, 'div[role="group"] div[lang]');
  if (reply) return reply;

  // 主页时间线帖子
  const timelineCell = findMatchingElement(node, 'div[data-testid="cellInnerDiv"] div[lang]');
  if (timelineCell) return timelineCell;

  // 返回应该翻译的主要内容元素
  const tweetContent = findMatchingElement(node, 'article div[lang]');
  if (tweetContent) return tweetContent;

  // 默认返回false，表示不翻译
  return false;
}

export const twitter: CompatSite = {
  domain: 'x.com',
  select: selectTwitter,
};
