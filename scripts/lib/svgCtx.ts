// A small CanvasRenderingContext2D stand-in that records what `draw.ts` paints as SVG, so the overlay can be rendered to
// a PNG (via sharp) without a browser. Text widths are approximated, which is fine for pictures and layout checks.
export function svgCtx(width: number, height: number) {
  const out: string[] = [];
  let path = '';
  const st = {
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    globalAlpha: 1,
    font: '10px sans-serif',
    textAlign: 'start',
    textBaseline: 'alphabetic',
  };
  const stack: (typeof st)[] = [];
  const px = () => Number(/(\d+(?:\.\d+)?)px/.exec(st.font)?.[1] ?? 10);
  const bold = () => (st.font.startsWith('bold') ? 'bold' : 'normal');
  const n = (v: number) => +v.toFixed(2);
  const op = () => (st.globalAlpha === 1 ? '' : ` opacity="${st.globalAlpha}"`);
  const ctx = {
    get fillStyle() {
      return st.fillStyle;
    },
    set fillStyle(v: string) {
      st.fillStyle = v;
    },
    get strokeStyle() {
      return st.strokeStyle;
    },
    set strokeStyle(v: string) {
      st.strokeStyle = v;
    },
    get lineWidth() {
      return st.lineWidth;
    },
    set lineWidth(v: number) {
      st.lineWidth = v;
    },
    get globalAlpha() {
      return st.globalAlpha;
    },
    set globalAlpha(v: number) {
      st.globalAlpha = v;
    },
    get font() {
      return st.font;
    },
    set font(v: string) {
      st.font = v;
    },
    get textAlign() {
      return st.textAlign;
    },
    set textAlign(v: string) {
      st.textAlign = v;
    },
    get textBaseline() {
      return st.textBaseline;
    },
    set textBaseline(v: string) {
      st.textBaseline = v;
    },
    save: () => void stack.push({ ...st }),
    restore: () => void Object.assign(st, stack.pop()),
    beginPath: () => void (path = ''),
    rect: (x: number, y: number, w: number, h: number) =>
      void (path = `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}"`),
    roundRect: (x: number, y: number, w: number, h: number, r: number) =>
      void (path = `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" rx="${r}"`),
    ellipse: (cx: number, cy: number, rx: number, ry: number) =>
      void (path = `<ellipse cx="${n(cx)}" cy="${n(cy)}" rx="${n(rx)}" ry="${n(ry)}"`),
    fill: () => void (path && out.push(`${path} fill="${st.fillStyle}" stroke="none"${op()}/>`)),
    stroke: () =>
      void (path && out.push(`${path} fill="none" stroke="${st.strokeStyle}" stroke-width="${st.lineWidth}"${op()}/>`)),
    fillRect: (x: number, y: number, w: number, h: number) =>
      void out.push(`<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" fill="${st.fillStyle}"${op()}/>`),
    measureText: (t: string) => ({ width: t.length * px() * 0.66 }),
    fillText: (t: string, x: number, y: number) => {
      const anchor = st.textAlign === 'center' ? 'middle' : 'start';
      const base = st.textBaseline === 'middle' ? 'central' : 'alphabetic';
      out.push(
        `<text x="${n(x)}" y="${n(y)}" font-family="DejaVu Sans, sans-serif" font-weight="${bold()}" font-size="${px()}" text-anchor="${anchor}" dominant-baseline="${base}" fill="${st.fillStyle}"${op()}>${t.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</text>`,
      );
    },
  };
  return {
    ctx: ctx as unknown as CanvasRenderingContext2D,
    svg: () =>
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${out.join('')}</svg>`,
  };
}
