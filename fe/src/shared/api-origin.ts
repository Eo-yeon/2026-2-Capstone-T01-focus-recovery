export function isApiOrigin(value: unknown): value is string {
  if (typeof value !== 'string' || /[\s?#]/.test(value)) return false;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && url.pathname === '/';
  } catch { return false; }
}
