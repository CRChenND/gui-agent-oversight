const TOOL_MARKUP_START_REGEX = /(?:```(?:xml|bash)\s*)?<tool>/i;

export function stripToolMarkup(content: string): string {
  if (!content) return '';

  const withoutCompleteBlocks = content
    .replace(/(```(?:xml|bash)\s*)?<tool>[\s\S]*?<\/requires_approval>(\s*```)?/gi, '')
    .replace(/(```(?:xml|bash)\s*)?<tool>[\s\S]*?<\/input>(\s*```)?/gi, '');

  const startMatch = withoutCompleteBlocks.match(TOOL_MARKUP_START_REGEX);
  if (!startMatch || typeof startMatch.index !== 'number') {
    return withoutCompleteBlocks;
  }

  return withoutCompleteBlocks.slice(0, startMatch.index);
}

export function containsVisibleContentOutsideToolMarkup(content: string): boolean {
  return stripToolMarkup(content).trim().length > 0;
}
