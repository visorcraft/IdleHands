export function extractFirstText(obj: any): string | null {
  const texts: string[] = [];
  const walk = (x: any) => {
    if (!x) return;
    if (typeof x === 'object') {
      if (Array.isArray(x)) {
        for (const v of x) walk(v);
        return;
      }
      for (const [k, v] of Object.entries(x)) {
        if (k === 'text' && typeof v === 'string') texts.push(v);
        walk(v);
      }
    }
  };
  walk(obj);
  return texts.length ? texts[0] : null;
}
