import { config } from '@/entrypoints/utils/config';

/**
 * Chrome 内置翻译 API 服务
 * 基于 Chrome 浏览器的 Translation API 实现快速、安全的翻译
 *
 * 使用 Chrome Offscreen API 在独立的 DOM 环境中运行翻译功能
 */

// Track whether offscreen document is being created to avoid race conditions
let creatingOffscreen: Promise<void> | null = null;

// 在 background script 中使用 offscreen API 处理翻译
async function translateWithOffscreen(message: any): Promise<any> {
  try {
    // 确保 offscreen 文档存在
    await ensureOffscreenDocument();

    // 向 offscreen 文档发送翻译请求
    const response = await new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error('Chrome 内置翻译响应超时，请稍后重试'));
      }, 30000);

      chrome.runtime.sendMessage(
        {
          type: 'CHROME_TRANSLATE_OFFSCREEN',
          data: {
            text: message.origin,
            from: config.from,
            to: config.to,
          },
        },
        (response: any) => {
          clearTimeout(timeoutId);
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(response);
          }
        },
      );
    });

    // 检查响应
    if (response && typeof response === 'object' && 'success' in response) {
      const typedResponse = response as { success: boolean; result?: string; error?: string };
      if (typedResponse.success) {
        return typedResponse.result;
      } else {
        throw new Error(typedResponse.error || '翻译失败');
      }
    }

    throw new Error('Chrome 内置翻译返回异常，请重试');
  } catch (error) {
    console.error('Offscreen 翻译失败:', error);
    throw new Error(error instanceof Error ? error.message : 'Chrome 内置翻译暂时不可用');
  }
}

// 确保 offscreen 文档存在
async function ensureOffscreenDocument() {
  // If already creating, wait for that to finish
  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }

  // Check if offscreen API is available
  if (!chrome.offscreen) {
    throw new Error('当前浏览器暂不支持 Chrome 内置翻译，请升级 Chrome 或在设置中切换其他翻译服务');
  }

  try {
    // Check if offscreen document already exists
    // chrome.runtime.getContexts is available in Chrome 116+
    if (chrome.runtime.getContexts) {
      const existingContexts = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT' as any],
      });
      if (existingContexts.length > 0) {
        return; // Already exists
      }
    } else {
      // Fallback for older Chrome versions: try to create and handle "already exists" error
      console.warn('chrome.runtime.getContexts not available, using fallback');
    }

    // 创建 offscreen 文档
    creatingOffscreen = chrome.offscreen.createDocument({
      url: chrome.runtime.getURL('offscreen.html'),
      reasons: ['DOM_SCRAPING' as any],
      justification: 'Chrome Translation API requires DOM context',
    });

    await creatingOffscreen;
    console.log('Offscreen 文档创建成功');
  } catch (error: any) {
    // If the document already exists, that's fine
    if (error?.message?.includes('Only a single offscreen')) {
      console.log('Offscreen 文档已存在');
      return;
    }
    console.error('创建 offscreen 文档失败:', error);
    throw new Error('Chrome 内置翻译初始化失败，请稍后重试或切换其他翻译服务');
  } finally {
    creatingOffscreen = null;
  }
}

// 主翻译函数
export default async function chromeTranslator(message: any): Promise<any> {
  const text = message.origin;

  if (!text || typeof text !== 'string' || text.trim() === '') {
    throw new Error('翻译文本不能为空');
  }

  // Service Worker (background) has no window object
  if (typeof window === 'undefined') {
    return await translateWithOffscreen(message);
  }

  // 如果在其他环境中，抛出错误
  throw new Error('当前浏览器暂不支持 Chrome 内置翻译，请升级 Chrome 或在设置中切换其他翻译服务');
}
