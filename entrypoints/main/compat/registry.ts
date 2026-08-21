import type { CompatSite, ReplaceCompatFn, SelectCompatFn } from './types';

export function registerSites(sites: CompatSite[]): {
  selectCompatFn: SelectCompatFn;
  replaceCompatFn: ReplaceCompatFn;
} {
  const selectCompatFn: SelectCompatFn = {};
  const replaceCompatFn: ReplaceCompatFn = {};

  for (const site of sites) {
    if (site.select) selectCompatFn[site.domain] = site.select;
    if (site.replace) replaceCompatFn[site.domain] = site.replace;
  }

  return { selectCompatFn, replaceCompatFn };
}
