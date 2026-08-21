/**
 * 检查文本内容是否属于不应翻译的特殊内容
 * 比如：URLs、邮箱地址、用户名、代码片段等
 */
export function isSpecialContent(text: string): boolean {
  if (!text) return false;

  const trimmedText = text.trim();

  // 检查是否为URL
  if (/^https?:\/\/\S+/i.test(trimmedText)) return true;

  // 检查是否为邮箱地址
  if (/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(trimmedText)) return true;

  // 检查是否为社交媒体用户名格式
  if (/^@\w+$/.test(trimmedText)) return true; // Twitter格式：@username
  if (/^u\/\w+$/.test(trimmedText)) return true; // Reddit格式：u/username

  // 检查是否为x.com或twitter.com的ID格式
  if (/^id@https?:\/\/(x\.com|twitter\.com)\/[\w-]+\/status\/\d+/.test(trimmedText)) return true;

  // 检查是否为GitHub相关特殊内容
  // GitHub Issue或PR编号
  if (/^#\d+$/.test(trimmedText)) return true;
  // GitHub仓库引用 user/repo#123
  if (/^[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+#\d+$/.test(trimmedText)) return true;
  // GitHub 文件路径
  if (
    /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+\/(blob|tree)\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-\/]+$/.test(
      trimmedText,
    )
  )
    return true;
  // GitHub提交哈希
  if (/^[a-f0-9]{7,40}$/.test(trimmedText)) return true;
  // 以.开头的文件名
  if (/^\.[a-zA-Z0-9_.-]+$/.test(trimmedText)) return true;
  // 以通过文件后缀结尾的
  if (/^[a-zA-Z0-9_.-]+\.[a-zA-Z0-9_.-]+$/.test(trimmedText)) return true;

  // 检查是否为代码片段（简单判断，可能会有误判）
  if (/^[a-zA-Z0-9_]+\([^)]*\)/.test(trimmedText)) return true; // 函数调用
  if (/^import\s+|^from\s+|^require\(/.test(trimmedText)) return true; // 导入语句
  if (/^const\s+|^let\s+|^var\s+|^function\s+/.test(trimmedText)) return true; // 变量/函数声明

  // 检查是否为哈希值或其他特殊标识符
  if (/^[a-f0-9]{8,}$/i.test(trimmedText)) return true;

  return false;
}
