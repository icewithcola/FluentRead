const isDev = process.env.NODE_ENV === 'development';

/**
 * 调试日志函数，只在开发模式下输出
 * @param type 日志类型
 * @param message 日志消息
 * @param ...args 日志参数
 */
export function debugLog(type: string, message: string, ...args: unknown[]): void {
  if (!isDev) return;

  // 为不同类型设置不同颜色
  const colors: { [key: string]: string } = {
    Twitter: 'color: #1DA1F2; font-weight: bold',
    GitHub: 'color: #6e5494; font-weight: bold',
    StackOverflow: 'color: #f48024; font-weight: bold',
    Reddit: 'color: #FF4500; font-weight: bold',
    Medium: 'color: #00ab6c; font-weight: bold',
    YouTube: 'color: #FF0000; font-weight: bold', // 添加YouTube的颜色
    Compat: 'color: #0366d6; font-weight: bold',
    Skip: 'color: #d73a49; font-weight: bold',
    Content: 'color: #28a745; font-weight: bold',
    Default: 'color: #24292e; font-weight: bold',
  };

  const color = colors[type] || colors['Default'];
  const prefix = `%c[Catgirl Read][${type}]`;

  // 根据日志类型决定是否需要分组
  if (['Content', 'Skip', 'YouTube', 'GitHub', 'Twitter'].includes(type) && args.length > 0) {
    // 使用折叠分组，减少日志视觉干扰
    console.groupCollapsed(prefix, color, message);
    args.forEach((arg, index) => {
      if (typeof arg === 'string') {
        console.log(`参数${index + 1}:`, arg.substring(0, 100) + (arg.length > 100 ? '...' : ''));
      } else {
        console.log(`参数${index + 1}:`, arg);
      }
    });
    console.groupEnd();
  } else {
    // 常规日志输出
    console.log(prefix, color, message, ...args);
  }
}
