require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const race = require('./race');

const { MONGODB_URI, MONGODB_ATLAS_URL, JWT_SECRET } = process.env;
const ADMIN_EMAIL = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const PORT = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === 'production';

if ((!MONGODB_URI && !MONGODB_ATLAS_URL) || !JWT_SECRET) {
  console.error('MONGODB_URI(또는 MONGODB_ATLAS_URL) 와 JWT_SECRET 환경변수가 필요해요. .env 파일을 확인해줘.');
  process.exit(1);
}

/* ---------- 추첨 알고리즘 (공개 · 재현 가능) ---------- */
const ALGO = 'hmac-sha256-fisher-yates-v1';
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// seed 와 카운터로부터 [0, n) 범위의 균등 난수를 만든다. (편향 제거를 위해 rejection sampling)
function makeRng(seed) {
  let counter = 0;
  return (n) => {
    const limit = 2 ** 32 - (2 ** 32 % n);
    for (;;) {
      const block = crypto.createHmac('sha256', seed).update(String(counter++)).digest();
      for (let i = 0; i + 4 <= block.length; i += 4) {
        const v = block.readUInt32BE(i);
        if (v < limit) return v % n;
      }
    }
  };
}
// 정렬된 참가자 id 배열을 Fisher-Yates 로 섞어 앞에서부터 winnerCount 명을 당첨자로 한다.
function pickWinners(sortedIds, winnerCount, seed) {
  const rng = makeRng(seed);
  const a = [...sortedIds];
  for (let i = a.length - 1; i > 0; i--) {
    const j = rng(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, winnerCount);
}
const hashParticipants = (sortedIds) => sha256(sortedIds.join(','));

/* ---------- 모델 ---------- */
const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  nickname: { type: String, required: true, trim: true, maxlength: 20 },
  passwordHash: { type: String, required: true },
  user_type: { type: String, enum: ['user', 'admin'], default: 'user', required: true },
  createdAt: { type: Date, default: Date.now },
});
const User = mongoose.model('User', userSchema);

const drawSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true, maxlength: 60 },
  description: { type: String, trim: true, maxlength: 300, default: '' },
  style: { type: String, enum: ['wheel', 'cards', 'marbles', 'ladder'], default: 'wheel' },
  winnerCount: { type: Number, required: true, min: 1, max: 100 },
  drawAt: { type: Date, required: true }, // 추첨 예정 일시 (안내용, 실행은 관리자가 직접)
  status: { type: String, enum: ['open', 'closed', 'drawing', 'drawn'], default: 'open' },
  participants: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  createdAt: { type: Date, default: Date.now },
  closedAt: Date,
  // 마감 시 확정. seed 는 추첨 전까지 비공개, commitment(= sha256(seed)) 만 공개.
  seed: { type: String, select: false },
  commitment: String,
  participantsHash: String,
});
const Draw = mongoose.model('Draw', drawSchema);

// 추첨 결과: 한 번 저장되면 수정/삭제 불가. 각 결과는 직전 결과의 해시를 포함(해시 체인).
const snapshot = { id: { type: String, required: true }, nickname: { type: String, required: true }, _id: false };
const resultSchema = new mongoose.Schema({
  seq: { type: Number, required: true, unique: true, immutable: true },
  draw: { type: mongoose.Schema.Types.ObjectId, ref: 'Draw', required: true, unique: true, immutable: true },
  title: { type: String, required: true, immutable: true },
  participants: { type: [snapshot], immutable: true },
  participantsHash: { type: String, required: true, immutable: true },
  commitment: { type: String, required: true, immutable: true },
  seed: { type: String, required: true, immutable: true },
  algo: { type: String, required: true, immutable: true },
  winnerCount: { type: Number, required: true, immutable: true },
  winners: { type: [snapshot], immutable: true },
  drawnAt: { type: String, required: true, immutable: true }, // ISO 문자열 (해시 재계산 시 형식 고정)
  prevHash: { type: String, required: true, immutable: true },
  // 물리 시뮬레이션(구슬 레이스) 결과에만 있다: 엔진/트랙 버전과 녹화의 해시
  engine: { type: String, immutable: true },
  recordingHash: { type: String, immutable: true },
  hash: { type: String, required: true, immutable: true },
});
const LOCKED = '추첨 결과는 수정하거나 삭제할 수 없어요';
resultSchema.pre('save', function () { if (!this.isNew) throw new Error(LOCKED); });
for (const op of ['updateOne', 'updateMany', 'findOneAndUpdate', 'findOneAndReplace', 'replaceOne', 'deleteMany', 'findOneAndDelete']) {
  resultSchema.pre(op, function () { throw new Error(LOCKED); });
}
resultSchema.pre('deleteOne', { document: true, query: true }, function () { throw new Error(LOCKED); });
const DrawResult = mongoose.model('DrawResult', resultSchema);

// 구슬 레이스 녹화(모든 구슬의 움직임). 결과와 마찬가지로 저장 후 수정/삭제할 수 없다.
const recordingSchema = new mongoose.Schema({
  draw: { type: mongoose.Schema.Types.ObjectId, ref: 'Draw', required: true, unique: true, immutable: true },
  raw: { type: String, required: true, immutable: true },
  hash: { type: String, required: true, immutable: true },
});
recordingSchema.pre('save', function () { if (!this.isNew) throw new Error(LOCKED); });
for (const op of ['updateOne', 'updateMany', 'findOneAndUpdate', 'findOneAndReplace', 'replaceOne', 'deleteMany', 'findOneAndDelete']) {
  recordingSchema.pre(op, function () { throw new Error(LOCKED); });
}
recordingSchema.pre('deleteOne', { document: true, query: true }, function () { throw new Error(LOCKED); });
const RaceRecording = mongoose.model('RaceRecording', recordingSchema);

const GENESIS = '0'.repeat(64);
// 해시 대상 필드와 순서를 고정한다.
const payloadOf = (r) => ({
  seq: r.seq,
  drawId: String(r.draw || r.drawId),
  title: r.title,
  participants: r.participants.map((p) => ({ id: p.id, nickname: p.nickname })),
  participantsHash: r.participantsHash,
  commitment: r.commitment,
  seed: r.seed,
  algo: r.algo,
  winnerCount: r.winnerCount,
  winners: r.winners.map((p) => ({ id: p.id, nickname: p.nickname })),
  drawnAt: r.drawnAt,
  prevHash: r.prevHash,
  // 기존 결과의 해시가 바뀌지 않도록, 물리 결과에만 필드를 덧붙인다
  ...(r.recordingHash ? { engine: r.engine, recordingHash: r.recordingHash } : {}),
});
const hashResult = (r) => sha256(JSON.stringify(payloadOf(r)));

/* ---------- 유틸 ---------- */
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const isAdminEmail = (email) => !!ADMIN_EMAIL && String(email).toLowerCase() === ADMIN_EMAIL;
const pub = (u) => ({ id: String(u._id), nickname: u.nickname, email: u.email, user_type: u.user_type, isAdmin: u.user_type === 'admin' });
// ADMIN_EMAIL 로 가입/로그인한 계정은 admin 으로 승격 (그 외는 기본 user)
async function syncUserType(user) {
  if (isAdminEmail(user.email) && user.user_type !== 'admin') {
    user.user_type = 'admin';
    await user.save();
  }
}
const isId = (v) => typeof v === 'string' && mongoose.isValidObjectId(v);
const fail = (res, code, error) => res.status(code).json({ error });

function setAuthCookie(res, user) {
  const token = jwt.sign({ uid: String(user._id) }, JWT_SECRET, { expiresIn: '30d' });
  res.cookie('token', token, { httpOnly: true, sameSite: 'lax', secure: isProd, maxAge: 30 * 24 * 60 * 60 * 1000 });
}
async function auth(req, res, next) {
  try {
    const p = jwt.verify(req.cookies.token || '', JWT_SECRET);
    const user = await User.findById(p.uid);
    if (user) { req.user = user; req.isAdmin = user.user_type === 'admin'; return next(); }
  } catch (e) {
    if (e.name !== 'JsonWebTokenError' && e.name !== 'TokenExpiredError' && e.name !== 'NotBeforeError') return next(e);
  }
  fail(res, 401, '로그인이 필요해요');
}
const adminOnly = (req, res, next) => (req.isAdmin ? next() : fail(res, 403, '관리자만 할 수 있어요'));

/* ---------- 앱 ---------- */
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '20kb' }));
app.use(cookieParser());
// 배포: client 를 빌드(npm run build)하면 client/dist 를 서버가 함께 서빙. 개발 중에는 vite(5173)가 /api 를 프록시한다.
app.use(express.static(path.join(__dirname, '..', 'client', 'dist')));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 50, standardHeaders: true, legacyHeaders: false,
  message: { error: '시도가 너무 많아요. 잠시 후 다시 해줘' },
});

/* --- 인증 --- */
app.post('/api/signup', authLimiter, wrap(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const nickname = String(req.body.nickname || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail(res, 400, '이메일 형식이 올바르지 않아요');
  if (password.length < 8) return fail(res, 400, '비밀번호는 8자 이상이어야 해요');
  if (!nickname || nickname.length > 20) return fail(res, 400, '닉네임은 1~20자로 입력해줘');
  if (await User.exists({ email })) return fail(res, 409, '이미 가입된 이메일이에요');
  const user = await User.create({
    email, nickname, passwordHash: await bcrypt.hash(password, 10),
    user_type: isAdminEmail(email) ? 'admin' : 'user',
  });
  setAuthCookie(res, user);
  res.json({ user: pub(user) });
}));

app.post('/api/login', authLimiter, wrap(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const user = await User.findOne({ email });
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) return fail(res, 401, '이메일 또는 비밀번호가 맞지 않아요');
  await syncUserType(user);
  setAuthCookie(res, user);
  res.json({ user: pub(user) });
}));

app.post('/api/logout', (req, res) => { res.clearCookie('token'); res.json({ ok: true }); });
app.get('/api/me', auth, (req, res) => res.json({ user: pub(req.user) }));

/* --- 추첨 --- */
const resultOut = (r) => ({
  seq: r.seq, title: r.title,
  participants: r.participants.map((p) => ({ id: p.id, nickname: p.nickname })),
  participantsHash: r.participantsHash, commitment: r.commitment, seed: r.seed, algo: r.algo,
  winnerCount: r.winnerCount,
  winners: r.winners.map((p) => ({ id: p.id, nickname: p.nickname })),
  drawnAt: r.drawnAt, prevHash: r.prevHash, hash: r.hash,
  engine: r.engine || null, recordingHash: r.recordingHash || null,
});

async function drawOut(d, req) {
  const uid = String(req.user._id);
  const joined = d.participants.some((p) => String(p._id || p) === uid);
  const canSee = joined || req.isAdmin;
  const out = {
    id: String(d._id), title: d.title, description: d.description, style: d.style,
    winnerCount: d.winnerCount, drawAt: d.drawAt, status: d.status, createdAt: d.createdAt, closedAt: d.closedAt,
    participantCount: d.participants.length, joined,
    commitment: d.commitment || null, participantsHash: d.participantsHash || null,
  };
  if (canSee) {
    const users = await User.find({ _id: { $in: d.participants } }, 'nickname');
    out.participants = users.map((u) => ({ id: String(u._id), nickname: u.nickname }));
    if (d.status === 'drawn') {
      const r = await DrawResult.findOne({ draw: d._id });
      out.result = r ? resultOut(r) : null;
    }
  }
  return out;
}

app.get('/api/draws', auth, wrap(async (req, res) => {
  const list = await Draw.find().sort({ createdAt: -1 }).limit(100);
  const uid = String(req.user._id);
  res.json({
    draws: list.map((d) => ({
      id: String(d._id), title: d.title, style: d.style, status: d.status, winnerCount: d.winnerCount, drawAt: d.drawAt,
      participantCount: d.participants.length, joined: d.participants.some((p) => String(p) === uid), createdAt: d.createdAt,
    })),
  });
}));

app.post('/api/draws', auth, adminOnly, wrap(async (req, res) => {
  const b = req.body || {};
  const title = String(b.title || '').trim();
  const description = String(b.description || '').trim();
  const winnerCount = Number(b.winnerCount);
  const style = ['wheel', 'cards', 'marbles', 'ladder'].includes(b.style) ? b.style : 'wheel';
  const drawAt = new Date(b.drawAt);
  if (!b.drawAt || isNaN(drawAt.getTime())) return fail(res, 400, '추첨 날짜와 시간을 입력해줘');
  if (!title || title.length > 60) return fail(res, 400, '추첨 이름을 1~60자로 입력해줘');
  if (description.length > 300) return fail(res, 400, '설명은 300자까지 입력할 수 있어요');
  if (!Number.isInteger(winnerCount) || winnerCount < 1 || winnerCount > 100) return fail(res, 400, '당첨 인원은 1~100명으로 정해줘');
  const d = await Draw.create({ title, description, winnerCount, style, drawAt, createdBy: req.user._id });
  res.json({ draw: await drawOut(d, req) });
}));

app.get('/api/draws/:id', auth, wrap(async (req, res) => {
  if (!isId(req.params.id)) return fail(res, 400, '잘못된 요청이에요');
  const d = await Draw.findById(req.params.id);
  if (!d) return fail(res, 404, '추첨을 찾을 수 없어요');
  res.json({ draw: await drawOut(d, req) });
}));

// 실시간 알림 (SSE): 추첨 화면을 열어둔 사람에게 참여/마감/추첨 신호를 보낸다. 신호에는 데이터가 없고,
// 받은 쪽이 권한 검사를 거친 API 로 다시 조회하므로 정보가 새지 않는다.
const watchers = new Map(); // drawId -> Set<res>
function broadcast(drawId, type) {
  const set = watchers.get(String(drawId));
  if (set) for (const r of set) r.write(`event: ${type}\ndata: {}\n\n`);
}
app.get('/api/draws/:id/events', auth, (req, res) => {
  if (!isId(req.params.id)) return fail(res, 400, '잘못된 요청이에요');
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  const key = req.params.id;
  if (!watchers.has(key)) watchers.set(key, new Set());
  watchers.get(key).add(res);
  const beat = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(beat);
    const set = watchers.get(key);
    if (set) { set.delete(res); if (!set.size) watchers.delete(key); }
  });
});

app.post('/api/draws/:id/join', auth, wrap(async (req, res) => {
  if (!isId(req.params.id)) return fail(res, 400, '잘못된 요청이에요');
  const r = await Draw.updateOne({ _id: req.params.id, status: 'open' }, { $addToSet: { participants: req.user._id } });
  if (!r.matchedCount) return fail(res, 409, '참여를 받는 중인 추첨이 아니에요');
  broadcast(req.params.id, 'update');
  res.json({ ok: true });
}));

app.post('/api/draws/:id/leave', auth, wrap(async (req, res) => {
  if (!isId(req.params.id)) return fail(res, 400, '잘못된 요청이에요');
  const r = await Draw.updateOne({ _id: req.params.id, status: 'open' }, { $pull: { participants: req.user._id } });
  if (!r.matchedCount) return fail(res, 409, '마감된 추첨은 참여를 취소할 수 없어요');
  broadcast(req.params.id, 'update');
  res.json({ ok: true });
}));

// 마감: 참가자 확정 + 난수 seed 확정 후 commitment(seed 의 해시) 공개
app.post('/api/draws/:id/close', auth, adminOnly, wrap(async (req, res) => {
  if (!isId(req.params.id)) return fail(res, 400, '잘못된 요청이에요');
  const cur = await Draw.findById(req.params.id);
  if (!cur) return fail(res, 404, '추첨을 찾을 수 없어요');
  if (cur.status !== 'open') return fail(res, 409, '이미 마감된 추첨이에요');
  if (cur.participants.length < cur.winnerCount) return fail(res, 400, `참여자가 당첨 인원(${cur.winnerCount}명)보다 적어요`);
  // 먼저 상태를 바꿔 더 이상 참여/취소가 되지 않게 잠근 뒤 참가자를 확정한다
  const d = await Draw.findOneAndUpdate({ _id: cur._id, status: 'open' }, { $set: { status: 'closed', closedAt: new Date() } }, { new: true });
  if (!d) return fail(res, 409, '이미 마감된 추첨이에요');
  if (d.participants.length < d.winnerCount) {
    await Draw.updateOne({ _id: d._id }, { $set: { status: 'open' }, $unset: { closedAt: '' } });
    return fail(res, 400, `참여자가 당첨 인원(${d.winnerCount}명)보다 적어요`);
  }
  const seed = crypto.randomBytes(32).toString('hex');
  const ids = d.participants.map(String).sort();
  await Draw.updateOne({ _id: d._id }, { $set: { seed, commitment: sha256(seed), participantsHash: hashParticipants(ids) } });
  broadcast(d._id, 'update');
  res.json({ draw: await drawOut(await Draw.findById(d._id), req) });
}));

// 추첨 실행: 서버가 확정한 seed 로 당첨자를 정하고, 결과를 해시 체인에 잠가서 저장
app.post('/api/draws/:id/run', auth, adminOnly, wrap(async (req, res) => {
  if (!isId(req.params.id)) return fail(res, 400, '잘못된 요청이에요');
  const d = await Draw.findOneAndUpdate(
    { _id: req.params.id, status: 'closed', commitment: { $exists: true } },
    { $set: { status: 'drawing' } },
    { new: true }
  ).select('+seed');
  if (!d) return fail(res, 409, '마감된 추첨만 실행할 수 있어요 (이미 실행됐을 수도 있어요)');

  try {
    const ids = d.participants.map(String).sort();
    const users = await User.find({ _id: { $in: ids } }, 'nickname');
    const nick = new Map(users.map((u) => [String(u._id), u.nickname]));
    const snap = (id) => ({ id, nickname: nick.get(id) || '(탈퇴)' });

    // 구슬 레이스는 물리 엔진이 승자를 정한다. 그 외 연출은 seed 로 섞어서 뽑는다.
    const isRace = d.style === 'marbles';
    let winnerIds;
    let physics = {};
    if (isRace) {
      const sim = race.simulate({ seed: d.seed, n: ids.length, winnerCount: d.winnerCount });
      winnerIds = sim.order.slice(0, d.winnerCount).map((i) => ids[i]);
      const hash = sha256(sim.raw);
      const ex = await RaceRecording.findOne({ draw: d._id });
      if (!ex) await RaceRecording.create({ draw: d._id, raw: sim.raw, hash });
      else if (ex.hash !== hash) throw new Error('이전 시도의 녹화와 달라요');
      physics = { engine: race.ENGINE, recordingHash: hash };
    } else {
      winnerIds = pickWinners(ids, d.winnerCount, d.seed);
    }

    let saved = null;
    for (let attempt = 0; attempt < 5 && !saved; attempt++) {
      const last = await DrawResult.findOne().sort({ seq: -1 });
      const rec = {
        seq: (last ? last.seq : 0) + 1,
        draw: d._id,
        title: d.title,
        participants: ids.map(snap),
        participantsHash: d.participantsHash,
        commitment: d.commitment,
        seed: d.seed,
        algo: isRace ? race.ALGO : ALGO,
        winnerCount: d.winnerCount,
        winners: winnerIds.map(snap),
        drawnAt: new Date().toISOString(),
        prevHash: last ? last.hash : GENESIS,
        ...physics,
      };
      rec.hash = hashResult(rec);
      try {
        saved = await DrawResult.create(rec);
      } catch (e) {
        if (!(e.code === 11000 && e.keyPattern && e.keyPattern.seq)) throw e; // seq 충돌만 재시도
      }
    }
    if (!saved) throw new Error('결과 저장 실패');
    await Draw.updateOne({ _id: d._id }, { $set: { status: 'drawn' } });
    broadcast(d._id, 'drawn'); // 화면을 열어둔 모든 참여자가 동시에 연출을 시작한다
    res.json({ draw: await drawOut(await Draw.findById(d._id), req) });
  } catch (e) {
    await Draw.updateOne({ _id: d._id, status: 'drawing' }, { $set: { status: 'closed' } });
    throw e;
  }
}));

// 검증: 누구나 같은 결과를 다시 계산해서 확인할 수 있다 (참여자/관리자만 호출 가능)
function verifyResult(r, prev) {
  const ids = r.participants.map((p) => p.id);
  const sorted = [...ids].sort();
  const redo = pickWinners(sorted, r.winnerCount, r.seed);
  return [
    ['seed 가 마감 때 공개한 commitment 와 일치', sha256(r.seed) === r.commitment],
    ['참가자 목록이 마감 때 확정한 해시와 일치', hashParticipants(sorted) === r.participantsHash && JSON.stringify(ids) === JSON.stringify(sorted)],
    ['공개된 알고리즘으로 다시 계산한 당첨자가 저장된 결과와 일치', JSON.stringify(redo) === JSON.stringify(r.winners.map((w) => w.id))],
    ['결과 해시가 내용과 일치 (변조 없음)', hashResult(r) === r.hash],
    ['직전 결과와 해시 체인이 이어짐', r.prevHash === (prev ? prev.hash : GENESIS)],
  ].map(([label, ok]) => ({ label, ok }));
}

// 물리 결과 검증: 같은 seed 로 시뮬레이션을 처음부터 다시 돌려 녹화가 한 글자도 다르지 않은지 확인한다
async function verifyRaceResult(r, prev) {
  const ids = r.participants.map((p) => p.id);
  const sorted = [...ids].sort();
  const rec = await RaceRecording.findOne({ draw: r.draw });
  const raw = rec ? rec.raw : '';
  let winnersMatch = false;
  let resimSame = false;
  if (rec) {
    try {
      const order = JSON.parse(raw).order;
      winnersMatch = JSON.stringify(order.slice(0, r.winnerCount).map((i) => sorted[i])) === JSON.stringify(r.winners.map((w) => w.id));
    } catch { /* 녹화가 깨져 있으면 불일치 */ }
    resimSame = race.simulate({ seed: r.seed, n: sorted.length, winnerCount: r.winnerCount }).raw === raw;
  }
  return [
    ['seed 가 마감 때 공개한 commitment 와 일치', sha256(r.seed) === r.commitment],
    ['참가자 목록이 마감 때 확정한 해시와 일치', hashParticipants(sorted) === r.participantsHash && JSON.stringify(ids) === JSON.stringify(sorted)],
    ['저장된 녹화의 해시가 결과에 기록된 값과 일치', !!rec && sha256(raw) === r.recordingHash && rec.hash === r.recordingHash],
    ['당첨자가 녹화에 담긴 결승선 도착 순서와 일치', winnersMatch],
    ['같은 seed 로 물리 시뮬레이션을 다시 돌려도 똑같은 녹화가 나옴', resimSame],
    ['결과 해시가 내용과 일치 (변조 없음)', hashResult(r) === r.hash],
    ['직전 결과와 해시 체인이 이어짐', r.prevHash === (prev ? prev.hash : GENESIS)],
  ].map(([label, ok]) => ({ label, ok }));
}

// 구슬 레이스 녹화 (참여자/관리자만)
app.get('/api/draws/:id/recording', auth, wrap(async (req, res) => {
  if (!isId(req.params.id)) return fail(res, 400, '잘못된 요청이에요');
  const d = await Draw.findById(req.params.id);
  if (!d) return fail(res, 404, '추첨을 찾을 수 없어요');
  const uid = String(req.user._id);
  if (!req.isAdmin && !d.participants.some((p) => String(p) === uid)) return fail(res, 403, '참여한 추첨만 조회할 수 있어요');
  const rec = await RaceRecording.findOne({ draw: d._id });
  if (!rec) return fail(res, 404, '녹화가 없어요');
  res.json({ raw: rec.raw, hash: rec.hash });
}));

app.get('/api/draws/:id/verify', auth, wrap(async (req, res) => {
  if (!isId(req.params.id)) return fail(res, 400, '잘못된 요청이에요');
  const d = await Draw.findById(req.params.id);
  if (!d) return fail(res, 404, '추첨을 찾을 수 없어요');
  const uid = String(req.user._id);
  if (!req.isAdmin && !d.participants.some((p) => String(p) === uid)) return fail(res, 403, '참여한 추첨만 조회할 수 있어요');
  const r = await DrawResult.findOne({ draw: d._id });
  if (!r) return fail(res, 404, '아직 추첨 결과가 없어요');
  const prev = r.seq > 1 ? await DrawResult.findOne({ seq: r.seq - 1 }) : null;
  const checks = r.algo === race.ALGO ? await verifyRaceResult(r, prev) : verifyResult(r, prev);
  res.json({ ok: checks.every((c) => c.ok), checks });
}));

// 전체 해시 체인 검증 (결과가 하나라도 바뀌면 깨짐)
async function chainStatus() {
  const all = await DrawResult.find().sort({ seq: 1 });
  let prevHash = GENESIS;
  let brokenAt = null;
  all.forEach((r, i) => {
    if (brokenAt == null && (r.prevHash !== prevHash || hashResult(r) !== r.hash || r.seq !== i + 1)) brokenAt = r.seq;
    prevHash = r.hash;
  });
  return { all, ok: brokenAt == null, count: all.length, brokenAt, head: prevHash };
}

app.get('/api/chain', auth, wrap(async (req, res) => {
  const { ok, count, brokenAt, head } = await chainStatus();
  res.json({ ok, count, brokenAt, head });
}));

// 체인 시각화/브라우저 검증용: 각 결과의 해시 정보만 (참가자·seed 같은 상세는 포함하지 않음)
app.get('/api/results', auth, wrap(async (req, res) => {
  const c = await chainStatus();
  res.json({
    ok: c.ok, brokenAt: c.brokenAt,
    results: c.all.map((r) => ({ seq: r.seq, drawId: String(r.draw), title: r.title, drawnAt: r.drawnAt, prevHash: r.prevHash, hash: r.hash })),
  });
}));

// 목록 화면 상단의 통계
app.get('/api/stats', auth, wrap(async (req, res) => {
  const [draws, drawn, c] = await Promise.all([Draw.countDocuments(), Draw.countDocuments({ status: 'drawn' }), chainStatus()]);
  res.json({ draws, drawn, results: c.count, chainOk: c.ok });
}));

/* --- 관리자: 현황 / 회원 관리 --- */
app.get('/api/admin/summary', auth, adminOnly, wrap(async (req, res) => {
  const [users, admins, draws, drawn, chain] = await Promise.all([
    User.countDocuments(), User.countDocuments({ user_type: 'admin' }),
    Draw.countDocuments(), Draw.countDocuments({ status: 'drawn' }), DrawResult.countDocuments(),
  ]);
  res.json({ users, admins, draws, drawn, results: chain });
}));

app.get('/api/admin/users', auth, adminOnly, wrap(async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 50);
  const esc = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const filter = q ? { $or: [{ email: new RegExp(esc, 'i') }, { nickname: new RegExp(esc, 'i') }] } : {};
  const list = await User.find(filter).sort({ createdAt: -1 }).limit(200);
  res.json({
    users: list.map((u) => ({
      id: String(u._id), email: u.email, nickname: u.nickname, user_type: u.user_type,
      createdAt: u.createdAt, locked: isAdminEmail(u.email), // ADMIN_EMAIL 계정은 강등 불가
    })),
  });
}));

app.patch('/api/admin/users/:id', auth, adminOnly, wrap(async (req, res) => {
  if (!isId(req.params.id)) return fail(res, 400, '잘못된 요청이에요');
  const type = req.body && req.body.user_type;
  if (type !== 'user' && type !== 'admin') return fail(res, 400, 'user_type 은 user 또는 admin 이어야 해요');
  const target = await User.findById(req.params.id);
  if (!target) return fail(res, 404, '회원을 찾을 수 없어요');
  if (type === 'user') {
    if (String(target._id) === String(req.user._id)) return fail(res, 400, '자기 자신은 일반 회원으로 바꿀 수 없어요');
    if (isAdminEmail(target.email)) return fail(res, 400, '기본 관리자 계정은 바꿀 수 없어요');
  }
  target.user_type = type;
  await target.save();
  res.json({ ok: true, user_type: type });
}));

/* ---------- 에러 처리 & 시작 ---------- */
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: '서버 오류가 발생했어요' });
});

// Atlas 를 먼저 시도하고, 실패하면 로컬(MONGODB_URI)로 연결
async function connectDb() {
  const targets = [['Atlas', MONGODB_ATLAS_URL], ['로컬', MONGODB_URI]].filter(([, uri]) => uri);
  for (const [name, uri] of targets) {
    try {
      await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
      console.log(`MongoDB 연결됨 (${name})`);
      return;
    } catch (e) {
      console.error(`MongoDB ${name} 연결 실패:`, e.message);
    }
  }
  process.exit(1);
}

connectDb().then(async () => {
  await Promise.all([User.init(), Draw.init(), DrawResult.init()]);
  app.listen(PORT, () => console.log(`서버 시작: http://localhost:${PORT}`));
});
