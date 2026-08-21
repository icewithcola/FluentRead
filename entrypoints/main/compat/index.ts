// 兼容部分网站独特的 DOM 结构。站点规则按主域名注册，查找 API 与拆分前一致。
import { registerSites } from './registry';
import { github } from './sites/github';
import { hn } from './sites/hn';
import { medium } from './sites/medium';
import { reddit } from './sites/reddit';
import { aozora, mvnrepository, webtrees } from './sites/simple';
import { stackoverflow } from './sites/stackoverflow';
import { twitter } from './sites/twitter';
import { youtube } from './sites/youtube';

export { getMainDomain } from './domain';
export { isSelectSkip } from './types';
export type { ReplaceFunction, SelectFunction, SelectResult } from './types';

const { selectCompatFn, replaceCompatFn } = registerSites([
  mvnrepository,
  aozora,
  youtube,
  webtrees,
  twitter,
  github,
  stackoverflow,
  medium,
  reddit,
  hn,
]);

export { selectCompatFn, replaceCompatFn };
