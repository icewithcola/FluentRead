import { findMatchingElement } from '@/entrypoints/utils/common';
import { debugLog } from '../debug';
import { isSpecialContent } from '../special';
import type { CompatSite, SelectResult } from '../types';

/**
 * 判断是否应该跳过Reddit网站上的特定元素
 */
function shouldSkipRedditElement(node: Element): boolean {
  // 检查是否为特殊内容（URL、邮箱、用户名等）
  if (node.textContent && isSpecialContent(node.textContent)) {
    debugLog('Reddit', '特殊内容跳过', node.textContent);
    return true;
  }

  // 处理帖子标题中的屏幕阅读器内容
  if (node.tagName?.toLowerCase() === 'faceplate-screen-reader-content') {
    debugLog('Reddit', '屏幕阅读器内容跳过', node.textContent);
    return true;
  }

  // 处理帖子中的时间标签
  if (node.tagName?.toLowerCase() === 'time') {
    debugLog('Reddit', '时间标签跳过', node.textContent);
    return true;
  }

  // 如果当前节点或其祖先节点匹配这些选择器，则跳过
  const skipSelectors = [
    // 导航栏和头部
    'header',
    'div._3Qx5bBCG_O8wVZee9J-KyJ', // Reddit的头部容器
    'div._1x6pySZ2CoUnAfsFhGe7J1', // 导航栏
    'div._1QhgSEQa6-vyHBHcV0rygZ', // 顶部横幅
    'nav, div[data-testid="subreddit-header"]', // 导航区域
    'div._3ozFtOe6WpJEMUtxDOIvtU', // 菜单条
    'div._2QZ7T4uAFMs_N83BZcN-Em', // 排序栏

    // Reddit新UI元素
    'faceplate-timeago', // 时间显示组件
    'a[data-ks-id]', // 帖子链接
    'shreddit-post[data-ks-item]', // 帖子组件
    'a[slot="full-post-link"]', // 完整帖子链接
    'span[slot="credit-bar"]', // 信用栏
    'shreddit-post-flair', // 帖子标签
    'shreddit-join-button', // 加入按钮
    'shreddit-post-overflow-menu', // 溢出菜单
    'shreddit-async-loader', // 异步加载器
    'faceplate-hovercard', // 悬停卡片
    'faceplate-tracker', // 跟踪器
    'faceplate-number', // 数字格式化组件
    'shreddit-distinguished-post-tags', // 特殊帖子标签

    // 侧边栏
    'div._1OVBBWLtHoSPfGCRaPzpTf', // 侧边栏容器
    'div.wBtTDilkW_zr1D60d6V2Z', // 侧边栏组件
    'div._3Qkp11fjcAw9I9wtLo8frE', // 边栏卡片
    'div._1HSQGYlfPWzs40LP8sZqzT', // 社区边栏
    'div._2vEf-C2keJaBMY9qk_BxVn', // 侧边栏块
    'div._3Qkp11fjcAw9I9wtLo8frE', // 社区信息卡
    'div._2QmHYFeMADTpuXJtd36LQs', // 边栏模块

    // 表单元素
    'form',
    'input',
    'textarea',
    'button',
    'button._3QMG29bQNj9RUoGMvSHpZg', // 主要按钮
    'button._10K5i7NW6qcm-UoCtpB3aK', // 次要按钮
    'div._3QMG29bQNj9RUoGMvSHpZg, div._10K5i7NW6qcm-UoCtpB3aK', // 按钮容器

    // 帖子操作区
    'div._1ixsU4oQRnNfZ91jhBU74y', // 投票区
    'div._3-SW6hQX6gXK9G4FM74obr', // 评论操作区
    'div._2hw0iZ3L5x8UbnfX8ZDKb', // 操作按钮组
    'div[data-testid="post-comment-header"]', // 评论头部
    'div[data-click-id="upvote"]', // 投票按钮
    'div[data-click-id="downvote"]', // 踩按钮
    'div[data-click-id="share"]', // 分享按钮
    'div[data-click-id="comments"]', // 评论按钮

    // Reddit特定视图元素
    'div[data-post-click-location="text-body"]', // 帖子正文点击区域
    'div.md.feed-card-text-preview', // 帖子预览
    'div#feed-post-credit-bar', // 帖子信用栏
    'span.created-separator', // 创建分隔符
    'span.inline-block.my-0.created-separator', // 分隔符
    'div[data-testid="post-content"]', // 帖子内容

    // 投票和互动小组件 - 从截图中可见的元素
    'button._2pFdCpgBihIaYh9DSMWBIu', // 通用按钮
    'div._1E9mcoVn4MYnuBQSVDt1gC', // 投票区域容器
    'span._vaFo96phV6L5Hltvwcox', // 投票计数元素
    'div._3-SW6hQX6gXK9G4FM74obr', // 操作按钮区
    'div._3Qkp11fjcAw9I9wtLo8frE', // 帖子信息卡
    'div._2X6EB3ZhEeXCh1eIVA64XM, div._1hwEKkB_38tIoal6fcdrt9', // 内置小组件
    'div._3nSp9cdBpqL13CqjdMr2L_', // 统计信息元素
    'div._2FKpII1jz0h6xCAw1kQAvS, div._2xLbdLcm9WYMj6tMTDwBmf', // 互动区域
    'div._3U_7i38RDFqmOFXMuRZYvZ, div._VmOLt6lJfSjP8Pr5DL9T', // 分享和存储按钮

    // Reddit新版统计元素
    'span[data-testid="community-hover-card:active-count"]', // 社区活跃用户计数
    'span.bg-kiwigreen-400', // 在线状态指示器
    'span.text-12.leading-4.text-neutral-content-weak', // 状态文本

    // 界面控制元素
    'a[href="/settings"]', // 设置链接
    'div[role="menu"]', // 菜单角色元素
    'div[role="button"]', // 按钮角色元素
    'div._JRBNstMcGxbZUxrrIKXe, div._2IHh1GBfUxJVQQX0dJvAEf', // 折叠/展开控制
    'div._3MknXZVbkWU8JL9XGlzASi, div._3Z6MIaeww5FJSez7H2YWXi', // 滚动控制
    'div[data-adclicklocation="top_bar"]', // 广告位置属性
    'a[data-click-id="subreddit"]', // 社区链接控件

    // 广告
    'div.promotedlink',
    'div._3Qkp11fjcAw9I9wtLo8frE div._2vEf-C2keJaBMY9qk_BxVn',
    'div[data-before-content="advertisement"]', // 广告标记
    'div[data-testid="post-container"][data-promoted="true"]', // 推广帖子
    'div[data-testid="post"][data-promoted="true"]', // 另一种推广帖子
    'div.ad-container, div.AdPlace', // 广告容器

    // 搜索栏
    'div._2dkUkgReBsuY2IHM9aAHMx', // 搜索栏
    'input[name="q"]', // 搜索输入框
    'div._1LganuXpbKgkYX39pbmrCl, form._1QxZxZ9ntXPkuXMnfDTHzH', // 搜索表单元素

    // 底部
    'footer',
    'div._3w_665DK_NH7yIsRMuZkqB',
    'div._3Wl-riAhLCZuDLzWNbD_z6', // 底部导航
    'div._3qX0zy2NNkra76bgyHbrcR, div._10YWGZZj2W-2J7T-IJVVNU', // 底部链接组

    // 用户相关
    'a[data-testid="post_author_link"]',
    'a.author',
    'span.author',
    'a[data-testid="comment_author_link"]',
    'div._2mHuuvyV9doV3zwbZPtIPG', // 用户信息栏
    'a._3BcIEQadBHDKnV8E-qUMtJ', // 用户链接
    'div._23wugcdiaj44hdfugIAlnX', // 用户标记
    'div[data-testid="comment_author"]', // 评论作者
    'span._12nHw-MGuz_r1dQx4wxxAf, a._12nHw-MGuz_r1dQx4wxxAf', // 用户名显示元素
    'div[data-testid="subreddit-sidebar"] div._3ryJoIoycVkI7DggMcJiKM', // 社区用户栏

    // 统计信息
    'span._vaFo96phV6L5Hltvwcox', // 投票数
    'span._1jNPl3YUk6zbpLWdjaJT1r', // 评论数
    'div._2mHuuvyV9doV3zwbZPtIPG', // 时间戳
    'div._2ETuFsOP3jKbVR95iRImaDvU-g6W3dAQ', // 帖子信息栏
    'div._3-SW6hQX6gXK9G4FM74obr span', // 操作按钮文本
    'div._3XFx6CfPlg-4Usgxm0gK8R, div.BilRyRl5iuFY2VJoNfVz0', // 统计区域
    'div._11dVAO6CK-nOlDyrYr6tsX, div._3ioGMz1QkHcUCVgLx3kzOQ', // 计数
    'div._2hYRM7d0BaB17cCB3FGmm9', // 时间计数

    // 横幅和通知
    'div._3q-XSJ2JokLxfTqcOzQxzf', // 新帖子通知
    'div[data-redditstyle="true"] div._1DooEIX-1Nj5rweIc5cw_E', // 常见的横幅
    'div._31L5xyMG1DzvGnqhbHkKV4, div._3NpZ0JJ2ZEBZXLpt7AMxgW', // 通知条
    'div._3Im6OD67aKo33nql4FpSp0, div._2zeq1aXKDHDDXUNXAJyRVk', // 系统消息

    // 其他Reddit特定元素
    'div._2vkeRJojnV7cb9pMlPHy7d', // Join按钮
    'div[data-testid="frontpage-sidebar"]', // 首页侧边栏
    'div._2vEf-C2keJaBMY9qk_BxVn button', // 侧边栏按钮
    'div._3Qx5bBCG_O8wVZee9J-KyJ', // 头部区域
    'div[data-testid="subreddit-name"]', // 社区名区域
    'div._2x02fRB8KYZPG74bIR0jpe', // 帖子工具栏
    'div[data-test-id="post-content"] video', // 视频内容
    'div._3gbb_EMFXxTYrxDZ2kusIp', // 图片帖子
    'div._1sDtEhccxFpHDn2ruDutJe', // 链接预览
    'div._2wKMjKBrZFbRMP33ghA1uI', // 投票条
    'div._3_HlHJ56dAfStT19Jgl1bF', // 投票按钮组
    'div._pGofQ7zn0wPWxvde-6HDL', // 各种徽章
    'div._33axOHPa8DzNnTmwzen-wO', // 奖励徽章
    'div._2hgXdc8jVQaXYAXvnqVBBh, div._1yxKmMhLFJJp2CfU1jFZz5', // 热门/新帖子标签
    'div._2FbYTP2kJW6pyJnjwLWr8f, div._3bl3XkXsAgnvhW0Ghm6Dh-', // 首页主题控制栏
  ];

  // 检查当前节点是否匹配跳过选择器
  for (const selector of skipSelectors) {
    if (node.matches?.(selector)) {
      debugLog('Reddit', '选择器匹配跳过', selector, node.textContent);
      return true;
    }
  }

  // 检查数据属性
  const skipDataAttributes = [
    'click-id="share"',
    'click-id="upvote"',
    'click-id="downvote"',
    'click-id="award"',
    'click-id="comments"',
    'click-id="save"',
    'click-id="vote-arrows"',
    'click-id="media"',
    'adclicklocation',
    'promoted="true"',
    'test-id="comment-top-meta"',
  ];

  for (const attr of skipDataAttributes) {
    if (node.hasAttribute && node.hasAttribute(attr)) {
      debugLog('Reddit', '数据属性匹配跳过', attr);
      return true;
    }
  }

  // 检查节点的类名是否包含特定关键字
  const skipClassKeywords = [
    '_',
    'icon',
    'Button',
    'vote',
    'score',
    'flair',
    'author',
    'award',
    'caret',
    'expando',
    'menu',
    'hover',
    'promoted',
    'badge',
    'thumbnail',
    'timestamp',
    'banner',
    'hover',
    'nav',
    'submit',
    'upvote',
    'downvote',
    'premium',
    'moderator',
    'join',
    'subscribe',
    'share',
    'save',
    'expand',
    'collapse',
    'points',
  ];

  if (node.className && typeof node.className === 'string') {
    for (const keyword of skipClassKeywords) {
      if (node.className.includes(keyword) && node.textContent?.length < 20) {
        debugLog('Reddit', '类名关键字跳过', keyword, node.className);
        return true;
      }
    }
  }

  // 检查是否为用户名格式
  const textContent = node.textContent?.trim();
  if (textContent) {
    // Reddit用户名格式 u/username
    if (/^u\/\w+$/.test(textContent)) {
      debugLog('Reddit', '用户名格式跳过', textContent);
      return true;
    }

    // 社区名格式 r/community
    if (/^r\/\w+$/.test(textContent)) {
      debugLog('Reddit', '社区名格式跳过', textContent);
      return true;
    }

    // 跳过投票计数
    if (/^\d+(\.\d+)?[kKmM]?$/.test(textContent) || /^[+-]?\d+(\.\d+)?[kKmM]?$/.test(textContent)) {
      debugLog('Reddit', '投票计数跳过', textContent);
      return true;
    }

    // 跳过时间戳格式
    if (/^(Posted )?\d+ (minutes|hours|days|weeks|months|years) ago$/.test(textContent)) {
      debugLog('Reddit', '时间戳跳过', textContent);
      return true;
    }

    // 跳过评论计数
    if (/^\d+(\.\d+)?[kKmM]? comments?$/.test(textContent)) {
      debugLog('Reddit', '评论计数跳过', textContent);
      return true;
    }

    // 统计数字格式: "19K", "1K", 等
    if (/^\s*\d+[KkMmBb]?\s*$/.test(textContent)) {
      debugLog('Reddit', '统计数字跳过', textContent);
      return true;
    }

    // 跳过Reddit常用UI文本
    const skipPhrases = [
      'upvote',
      'downvote',
      'share',
      'save',
      'hide',
      'report',
      'crosspost',
      'award',
      'reply',
      'give award',
      'hide',
      'comments',
      'comment',
      'best',
      'top',
      'new',
      'controversial',
      'old',
      'random',
      'live',
      'hot',
      'rising',
      'gilded',
      'wiki',
      'mod',
      'moderator',
      'approved',
      'submission',
      'removed',
      'spam',
      'reported',
      'locked',
      'unlocked',
      'pinned',
      'unpinned',
      'archived',
      'unarchived',
      'distinguished',
      'undistinguished',
      'spoiler',
      'nsfw',
      'upvoted',
      'downvoted',
      'follow',
      'join',
      'create post',
      'community options',
      'sort by',
      'join',
      'leave',
      'view all comments',
      'more comments',
      'continue this thread',
      'copy link',
      'mark as spoiler',
      'delete',
      'edit',
      'embed',
      'follow thread',
      'add to collection',
      'post insights',
      'view poll',
      'download',
      'open in app',
      'view community',
    ];

    for (const phrase of skipPhrases) {
      if (textContent.toLowerCase() === phrase) {
        debugLog('Reddit', '常用UI文本跳过', textContent);
        return true;
      }
    }
  }

  // 忽略代码片段
  if (node.tagName?.toLowerCase() === 'pre' || node.tagName?.toLowerCase() === 'code') {
    debugLog('Reddit', '代码片段跳过');
    return true;
  }

  // 忽略图片和图标
  if (node.tagName?.toLowerCase() === 'svg' || node.tagName?.toLowerCase() === 'img') {
    debugLog('Reddit', '图片/图标跳过');
    return true;
  }

  return false;
}

function selectReddit(node: Element): SelectResult {
  // 判断是否应该跳过该节点
  if (shouldSkipRedditElement(node)) {
    debugLog('Reddit', '跳过Reddit元素', node.textContent);
    return { skip: true };
  }

  // 帖子标题
  const postTitle = findMatchingElement(node, 'h1, h3[data-click-id="body"]');
  if (postTitle) {
    debugLog('Reddit', '翻译帖子标题', postTitle.textContent);
    return postTitle;
  }

  // 描述文本
  const description = findMatchingElement(
    node,
    'div.community-details-heading p, div.community-details p, div.wiki-page-content, div[data-click-id="text"]',
  );
  if (description) {
    debugLog('Reddit', '翻译描述文本', description.textContent?.substring(0, 50) + '...');
    return description;
  }

  // Wiki内容
  const wikiContent = findMatchingElement(node, 'div.md-container div.md, div.md');
  if (wikiContent) {
    debugLog('Reddit', '翻译Wiki内容', wikiContent.textContent?.substring(0, 50) + '...');
    return wikiContent;
  }

  // 社区描述
  const communityDescription = findMatchingElement(
    node,
    'div[data-click-id="about"] h2, div[data-redditstyle="true"] h2',
  );
  if (communityDescription) {
    debugLog('Reddit', '翻译社区描述', communityDescription.textContent);
    return communityDescription;
  }

  // 社区规则
  const communityRules = findMatchingElement(
    node,
    'div.rules-list div.rule-item div.rule-item-body, div.rule-item p',
  );
  if (communityRules) {
    debugLog('Reddit', '翻译社区规则', communityRules.textContent);
    return communityRules;
  }

  // 帖子卡片内容
  const postCard = findMatchingElement(node, 'div[data-testid="post-title"], div.Post h3');
  if (postCard) {
    debugLog('Reddit', '翻译帖子卡片', postCard.textContent);
    return postCard;
  }

  // 公告内容
  const announcement = findMatchingElement(node, 'div[data-testid="content"], div.announcement');
  if (announcement) {
    debugLog('Reddit', '翻译公告内容', announcement.textContent?.substring(0, 50) + '...');
    return announcement;
  }

  // 默认不翻译
  return false;
}

export const reddit: CompatSite = {
  domain: 'reddit.com',
  select: selectReddit,
};
