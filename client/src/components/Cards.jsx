import { useEffect, useRef, useState } from 'react';
import { sleep } from '../api.js';
import { pop } from '../sfx.js';

export default function Cards({ result, runKey, onDone }) {
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  const [open, setOpen] = useState(() => new Set());
  const [banner, setBanner] = useState('');
  const win = new Set(result.winners.map((w) => w.id));

  useEffect(() => {
    let cancelled = false;
    setOpen(new Set());
    setBanner('');
    (async () => {
      await sleep(700);
      const got = [];
      for (const w of result.winners) {
        if (cancelled) return;
        setOpen((s) => new Set(s).add(w.id));
        pop();
        got.push(w.nickname);
        setBanner('🎉 ' + got.join(', '));
        await sleep(900);
      }
      await sleep(400);
      if (cancelled) return;
      setOpen(new Set(result.participants.map((p) => p.id)));
      await sleep(700);
      if (!cancelled && doneRef.current) doneRef.current();
    })();
    return () => { cancelled = true; };
  }, [result, runKey]);

  return (
    <>
      <div className="stage">
        <div className="cards">
          {result.participants.map((p) => (
            <div key={p.id} className={'flip' + (win.has(p.id) ? ' win' : '') + (open.has(p.id) ? ' on' : '')}>
              <div className="flip-in">
                <div className="face front">?</div>
                <div className="face back">{p.nickname}{win.has(p.id) ? ' 🎉' : ''}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="winner-banner">{banner}</div>
    </>
  );
}
