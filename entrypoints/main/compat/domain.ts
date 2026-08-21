// 根据浏览器 url.host 是获取获取主域名
export function getMainDomain(url: string | URL): string {
  try {
    // 处理URL对象或字符串
    let hostname = '';

    // 如果是URL字符串，提取hostname部分
    if (typeof url === 'string') {
      // 移除协议部分
      const noProtocol = url.replace(/^(https?:\/\/)/, '');
      // 提取域名部分（移除路径和查询参数）
      hostname = noProtocol.split('/')[0];
    } else if (url instanceof URL) {
      hostname = url.hostname;
    } else {
      return '';
    }

    // 处理特殊情况: 将Twitter的旧域名和新域名统一处理
    if (
      hostname === 'twitter.com' ||
      hostname === 'x.com' ||
      hostname === 'www.twitter.com' ||
      hostname === 'www.x.com'
    ) {
      return 'x.com';
    }

    // 移除可能的www前缀
    hostname = hostname.replace(/^www\./, '');

    // 提取基本域名
    const parts = hostname.split('.');
    if (parts.length >= 2) {
      // 对于常见的二级域名（如co.uk），需要特殊处理
      if (
        parts.length >= 3 &&
        (parts[parts.length - 2] === 'co' || parts[parts.length - 2] === 'com') &&
        parts[parts.length - 1].length === 2
      ) {
        // 例如 example.co.uk 应该返回 example.co.uk
        return parts.slice(-3).join('.');
      } else {
        // 否则返回主域名和顶级域名
        return parts.slice(-2).join('.');
      }
    }

    return hostname;
  } catch (error) {
    console.error('getMainDomain error:', error);
    return '';
  }
}
