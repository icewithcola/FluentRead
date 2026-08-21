export type SelectSkip = { skip: true };

/** Result of a site select handler: a candidate element, skip the node, or no opinion. */
export type SelectResult = Element | SelectSkip | false | void;

export type SelectFunction = (node: Element) => SelectResult;

export function isSelectSkip(result: SelectResult): result is SelectSkip {
  return !!result && typeof result === 'object' && 'skip' in result && result.skip === true;
}

export type ReplaceFunction = (node: HTMLElement, text: string) => void;

export interface CompatSite {
  domain: string;
  select?: SelectFunction;
  replace?: ReplaceFunction;
}

export interface SelectCompatFn {
  [domain: string]: SelectFunction;
}

export interface ReplaceCompatFn {
  [domain: string]: ReplaceFunction;
}
