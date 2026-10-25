import { useEffect, useMemo, useRef, useState } from 'react';
import { sleep } from '../api.js';
import { pop, tick } from '../sfx.js';
import { decodeRecording } from '../verify.js';

const VW = 420, VH = 600;
const COLORS = ['#6366f1', '#f59e0b', '#10b981', '#ec4899', '#06b6d4', '#84cc16', '#f97316', '#8b5cf6', '#ef4444', '#14b8a6'];
const TAU = Math.PI * 2;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// 서버의 물리 엔진이 이미 끝까지 돌려서 저장해 둔 경기 기록(recording)을 재생한다.
// 화면은 승자를 정하지 않고, 기록에 담긴 구슬의 움직임을 그대로 보여줄 뿐이다.
export default function Marbles({ result, runKey, onDone, recording }) {
  const ref = useRef(null);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  const [banner, setBanner] = useState('');
  const [ranks, setRanks] = useState([]);
  const decoded = useMemo(() => (recording ? decodeRecording(recording) : null), [recording]);

  useEffect(() => {
    if (!recording || !decoded) return undefined;
    const ctx = ref.current.getContext('2d');
    const cancel = { v: false };
    const rec = recording;
    const { xs, ys, bars } = decoded;
    const n = rec.n, F = rec.frames, r = rec.r, wn = rec.winnerCount;
    const names = result.participants.map((p) => p.nickname);
    const s = VW / rec.W;
    const viewH = VH / s;
    const orderIdx = new Array(n);
    rec.order.forEach((m, k) => { orderIdx[m] = k; });
    const finishFrame = ys.map((a) => { const f = a.findIndex((y) => y >= rec.finishY); return f < 0 ? Infinity : f; });
    let camY = 0;
    let camInit = false;

    const at = (arr, f) => {
      const f0 = Math.min(F - 1, Math.floor(f)), f1 = Math.min(F - 1, f0 + 1), t = f - f0;
      return arr[f0] + (arr[f1] - arr[f0]) * t;
    };

    const rankList = (f, py) => {
      const done = [], rest = [];
      for (let i = 0; i < n; i++) (finishFrame[i] <= f ? done : rest).push(i);
      done.sort((a, b) => orderIdx[a] - orderIdx[b]);
      rest.sort((a, b) => py[b] - py[a]);
      return done.concat(rest);
    };

    const draw = (f) => {
      const px = new Array(n), py = new Array(n);
      let lead = 0;
      for (let i = 0; i < n; i++) { px[i] = at(xs[i], f); py[i] = at(ys[i], f); if (py[i] > lead) lead = py[i]; }
      const target = clamp(lead - viewH * 0.42, 0, rec.H - viewH);
      if (!camInit) { camY = clamp(target, 0, rec.H - viewH); camInit = true; } else camY += (target - camY) * 0.08;

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const bg = ctx.createLinearGradient(0, 0, 0, VH);
      bg.addColorStop(0, '#0b1020'); bg.addColorStop(1, '#1b1f3b');
      ctx.fillStyle = bg; ctx.fillRect(0, 0, VW, VH);

      ctx.setTransform(s, 0, 0, s, 0, -camY * s);
      const y0 = camY - 60, y1 = camY + viewH + 60;
      // 벽/경사
      ctx.fillStyle = '#334155';
      for (const [cx, cy, w, h, a] of rec.shapes.rects) {
        if (cy + Math.max(w, h) < y0 || cy - Math.max(w, h) > y1) continue;
        ctx.save(); ctx.translate(cx, cy); ctx.rotate(a); ctx.fillRect(-w / 2, -h / 2, w, h); ctx.restore();
      }
      // 핀/범퍼
      ctx.fillStyle = '#94a3b8';
      for (const [cx, cy, cr] of rec.shapes.circles) {
        if (cy < y0 || cy > y1) continue;
        ctx.beginPath(); ctx.arc(cx, cy, cr, 0, TAU); ctx.fill();
      }
      // 회전 막대
      ctx.fillStyle = '#f59e0b';
      rec.shapes.bars.forEach(([cx, cy, w, h], k) => {
        if (cy < y0 - 150 || cy > y1 + 150) return;
        ctx.save(); ctx.translate(cx, cy); ctx.rotate(at(bars[k], f)); ctx.fillRect(-w / 2, -h / 2, w, h);
        ctx.beginPath(); ctx.arc(0, 0, 9, 0, TAU); ctx.fillStyle = '#fde68a'; ctx.fill(); ctx.restore();
        ctx.fillStyle = '#f59e0b';
      });
      // 결승선
      if (rec.finishY > y0 && rec.finishY < y1) {
        const cell = rec.W / 24;
        for (let k = 0; k < 24; k++) for (let j = 0; j < 2; j++) {
          ctx.fillStyle = (k + j) % 2 ? '#fff' : '#111827';
          ctx.fillRect(k * cell, rec.finishY + j * cell, cell, cell);
        }
      }
      // 구슬 (아래쪽이 위로 보이게 y 오름차순으로 그림)
      const idxs = Array.from({ length: n }, (_, i) => i).sort((a, b) => py[a] - py[b]);
      for (const i of idxs) {
        if (py[i] < y0 || py[i] > y1) continue;
        const g = ctx.createRadialGradient(px[i] - r * 0.35, py[i] - r * 0.35, 1, px[i], py[i], r);
        g.addColorStop(0, '#fff'); g.addColorStop(0.3, COLORS[i % COLORS.length]); g.addColorStop(1, '#0006');
        ctx.beginPath(); ctx.arc(px[i], py[i], r, 0, TAU); ctx.fillStyle = g; ctx.fill();
        ctx.lineWidth = 1.5; ctx.strokeStyle = COLORS[i % COLORS.length]; ctx.stroke();
        if (r >= 8) {
          ctx.fillStyle = '#fff'; ctx.font = `700 ${Math.round(r)}px Pretendard, sans-serif`; ctx.textAlign = 'center';
          ctx.fillText([...names[i]][0] || '?', px[i], py[i] + r * 0.35);
        }
      }
      // 상위 3명 이름표
      const order = rankList(f, py);
      ctx.font = '700 15px Pretendard, sans-serif'; ctx.textAlign = 'center';
      order.slice(0, 3).forEach((i, k) => {
        if (py[i] < y0 || py[i] > y1) return;
        ctx.fillStyle = k === 0 ? '#facc15' : '#e2e8f0';
        ctx.fillText(`${k + 1}  ${names[i]}`, clamp(px[i], 50, rec.W - 50), py[i] - r - 8);
      });

      // 미니맵 (화면 고정)
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const mx = VW - 12, mt = 20, mh = VH - 40;
      ctx.fillStyle = 'rgba(255,255,255,.15)'; ctx.fillRect(mx - 2, mt, 4, mh);
      ctx.fillStyle = '#facc15'; ctx.fillRect(mx - 6, mt + mh * (rec.finishY / rec.H) - 1, 12, 3);
      for (let i = 0; i < n; i++) {
        ctx.beginPath(); ctx.arc(mx, mt + mh * (py[i] / rec.H), 3, 0, TAU); ctx.fillStyle = COLORS[i % COLORS.length]; ctx.fill();
      }
      return { py, order };
    };

    (async () => {
      draw(0);
      for (const c of ['3', '2', '1', '출발!']) {
        if (cancel.v) return;
        setBanner(c); tick();
        await sleep(c === '출발!' ? 500 : 800);
      }
      setBanner('');
      let f = 0, last = performance.now(), frameNo = 0;
      const announced = new Set();
      await new Promise((resolve) => {
        const frame = (now) => {
          if (cancel.v) return resolve();
          const dt = Math.min(0.1, (now - last) / 1000);
          last = now;
          // 결승 직전에는 슬로모션
          let leadY = 0;
          for (let i = 0; i < n; i++) leadY = Math.max(leadY, at(ys[i], f));
          let doneCnt = 0;
          for (let i = 0; i < n; i++) if (finishFrame[i] <= f) doneCnt++;
          const speed = doneCnt < wn && leadY > rec.finishY - 380 ? 0.45 : 1;
          f = Math.min(F - 1, f + dt * rec.fps * speed);
          const { order } = draw(f);
          for (let k = 0; k < wn; k++) {
            const m = rec.order[k];
            if (!announced.has(m) && finishFrame[m] <= f) {
              announced.add(m); pop();
              setBanner('🏁 ' + rec.order.slice(0, wn).filter((x) => announced.has(x)).map((x) => `${orderIdx[x] + 1}등 ${names[x]}`).join(' · '));
            }
          }
          if (frameNo++ % 8 === 0) setRanks(order.slice(0, 5).map((i) => ({ i, name: names[i], fin: finishFrame[i] <= f })));
          if (f >= F - 1) return resolve();
          requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      });
      if (cancel.v) return;
      setBanner('🏁 ' + rec.order.slice(0, wn).map((x, k) => `${k + 1}등 ${names[x]}`).join(' · '));
      await sleep(1000);
      if (!cancel.v && doneRef.current) doneRef.current();
    })();

    return () => { cancel.v = true; };
  }, [recording, decoded, result, runKey]);

  return (
    <>
      <div className="stage"><canvas ref={ref} width={VW} height={VH} className="race" /></div>
      <div className="winner-banner">{banner}</div>
      {ranks.length > 0 && (
        <div className="rank-list">
          {ranks.map((x, k) => (
            <span key={x.i} className={'rank-chip' + (x.fin ? ' fin' : '')} style={{ borderColor: COLORS[x.i % COLORS.length] }}>
              {k + 1}위 {x.name}
            </span>
          ))}
        </div>
      )}
    </>
  );
}
