// 구슬 레이스 경기 기록(recording)을 canvas 에 그리는 순수 함수 모음. (React 와 무관해서 Node 에서도 그려 볼 수 있다)
// 승자는 이미 서버가 정했고, 여기서는 기록된 움직임을 보기 좋게 보여주기만 한다.
export const VIEW_W = 480;
export const VIEW_H = 720;
const SEE_W = 440; // 기본 화면에 보이는 트랙의 가로 길이(월드 px). 트랙 전체(600)보다 좁게 잡아 구슬을 크게 보여준다.
const TAU = Math.PI * 2;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const FONT = 'Pretendard, "Malgun Gothic", "Apple SD Gothic Neo", sans-serif';

// 구슬 수에 맞춰 색상환을 균등하게 나눠서 서로 잘 구분되게 한다
export const colorOf = (i, n) => `hsl(${(Math.round((i * 360) / Math.max(n, 1)) + 12) % 360} 88% 58%)`;

export function createRenderer(rec, decoded, names) {
  const { xs, ys, bars } = decoded;
  const n = rec.n, F = rec.frames, r = rec.r, wn = rec.winnerCount;
  const orderIdx = new Array(n);
  rec.order.forEach((m, k) => { orderIdx[m] = k; });
  const finishFrame = ys.map((a) => { const f = a.findIndex((y) => y >= rec.finishY); return f < 0 ? Infinity : f; });
  const cam = { x: 0, y: 0, z: 1, init: false };

  const at = (arr, f) => {
    const f0 = clamp(Math.floor(f), 0, F - 1), f1 = Math.min(F - 1, f0 + 1), t = f - f0;
    return arr[f0] + (arr[f1] - arr[f0]) * t;
  };
  const posAt = (f) => {
    const px = new Array(n), py = new Array(n);
    for (let i = 0; i < n; i++) { px[i] = at(xs[i], f); py[i] = at(ys[i], f); }
    return { px, py };
  };
  const rankList = (f, py) => {
    const done = [], rest = [];
    for (let i = 0; i < n; i++) (finishFrame[i] <= f ? done : rest).push(i);
    done.sort((a, b) => orderIdx[a] - orderIdx[b]);
    rest.sort((a, b) => py[b] - py[a]);
    return done.concat(rest);
  };

  const label = (i, max) => { const t = [...names[i]]; return t.slice(0, max).join('') + (t.length > max ? '…' : ''); };

  function draw(ctx, f, opts = {}) {
    const { px, py } = posAt(f);
    const order = rankList(f, py);

    // 카메라: 선두 무리를 따라간다 (선두 3~4마리의 평균)
    const lead = order.slice(0, Math.min(4, n));
    const fy = lead.reduce((s, i) => s + py[i], 0) / lead.length;
    const fx = lead.reduce((s, i) => s + px[i], 0) / lead.length;
    cam.z += ((opts.zoom || 1) - cam.z) * (cam.init ? 0.05 : 1);
    const S = (VIEW_W / SEE_W) * cam.z;
    const vw = VIEW_W / S, vh = VIEW_H / S;
    const tx = clamp(fx - vw / 2, 0, rec.W - vw);
    const ty = clamp(fy - vh * 0.38, -30, rec.H - vh);
    if (!cam.init) { cam.x = tx; cam.y = ty; cam.init = true; } else { cam.x += (tx - cam.x) * 0.1; cam.y += (ty - cam.y) * 0.1; }

    // 배경 (화면 고정) + 천천히 흐르는 점무늬로 이동감을 준다
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const bg = ctx.createLinearGradient(0, 0, 0, VIEW_H);
    bg.addColorStop(0, '#0b1020'); bg.addColorStop(1, '#1d2347');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    ctx.fillStyle = 'rgba(255,255,255,.07)';
    for (let k = 0; k < 40; k++) {
      const bx = (k * 97) % VIEW_W;
      const by = (((k * 211) % 900) - cam.y * 0.25 * S) % VIEW_H;
      ctx.beginPath(); ctx.arc(bx, (by + VIEW_H) % VIEW_H, 1.6 + (k % 3), 0, TAU); ctx.fill();
    }

    // ---- 월드 ----
    ctx.setTransform(S, 0, 0, S, -cam.x * S, -cam.y * S);
    const y0 = cam.y - 80, y1 = cam.y + vh + 80;

    // 거리 눈금
    ctx.font = `600 ${11 / S}px ${FONT}`; ctx.textAlign = 'left';
    for (let y = 500; y < rec.finishY; y += 500) {
      if (y < y0 || y > y1) continue;
      ctx.fillStyle = 'rgba(255,255,255,.10)'; ctx.fillRect(0, y, rec.W, 1.5 / S);
      ctx.fillStyle = 'rgba(255,255,255,.35)'; ctx.fillText(`${Math.round(y / 10)}m`, 8, y - 4 / S);
    }
    // 출발선
    if (-10 > y0 - 100 && 60 > y0) { ctx.fillStyle = 'rgba(255,255,255,.35)'; ctx.fillText('START', 8, 18); }

    // 벽/경사 (처음 3개는 좌우 벽과 바닥)
    rec.shapes.rects.forEach(([cx, cy, w, h, a], k) => {
      const ext = Math.max(w, h);
      if (cy + ext < y0 || cy - ext > y1) return;
      ctx.save(); ctx.translate(cx, cy); ctx.rotate(a);
      ctx.fillStyle = k < 3 ? '#243049' : '#52627f'; ctx.fillRect(-w / 2, -h / 2, w, h);
      if (k >= 3) { ctx.fillStyle = '#94a3b8'; ctx.fillRect(-w / 2, -h / 2, w, 3); }
      ctx.restore();
    });
    // 핀/범퍼
    for (const [cx, cy, cr] of rec.shapes.circles) {
      if (cy < y0 || cy > y1) continue;
      ctx.beginPath(); ctx.arc(cx, cy, cr, 0, TAU);
      ctx.fillStyle = cr > 15 ? '#f472b6' : '#cbd5e1'; ctx.fill();
      if (cr > 15) { ctx.lineWidth = 3; ctx.strokeStyle = '#fbcfe8'; ctx.stroke(); }
    }
    // 회전 막대(풍차)
    rec.shapes.bars.forEach(([cx, cy, w, h], k) => {
      if (cy < y0 - 160 || cy > y1 + 160) return;
      ctx.save(); ctx.translate(cx, cy); ctx.rotate(at(bars[k], f));
      const g = ctx.createLinearGradient(0, -h, 0, h); g.addColorStop(0, '#fde68a'); g.addColorStop(1, '#f59e0b');
      ctx.fillStyle = g; ctx.fillRect(-w / 2, -h / 2, w, h);
      ctx.beginPath(); ctx.arc(0, 0, 11, 0, TAU); ctx.fillStyle = '#fff7ed'; ctx.fill();
      ctx.restore();
    });
    // 결승선
    if (rec.finishY > y0 - 40 && rec.finishY < y1) {
      const cell = rec.W / 30;
      for (let k = 0; k < 30; k++) for (let j = 0; j < 2; j++) {
        ctx.fillStyle = (k + j) % 2 ? '#fff' : '#111827'; ctx.fillRect(k * cell, rec.finishY + j * cell, cell, cell);
      }
      ctx.font = `800 ${22 / S}px ${FONT}`; ctx.textAlign = 'center'; ctx.fillStyle = '#facc15';
      ctx.fillText('FINISH', rec.W / 2, rec.finishY - 14 / S);
    }

    // 구슬 꼬리(궤적): 움직임이 눈에 보이도록 지난 위치를 이어 그린다
    ctx.lineCap = 'round';
    for (let i = 0; i < n; i++) {
      if (py[i] < y0 - 60 || py[i] > y1 + 60) continue;
      let lx = px[i], ly = py[i];
      for (let k = 1; k <= 7; k++) {
        const pf = Math.max(0, f - k * 0.45);
        const nx = at(xs[i], pf), ny = at(ys[i], pf);
        ctx.strokeStyle = colorOf(i, n); ctx.globalAlpha = 0.5 * (1 - k / 8);
        ctx.lineWidth = r * 1.5 * (1 - k / 9);
        ctx.beginPath(); ctx.moveTo(lx, ly); ctx.lineTo(nx, ny); ctx.stroke();
        lx = nx; ly = ny;
      }
    }
    ctx.globalAlpha = 1;

    // 구슬 (아래쪽 구슬이 위로 오도록 y 오름차순)
    const idxs = Array.from({ length: n }, (_, i) => i).sort((a, b) => py[a] - py[b]);
    for (const i of idxs) {
      if (py[i] < y0 - 40 || py[i] > y1 + 40) continue;
      const c = colorOf(i, n);
      const g = ctx.createRadialGradient(px[i] - r * 0.4, py[i] - r * 0.4, 1, px[i], py[i], r * 1.05);
      g.addColorStop(0, '#ffffff'); g.addColorStop(0.35, c); g.addColorStop(1, 'rgba(0,0,0,.55)');
      ctx.beginPath(); ctx.arc(px[i], py[i], r, 0, TAU); ctx.fillStyle = g; ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(255,255,255,.85)'; ctx.stroke();
    }
    // 이름표: 구슬이 적으면 전부, 많으면 상위 8명만
    const showAll = n <= 16;
    const top8 = new Set(order.slice(0, 8));
    ctx.font = `700 ${13 / S}px ${FONT}`; ctx.textAlign = 'center'; ctx.lineJoin = 'round';
    for (const i of idxs) {
      if (py[i] < y0 || py[i] > y1) continue;
      if (!showAll && !top8.has(i)) continue;
      const tx2 = clamp(px[i], 36 / S, rec.W - 36 / S), ty2 = py[i] - r - 5 / S;
      ctx.lineWidth = 3.2 / S; ctx.strokeStyle = 'rgba(8,10,24,.85)'; ctx.strokeText(label(i, 6), tx2, ty2);
      ctx.fillStyle = '#fff'; ctx.fillText(label(i, 6), tx2, ty2);
    }

    // ---- 화면 고정 HUD ----
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // 순위판
    const rows = Math.min(6, n), pw = 150, ph = 28 + rows * 22;
    ctx.fillStyle = 'rgba(8,10,24,.62)'; ctx.beginPath(); ctx.roundRect(8, 8, pw, ph, 10); ctx.fill();
    ctx.font = `700 12px ${FONT}`; ctx.textAlign = 'left'; ctx.fillStyle = '#facc15'; ctx.fillText('🏁 실시간 순위', 18, 26);
    order.slice(0, rows).forEach((i, k) => {
      const y = 46 + k * 22;
      ctx.beginPath(); ctx.arc(24, y - 4, 6, 0, TAU); ctx.fillStyle = colorOf(i, n); ctx.fill();
      ctx.fillStyle = finishFrame[i] <= f ? '#facc15' : '#fff'; ctx.font = `700 13px ${FONT}`;
      ctx.fillText(`${k + 1}  ${label(i, 6)}${finishFrame[i] <= f ? ' ✓' : ''}`, 36, y);
    });
    // 미니맵
    const mx = VIEW_W - 18, mt = 56, mh = VIEW_H - 112;
    ctx.fillStyle = 'rgba(8,10,24,.5)'; ctx.beginPath(); ctx.roundRect(mx - 10, mt - 10, 20, mh + 20, 8); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,.2)'; ctx.fillRect(mx - 1.5, mt, 3, mh);
    ctx.strokeStyle = 'rgba(250,204,21,.9)'; ctx.lineWidth = 1.5;
    ctx.strokeRect(mx - 8, mt + mh * (cam.y / rec.H), 16, mh * (vh / rec.H));
    ctx.fillStyle = '#facc15'; ctx.fillRect(mx - 8, mt + mh * (rec.finishY / rec.H) - 1, 16, 3);
    for (let i = 0; i < n; i++) { ctx.beginPath(); ctx.arc(mx, mt + mh * (py[i] / rec.H), 2.6, 0, TAU); ctx.fillStyle = colorOf(i, n); ctx.fill(); }

    // 중앙 문구 (카운트다운 / 결과)
    if (opts.overlay) {
      ctx.fillStyle = 'rgba(8,10,24,.35)'; ctx.fillRect(0, 0, VIEW_W, VIEW_H);
      ctx.textAlign = 'center'; ctx.lineJoin = 'round';
      ctx.font = `900 ${opts.overlay.size || 120}px ${FONT}`;
      ctx.lineWidth = 10; ctx.strokeStyle = 'rgba(8,10,24,.9)'; ctx.strokeText(opts.overlay.text, VIEW_W / 2, VIEW_H / 2);
      ctx.fillStyle = '#facc15'; ctx.fillText(opts.overlay.text, VIEW_W / 2, VIEW_H / 2);
      if (opts.overlay.sub) {
        ctx.font = `800 26px ${FONT}`; ctx.lineWidth = 6; ctx.strokeStyle = 'rgba(8,10,24,.9)';
        ctx.strokeText(opts.overlay.sub, VIEW_W / 2, VIEW_H / 2 + 52); ctx.fillStyle = '#fff'; ctx.fillText(opts.overlay.sub, VIEW_W / 2, VIEW_H / 2 + 52);
      }
    }
    return { order, py, px };
  }

  return { draw, finishFrame, orderIdx, at, wn, n, F };
}
