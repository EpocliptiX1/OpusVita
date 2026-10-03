// Tiny SVG chart helpers (no library). Colours come from CSS classes so dark mode works.
const Charts = (() => {
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function scale(values, extra = [], padPct = 0.12) {
    const all = values.concat(extra).filter(v => v != null);
    let min = Math.min(...all), max = Math.max(...all);
    const pad = (max - min || max || 1) * padPct;
    min -= pad; max += pad;
    return v => (max - v) / (max - min);
  }

  // vertical bars, optionally highlighting bars above a baseline
  function bars(values, { width: W = 320, labels = [], baseline = null, height = 120, fmt = v => v, zero = false, labelEvery = 1 } = {}) {
    const n = values.length, gap = n > 14 ? 2 : Math.min(14, W / 40), bw = (W - gap * (n - 1)) / n, top = 8, h = height - 22;
    const y = zero ? v => 1 - v / (Math.max(...values, baseline || 0) * 1.1) : scale(values, [...(baseline != null ? [baseline] : []), Math.min(...values) - (Math.max(...values) - Math.min(...values) || 10) * 0.6], 0.15);
    let s = `<svg viewBox="0 0 ${W} ${height}" class="chart-svg" role="img">`;
    values.forEach((v, i) => {
      const x = i * (bw + gap), yy = top + y(v) * h, cls = baseline != null && v > baseline ? 'c-hi' : 'c-bar';
      s += `<rect class="${cls}" x="${x}" y="${yy}" width="${bw}" height="${Math.max(2, top + h - yy)}" rx="${Math.min(6, bw / 3)}"><title>${esc(labels[i] || '')}: ${esc(fmt(v))}</title></rect>`;
      if (labels[i] && i % labelEvery === 0) s += `<text class="c-label" x="${x + bw / 2}" y="${height - 4}" text-anchor="middle">${esc(labels[i])}</text>`;
    });
    if (baseline != null) s += `<line class="c-base" x1="0" x2="${W}" y1="${top + y(baseline) * h}" y2="${top + y(baseline) * h}"/>`;
    return s + '</svg>';
  }

  // line with soft area fill
  function line(values, { width: W = 320, labels = [], baseline = null, height = 130, fmt = v => v, labelEvery = 1, dots = true } = {}) {
    const n = values.length, top = 10, h = height - 26, step = W / Math.max(1, n - 1);
    const y = scale(values, baseline != null ? [baseline] : []);
    const pts = values.map((v, i) => [i * step, top + y(v) * h]);
    const d = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
    let s = `<svg viewBox="-4 0 ${W + 8} ${height}" class="chart-svg" role="img">`;
    s += `<path class="c-area" d="${d} L ${W} ${top + h} L 0 ${top + h} Z"/>`;
    if (baseline != null) s += `<line class="c-base" x1="0" x2="${W}" y1="${top + y(baseline) * h}" y2="${top + y(baseline) * h}"/>`;
    s += `<path class="c-line" d="${d}"/>`;
    pts.forEach((p, i) => {
      const last = i === n - 1;
      if (dots && (n <= 14 || last)) s += `<circle class="${last ? 'c-dot-last' : 'c-dot'}" cx="${p[0]}" cy="${p[1]}" r="${last ? 4.5 : 3}"><title>${esc(labels[i] || '')}: ${esc(fmt(values[i]))}</title></circle>`;
      if (labels[i] && i % labelEvery === 0) s += `<text class="c-label" x="${p[0]}" y="${height - 4}" text-anchor="${i === 0 ? 'start' : last ? 'end' : 'middle'}">${esc(labels[i])}</text>`;
    });
    return s + '</svg>';
  }

  // stacked sleep stages: rows = [{deep, rem, light, awake}]
  function stacked(rows, { width: W = 320, labels = [], height = 140 } = {}) {
    const keys = ['deep', 'rem', 'light', 'awake'];
    const n = rows.length, gap = n > 14 ? 2 : Math.min(16, W / 32), bw = (W - gap * (n - 1)) / n, top = 6, h = height - 22;
    const max = Math.max(...rows.map(r => keys.reduce((s, k) => s + r[k], 0))) * 1.05;
    let s = `<svg viewBox="0 0 ${W} ${height}" class="chart-svg" role="img">`;
    rows.forEach((r, i) => {
      let yy = top + h;
      const x = i * (bw + gap);
      keys.forEach(k => {
        const hh = (r[k] / max) * h;
        yy -= hh;
        s += `<rect class="c-${k}" x="${x}" y="${yy}" width="${bw}" height="${hh}"><title>${esc(labels[i])} · ${k}: ${Math.round(r[k])} min</title></rect>`;
      });
      if (labels[i] && (n <= 14 || i % 5 === 0)) s += `<text class="c-label" x="${x + bw / 2}" y="${height - 4}" text-anchor="middle">${esc(labels[i])}</text>`;
    });
    return s + '</svg>';
  }

  // circular score gauge
  function ring(score, { size = 120, stroke = 11 } = {}) {
    const r = (size - stroke) / 2, c = 2 * Math.PI * r, off = c * (1 - score / 100);
    const cls = score >= 75 ? 'ok' : score >= 55 ? 'warn' : 'bad';
    return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" class="ring ${cls}">
      <circle class="ring-bg" cx="${size / 2}" cy="${size / 2}" r="${r}" stroke-width="${stroke}"/>
      <circle class="ring-fg" cx="${size / 2}" cy="${size / 2}" r="${r}" stroke-width="${stroke}" stroke-dasharray="${c}" stroke-dashoffset="${off}" transform="rotate(-90 ${size / 2} ${size / 2})"/>
      <text x="50%" y="50%" class="ring-num" text-anchor="middle" dominant-baseline="central">${score}</text></svg>`;
  }

  return { bars, line, stacked, ring };
})();
