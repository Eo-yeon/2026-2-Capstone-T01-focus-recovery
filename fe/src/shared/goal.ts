// Java String.strip()/Character.isWhitespace, including the non-JS whitespace U+001C–001F.
export function normalizeGoal(goal: string): string {
  return goal.replace(/^[\u0009-\u000d\u001c-\u0020\u1680\u2000-\u2006\u2008-\u200a\u2028\u2029\u205f\u3000]+|[\u0009-\u000d\u001c-\u0020\u1680\u2000-\u2006\u2008-\u200a\u2028\u2029\u205f\u3000]+$/g, '');
}
export function validGoal(goal: string): boolean {
  const length = normalizeGoal(goal).length;
  return length >= 5 && length <= 150;
}
