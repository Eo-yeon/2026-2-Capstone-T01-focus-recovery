// Compare both directions so appended comments/menus do not count as a new document.
export function isMajorContentChange(previous: string, current: string): boolean {
  if (previous === current || [...current].length < 50) return false;
  const chunks = (text: string) => {
    const flat = text.replace(/\s+/g, ' ').trim();
    const result = new Set<string>();
    for (let i = 0; i < flat.length; i += 32) result.add(flat.slice(i, i + 32));
    return result;
  };
  const coverage = (source: Set<string>, target: string) => [...source].filter(part => target.includes(part)).length / Math.max(1, source.size);
  const a = previous.replace(/\s+/g, ' ').trim();
  const b = current.replace(/\s+/g, ' ').trim();
  return Math.max(coverage(chunks(previous), b), coverage(chunks(current), a)) < 0.6;
}
