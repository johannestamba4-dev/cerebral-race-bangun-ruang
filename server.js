/**
 * Cerebral Race – Bangun Ruang
 * Backend: Express + node:sqlite (built-in) + ws
 * - Single source of truth: SQLite
 * - Backend validation, atomic claim (transaksi BEGIN/COMMIT, sinkron single-thread)
 * - Server-authoritative 40-minute timer + auto-end
 * - Real-time sync via WebSocket broadcast per game
 */
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'guru123';
const DURATION_SEC = 40 * 60;

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'game.db');
const db = new DatabaseSync(DB_PATH);
db.exec(`PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS games (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'lobby',
  duration_sec INTEGER NOT NULL DEFAULT ${DURATION_SEC},
  starts_at INTEGER,
  ends_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  score INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS questions (
  id TEXT NOT NULL,
  game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  chart_no INTEGER NOT NULL,
  pos INTEGER NOT NULL,
  code TEXT NOT NULL,
  text TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'balok',
  dims TEXT NOT NULL DEFAULT '',
  answer_display TEXT NOT NULL,
  answer_value REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'available',
  claimed_by TEXT REFERENCES players(id),
  claimed_at INTEGER,
  PRIMARY KEY (game_id, id)
);
CREATE TABLE IF NOT EXISTS attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  player_id TEXT NOT NULL,
  player_name TEXT NOT NULL,
  question_id TEXT NOT NULL,
  answer_raw TEXT NOT NULL,
  correct INTEGER NOT NULL,
  result TEXT NOT NULL,
  created_at INTEGER NOT NULL
);`);

function tx(fn){
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch(e){ try{ db.exec('ROLLBACK'); }catch(_){} throw e; }
}

// ---------- Seed questions (50 soal, dari dokumen sumber – angka & kunci tidak diubah) ----------
const SEED = [
  { id:'1A', chart:1, pos:0, text:'Sebuah kubus memiliki panjang rusuk 4 cm. Berapakah volume kubus tersebut?', note:'', kind:'kubus', dims:'r = 4 cm', ans:'64 cm³', val:64 },
  { id:'1B', chart:1, pos:1, text:'Sebuah balok memiliki volume 720 cm³. Jika panjangnya 12 cm dan lebarnya 10 cm, berapakah tinggi balok tersebut?', note:'', kind:'balok', dims:'12 × 10 × t', ans:'6 cm', val:6 },
  { id:'1C', chart:1, pos:2, text:'Sebuah balok memiliki panjang 3 cm, lebar 4 cm, dan tinggi 12 cm. Berapakah panjang diagonal ruang balok tersebut?', note:'', kind:'balok', dims:'3 × 4 × 12', ans:'13 cm', val:13 },
  { id:'1D', chart:1, pos:3, text:'Sebuah bangun gabungan terdiri atas sebuah balok berukuran 12 cm × 8 cm × 6 cm dan sebuah kubus dengan panjang rusuk 4 cm. Kubus ditempelkan pada salah satu sisi balok tanpa saling tumpang tindih. Berapakah volume seluruh bangun gabungan tersebut?', note:'Ilustrasi skematis (tidak menurut skala).', kind:'gabungan', dims:'balok + kubus', ans:'640 cm³', val:640 },
  { id:'1E', chart:1, pos:4, text:'Sebuah bola besar berjari-jari 6 cm dilebur dan dibentuk kembali menjadi bola-bola kecil yang masing-masing berjari-jari 2 cm. Berapa banyak bola kecil yang dihasilkan?', note:'', kind:'bola', dims:'R=6 → r=2', ans:'27 bola', val:27 },
  { id:'2A', chart:2, pos:0, text:'Sebuah balok memiliki panjang 5 cm, lebar 4 cm, dan tinggi 3 cm. Berapakah volume balok tersebut?', note:'', kind:'balok', dims:'5 × 4 × 3', ans:'60 cm³', val:60 },
  { id:'2B', chart:2, pos:1, text:'Sebuah kubus memiliki volume 512 cm³. Berapakah panjang rusuk kubus tersebut?', note:'', kind:'kubus', dims:'V = 512', ans:'8 cm', val:8 },
  { id:'2C', chart:2, pos:2, text:'Sebuah prisma segitiga memiliki alas berbentuk segitiga siku-siku dengan panjang kedua sisi tegak 9 cm dan 12 cm. Jika tinggi prisma 10 cm, berapakah volume prisma tersebut?', note:'Ilustrasi skematis (tidak menurut skala).', kind:'prisma', dims:'alas 9-12, t=10', ans:'540 cm³', val:540 },
  { id:'2D', chart:2, pos:3, text:'Sebuah limas segi empat beraturan diletakkan tepat di atas sebuah kubus yang panjang rusuknya 8 cm. Alas limas berimpit dengan sisi atas kubus. Jika tinggi limas 6 cm, berapakah volume seluruh bangun gabungan tersebut?', note:'Ilustrasi skematis (tidak menurut skala).', kind:'gabungan', dims:'kubus + limas', ans:'640 cm³', val:640 },
  { id:'2E', chart:2, pos:4, text:'Sebuah tabung tertutup memiliki volume 250π cm³. Jika luas permukaan total tabung dibuat minimum, berapakah jari-jari tabung tersebut?', note:'Soal optimasi (kalkulus).', kind:'tabung', dims:'V = 250π', ans:'5 cm', val:5 },
  { id:'3A', chart:3, pos:0, text:'Sebuah tabung memiliki jari-jari 7 cm dan tinggi 5 cm. Berapakah volumenya? Gunakan π = 22/7.', note:'π = 22/7', kind:'tabung', dims:'r=7, t=5', ans:'770 cm³', val:770 },
  { id:'3B', chart:3, pos:1, text:'Sebuah tabung memiliki volume 1.540 cm³ dan jari-jari 7 cm. Berapakah tinggi tabung tersebut? Gunakan π = 22/7.', note:'π = 22/7', kind:'tabung', dims:'V=1540, r=7', ans:'10 cm', val:10 },
  { id:'3C', chart:3, pos:2, text:'Sebuah tabung tanpa tutup memiliki jari-jari 7 cm dan tinggi 10 cm. Berapakah luas minimum bahan yang diperlukan untuk membuat tabung tersebut, termasuk alasnya? Gunakan π = 22/7.', note:'π = 22/7', kind:'tabung', dims:'r=7, t=10', ans:'594 cm²', val:594 },
  { id:'3D', chart:3, pos:3, text:'Sebuah bangun ruang gabungan terdiri atas tabung dan kerucut yang disambungkan pada salah satu alas lingkarannya. Keduanya memiliki jari-jari 7 cm. Jika tinggi tabung 10 cm dan tinggi kerucut 12 cm, berapakah volume seluruh bangun tersebut? Gunakan π = 22/7.', note:'Ilustrasi skematis (tidak menurut skala). π = 22/7', kind:'gabungan', dims:'tabung + kerucut', ans:'2.156 cm³', val:2156 },
  { id:'3E', chart:3, pos:4, text:'Sebuah tabung tertutup memiliki jari-jari 7 cm dan tinggi 20 cm. Sebuah balok tertutup berukuran 14 cm × 11 cm × 20 cm. Berapakah selisih luas permukaan kedua bangun tersebut?', note:'Bandingkan luas permukaan.', kind:'gabungan', dims:'tabung vs balok', ans:'120 cm²', val:120 },
  { id:'4A', chart:4, pos:0, text:'Sebuah kerucut memiliki jari-jari alas 7 cm dan tinggi 6 cm. Berapakah volumenya? Gunakan π = 22/7.', note:'π = 22/7', kind:'kerucut', dims:'r=7, t=6', ans:'308 cm³', val:308 },
  { id:'4B', chart:4, pos:1, text:'Sebuah kerucut memiliki volume 616 cm³ dan jari-jari alas 7 cm. Berapakah tinggi kerucut tersebut? Gunakan π = 22/7.', note:'π = 22/7', kind:'kerucut', dims:'V=616, r=7', ans:'12 cm', val:12 },
  { id:'4C', chart:4, pos:2, text:'Sebuah akuarium berbentuk balok memiliki panjang 80 cm dan lebar 50 cm. Akuarium diisi air sebanyak 120 liter. Berapakah tinggi permukaan air di dalam akuarium?', note:'1 liter = 1.000 cm³', kind:'balok', dims:'80 × 50, V=120 L', ans:'30 cm', val:30 },
  { id:'4D', chart:4, pos:3, text:'Sebuah kubus dengan panjang rusuk 6 cm ditempelkan pada salah satu sisi balok berukuran 12 cm × 8 cm × 6 cm. Seluruh sisi persegi kubus yang menempel berimpit tepat dengan bidang berukuran 6 cm × 6 cm pada balok. Berapakah luas permukaan luar bangun gabungan tersebut?', note:'Ilustrasi skematis (tidak menurut skala).', kind:'gabungan', dims:'balok + kubus', ans:'576 cm²', val:576 },
  { id:'4E', chart:4, pos:4, text:'Sebuah bola besar berjari-jari 9 cm dilebur dan dibentuk kembali menjadi bola-bola kecil yang masing-masing berjari-jari 3 cm. Berapa banyak bola kecil yang dihasilkan?', note:'', kind:'bola', dims:'R=9 → r=3', ans:'27 bola', val:27 },
  { id:'5A', chart:5, pos:0, text:'Sebuah bola memiliki jari-jari 14 cm. Berapakah luas permukaan bola tersebut? Gunakan π = 22/7.', note:'π = 22/7', kind:'bola', dims:'r = 14', ans:'2.464 cm²', val:2464 },
  { id:'5B', chart:5, pos:1, text:'Luas permukaan sebuah bola adalah 616 cm². Berapakah panjang jari-jari bola tersebut? Gunakan π = 22/7.', note:'π = 22/7', kind:'bola', dims:'LP = 616', ans:'7 cm', val:7 },
  { id:'5C', chart:5, pos:2, text:'Sebuah limas segi empat beraturan memiliki panjang sisi alas 10 cm dan tinggi sisi tegak (apotema) 13 cm. Berapakah volume limas tersebut?', note:'Ilustrasi skematis (tidak menurut skala).', kind:'limas', dims:'alas 10, apotema 13', ans:'400 cm³', val:400 },
  { id:'5D', chart:5, pos:3, text:'Sebuah ruangan berbentuk balok memiliki panjang 9 m, lebar 12 m, dan tinggi 20 m. Berapakah panjang diagonal ruang ruangan tersebut?', note:'', kind:'balok', dims:'9 × 12 × 20 m', ans:'25 m', val:25 },
  { id:'5E', chart:5, pos:4, text:'Sebuah bangun gabungan terdiri atas tabung dan kerucut yang memiliki jari-jari alas sama, yaitu 7 cm. Tinggi tabung 6 cm dan tinggi kerucut 6 cm. Berapakah volume seluruh bangun tersebut? Gunakan π = 22/7.', note:'π = 22/7', kind:'gabungan', dims:'tabung + kerucut', ans:'1.232 cm³', val:1232 },
  { id:'6A', chart:6, pos:0, text:'Sebuah prisma segitiga memiliki alas berbentuk segitiga siku-siku dengan panjang kedua sisi tegak 3 cm dan 4 cm. Jika tinggi prisma 6 cm, berapakah volumenya?', note:'Ilustrasi skematis (tidak menurut skala).', kind:'prisma', dims:'alas 3-4, t=6', ans:'36 cm³', val:36 },
  { id:'6B', chart:6, pos:1, text:'Sebuah prisma memiliki luas alas 30 cm² dan volume 300 cm³. Berapakah tinggi prisma tersebut?', note:'', kind:'prisma', dims:'La=30, V=300', ans:'10 cm', val:10 },
  { id:'6C', chart:6, pos:2, text:'Sebuah kerucut memiliki jari-jari alas 7 cm dan garis pelukis 25 cm. Berapakah volumenya? Gunakan π = 22/7.', note:'π = 22/7', kind:'kerucut', dims:'r=7, s=25', ans:'1.232 cm³', val:1232 },
  { id:'6D', chart:6, pos:3, text:'Sebuah prisma memiliki alas berbentuk segitiga dengan panjang sisi 13 cm, 14 cm, dan 15 cm. Jika tinggi prisma 10 cm, berapakah volume prisma tersebut?', note:'Gunakan rumus Heron untuk luas alas.', kind:'prisma', dims:'13-14-15, t=10', ans:'840 cm³', val:840 },
  { id:'6E', chart:6, pos:4, text:'Sebuah balok tertutup memiliki alas berbentuk persegi dengan panjang sisi x cm dan tinggi h cm. Jika volumenya 216 cm³, tentukan panjang sisi alas x yang menghasilkan luas permukaan minimum.', note:'Soal optimasi.', kind:'balok', dims:'V = 216', ans:'6 cm', val:6 },
  { id:'7A', chart:7, pos:0, text:'Sebuah limas segi empat beraturan memiliki panjang sisi alas 6 cm dan tinggi 9 cm. Berapakah volumenya?', note:'', kind:'limas', dims:'alas 6, t=9', ans:'108 cm³', val:108 },
  { id:'7B', chart:7, pos:1, text:'Sebuah limas segi empat beraturan memiliki volume 300 cm³ dan panjang sisi alas 10 cm. Berapakah tinggi limas tersebut?', note:'', kind:'limas', dims:'V=300, alas 10', ans:'9 cm', val:9 },
  { id:'7C', chart:7, pos:2, text:'Sebuah prisma memiliki alas berbentuk trapesium. Panjang sisi-sisi sejajar trapesium adalah 6 cm dan 14 cm, sedangkan tinggi trapesium 6 cm. Jika tinggi prisma 8 cm, berapakah volume prisma tersebut?', note:'Ilustrasi skematis (tidak menurut skala).', kind:'prisma', dims:'trapesium, t=8', ans:'480 cm³', val:480 },
  { id:'7D', chart:7, pos:3, text:'Sebuah tabung memiliki jari-jari 7 dm dan tinggi 2 dm. Berapakah volume tabung tersebut dalam liter? Gunakan π = 22/7.', note:'π = 22/7. 1 dm³ = 1 liter.', kind:'tabung', dims:'r=7 dm, t=2', ans:'308 liter', val:308 },
  { id:'7E', chart:7, pos:4, text:'Sebuah balok berukuran 30 cm × 24 cm × 18 cm akan diisi penuh dengan kubus-kubus kecil yang panjang rusuknya 6 cm. Berapa banyak kubus kecil yang diperlukan?', note:'', kind:'kubus', dims:'balok 30×24×18', ans:'60 kubus', val:60 },
  { id:'8A', chart:8, pos:0, text:'Sebuah setengah bola memiliki jari-jari 7 cm. Berapakah luas permukaan lengkungnya saja (tanpa bidang lingkaran alas)? Gunakan π = 22/7.', note:'π = 22/7. Hanya selimut lengkung.', kind:'bola', dims:'½ bola, r=7', ans:'308 cm²', val:308 },
  { id:'8B', chart:8, pos:1, text:'Sebuah kubus memiliki luas permukaan 384 cm². Berapakah panjang rusuk kubus tersebut?', note:'', kind:'kubus', dims:'LP = 384', ans:'8 cm', val:8 },
  { id:'8C', chart:8, pos:2, text:'Sebuah bola memiliki volume 288π cm³. Berapakah panjang jari-jari bola tersebut?', note:'', kind:'bola', dims:'V = 288π', ans:'6 cm', val:6 },
  { id:'8D', chart:8, pos:3, text:'Sebuah balok berukuran 12 cm × 8 cm × 8 cm akan dipotong menjadi kubus-kubus kecil yang masing-masing memiliki panjang rusuk 4 cm. Berapa banyak kubus kecil yang diperoleh?', note:'', kind:'kubus', dims:'12×8×8 → r=4', ans:'12 kubus', val:12 },
  { id:'8E', chart:8, pos:4, text:'Sebuah bola besar berjari-jari 6 cm dilebur dan dibentuk kembali menjadi bola-bola kecil yang masing-masing berjari-jari 3 cm. Berapa banyak bola kecil yang dihasilkan?', note:'', kind:'bola', dims:'R=6 → r=3', ans:'8 bola', val:8 },
  { id:'9A', chart:9, pos:0, text:'Sebuah balok memiliki panjang 5 cm, lebar 4 cm, dan tinggi 7 cm. Berapakah jumlah panjang seluruh rusuk balok tersebut?', note:'', kind:'balok', dims:'5 × 4 × 7', ans:'64 cm', val:64 },
  { id:'9B', chart:9, pos:1, text:'Sebuah tabung memiliki volume 3.080 cm³ dan jari-jari 7 cm. Berapakah tinggi tabung tersebut? Gunakan π = 22/7.', note:'π = 22/7', kind:'tabung', dims:'V=3080, r=7', ans:'20 cm', val:20 },
  { id:'9C', chart:9, pos:2, text:'Dua buah tabung memiliki tinggi yang sama. Perbandingan jari-jari tabung pertama dan kedua adalah 2 : 3. Jika volume tabung pertama 440 cm³, berapakah selisih volume kedua tabung tersebut?', note:'', kind:'tabung', dims:'r 2:3, V1=440', ans:'550 cm³', val:550 },
  { id:'9D', chart:9, pos:3, text:'Sebuah tabung memiliki jari-jari 7 cm dan tinggi 21 cm. Di dalam tabung tersebut terdapat sebuah kerucut yang memiliki jari-jari alas dan tinggi sama dengan jari-jari dan tinggi tabung. Berapakah volume ruang di dalam tabung yang tidak ditempati kerucut? Gunakan π = 22/7.', note:'Ilustrasi skematis (tidak menurut skala). π = 22/7', kind:'gabungan', dims:'tabung − kerucut', ans:'2.156 cm³', val:2156 },
  { id:'9E', chart:9, pos:4, text:'Dua tangki memiliki bentuk yang sama, yaitu tabung dengan setengah bola pada bagian atasnya. Keduanya memiliki jari-jari 1 m. Tinggi bagian tabung tangki pertama 4 m, sedangkan tangki kedua 2 m. Berapakah selisih kapasitas kedua tangki dalam liter? Gunakan π = 3,14.', note:'Ilustrasi skematis (tidak menurut skala). π = 3,14. 1 m³ = 1.000 liter.', kind:'gabungan', dims:'tangki 1 vs 2', ans:'6.280 liter', val:6280 },
  { id:'10A', chart:10, pos:0, text:'Sebuah tabung memiliki jari-jari 7 cm dan tinggi 4 cm. Berapakah luas selimut tabung tersebut? Gunakan π = 22/7.', note:'π = 22/7', kind:'tabung', dims:'r=7, t=4', ans:'176 cm²', val:176 },
  { id:'10B', chart:10, pos:1, text:'Sebuah bola memiliki jari-jari 3 cm. Berapakah panjang diameternya?', note:'', kind:'bola', dims:'r = 3', ans:'6 cm', val:6 },
  { id:'10C', chart:10, pos:2, text:'Sebuah balok memiliki ukuran 12 cm × 8 cm × 6 cm. Jika panjang, lebar, dan tingginya masing-masing diperbesar menjadi dua kali ukuran semula, berapakah volume balok yang baru?', note:'', kind:'balok', dims:'12×8×6 → ×2', ans:'4.608 cm³', val:4608 },
  { id:'10D', chart:10, pos:3, text:'Sebuah setengah bola berjari-jari 7 cm ditempelkan pada salah satu sisi kubus yang panjang rusuknya 14 cm. Lingkaran alas setengah bola tepat menutupi bagian lingkaran pada sisi kubus. Berapakah luas permukaan luar bangun gabungan tersebut? Gunakan π = 22/7.', note:'Ilustrasi skematis (tidak menurut skala). π = 22/7', kind:'gabungan', dims:'kubus + ½ bola', ans:'1.330 cm²', val:1330 },
  { id:'10E', chart:10, pos:4, text:'Sebuah tangki terdiri atas tabung dan setengah bola pada bagian atasnya. Keduanya memiliki jari-jari 3 cm. Jika volume seluruh tangki 169,56 cm³, berapakah tinggi bagian tabung? Gunakan π = 3,14.', note:'Ilustrasi skematis (tidak menurut skala). π = 3,14', kind:'gabungan', dims:'tabung + ½ bola', ans:'4 cm', val:4 },
];

function newId(n=6){
  const c='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s=''; const b=crypto.randomBytes(n);
  for(let i=0;i<n;i++) s+=c[b[i]%c.length];
  return s;
}
const insQ = db.prepare(`INSERT INTO questions (id, game_id, chart_no, pos, code, text, note, kind, dims, answer_display, answer_value, status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
function seedQuestions(gameId){
  tx(()=>{
    for(const q of SEED){
      insQ.run(q.id, gameId, q.chart, q.pos, q.id, q.text, q.note, q.kind, q.dims, q.ans, q.val, 'available');
    }
  });
}

// ---------- Normalisasi jawaban numerik (Indonesia-aware) ----------
function parseNumeric(raw){
  if(raw==null) return NaN;
  let s = String(raw).toLowerCase().trim();
  if(!s) return NaN;
  const m = s.match(/-?[\d\.\,\s]+/);
  if(!m) return NaN;
  s = m[0].trim();
  if(s.includes(',')){
    s = s.replace(/\./g,'').replace(/\s/g,'').replace(',','.');
  } else {
    s = s.replace(/\./g,'').replace(/\s/g,'').replace(/,/g,'');
  }
  return Number(s);
}
function isCorrect(raw, keyVal){
  const v = parseNumeric(raw);
  if(!Number.isFinite(v)) return false;
  return Math.abs(v - keyVal) < 1e-6;
}

// ---------- App ----------
const app = express();
app.use(express.json({limit:'256kb'}));
app.use(express.static(path.join(__dirname,'public')));

const adminTokens = new Set();
function isAdmin(req){
  const h = req.headers.authorization || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : '';
  if(!tok) return false;
  if(tok === ADMIN_PASSWORD) return true;
  return adminTokens.has(tok);
}

const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const subs = new Map();
function sub(ws, gameId){
  unsub(ws);
  if(!subs.has(gameId)) subs.set(gameId,new Set());
  subs.get(gameId).add(ws);
  ws._game = gameId;
}
function unsub(ws){
  if(ws._game && subs.has(ws._game)) subs.get(ws._game).delete(ws);
  ws._game = null;
}
function broadcast(gameId, msg){
  const set = subs.get(gameId);
  if(!set) return;
  const s = JSON.stringify(msg);
  for(const c of set){ try{ if(c.readyState===1) c.send(s); }catch(e){} }
}
wss.on('connection',(ws)=>{
  ws._game=null;
  ws.on('message',(raw)=>{
    try{
      const m = JSON.parse(raw.toString());
      if(m.type==='subscribe' && m.gameId){ sub(ws, String(m.gameId).toUpperCase()); ws.send(JSON.stringify({type:'subscribed', gameId:ws._game})); pushState(ws._game); }
      if(m.type==='ping'){ ws.send(JSON.stringify({type:'pong', t:Date.now()})); }
    }catch(e){}
  });
  ws.on('close',()=>unsub(ws));
});

// prepared statements
const ps = {
  game: db.prepare(`SELECT * FROM games WHERE id=?`),
  players: db.prepare(`SELECT id,name,score,created_at FROM players WHERE game_id=?`),
  questions: db.prepare(`SELECT * FROM questions WHERE game_id=? ORDER BY chart_no,pos`),
  qStatus: db.prepare(`SELECT id, chart_no, pos, status FROM questions WHERE game_id=? ORDER BY chart_no, pos`),
  countClaimed: db.prepare(`SELECT COUNT(*) AS v FROM questions WHERE game_id=? AND status='claimed'`),
  countQ: db.prepare(`SELECT COUNT(*) AS v FROM questions WHERE game_id=?`),
  countPlayers: db.prepare(`SELECT COUNT(*) AS v FROM players WHERE game_id=?`),
  playerName: db.prepare(`SELECT name FROM players WHERE id=?`),
  claimsOf: db.prepare(`SELECT code FROM questions WHERE game_id=? AND claimed_by=? ORDER BY chart_no`),
};

function publicQuestion(q, playerMap){
  return {
    id:q.id, code:q.code, chart:q.chart_no, pos:q.pos,
    text:q.text, note:q.note, kind:q.kind, dims:q.dims,
    status:q.status,
    claimedBy: q.claimed_by ? (playerMap[q.claimed_by]||null) : null,
    claimedAt:q.claimed_at||null
  };
}
function frontIds(gameId){
  const rows = ps.qStatus.all(gameId);
  const front = new Set();
  const seen = new Set();
  for(const r of rows){
    if(seen.has(r.chart_no)) continue;
    if(r.status==='available'){ front.add(r.id); seen.add(r.chart_no); }
  }
  return front;
}

function gameState(gameId){
  const g = ps.game.get(gameId);
  if(!g) return null;
  const players = ps.players.all(gameId);
  const qs = ps.questions.all(gameId);
  const pmap = {}; players.forEach(p=>pmap[p.id]=p.name);
  const claimed = qs.filter(q=>q.status==='claimed').length;
  const qByPlayer = {};
  qs.forEach(q=>{ if(q.claimed_by){ (qByPlayer[q.claimed_by]=qByPlayer[q.claimed_by]||[]).push(q.code); }});
  const leaderboard = players.map(p=>({ id:p.id, name:p.name, score:p.score, claims:(qByPlayer[p.id]||[]).sort() }))
    .sort((a,b)=> b.score-a.score || a.name.localeCompare(b.name,'id'));
  const now = Date.now();
  let remaining = null;
  if(g.status==='running' && g.ends_at) remaining = Math.max(0, Math.floor((g.ends_at-now)/1000));
  const front = [...frontIds(gameId)];
  return {
    game:{ id:g.id, name:g.name, status:g.status, durationSec:g.duration_sec, startsAt:g.starts_at, endsAt:g.ends_at, createdAt:g.created_at, remaining, total:qs.length, claimed },
    players: leaderboard,
    playerCount: players.length,
    questions: qs.map(q=>publicQuestion(q,pmap)),
    front,
    leaderboard
  };
}
function pushState(gameId){
  if(!gameId) return;
  const st = gameState(gameId);
  if(st) broadcast(gameId,{type:'state', state:st});
}
function endGame(gameId, reason='manual'){
  const g = ps.game.get(gameId);
  if(!g || g.status==='ended') return false;
  db.prepare(`UPDATE games SET status='ended' WHERE id=?`).run(gameId);
  db.prepare(`INSERT INTO attempts (game_id,player_id,player_name,question_id,answer_raw,correct,result,created_at) VALUES (?,?,?,?,?,?,?,?)`)
    .run(gameId,'—','sistem','—','',0,'GAME_END:'+reason,Date.now());
  pushState(gameId);
  broadcast(gameId,{type:'game_end', reason});
  return true;
}
setInterval(()=>{
  const now = Date.now();
  const running = db.prepare(`SELECT * FROM games WHERE status='running'`).all();
  for(const g of running){
    const c = ps.countClaimed.get(g.id).v;
    const total = ps.countQ.get(g.id).v;
    if(total>0 && c>=total){ endGame(g.id,'all_claimed'); continue; }
    if(g.ends_at && now>=g.ends_at){ endGame(g.id,'time_up'); }
    else pushState(g.id);
  }
},1000);

// ---------- API ----------
app.get('/api/games', (req,res)=>{
  const games = db.prepare(`SELECT id,name,status,created_at,starts_at,ends_at FROM games ORDER BY created_at DESC LIMIT 50`).all();
  const out = games.map(g=>({...g, players: ps.countPlayers.get(g.id).v, claimed: ps.countClaimed.get(g.id).v }));
  res.json({games:out});
});

app.post('/api/admin/login',(req,res)=>{
  const pw = String(req.body?.password||'');
  if(pw===ADMIN_PASSWORD){
    const tok = crypto.randomUUID();
    adminTokens.add(tok);
    res.json({token:tok});
  } else res.status(401).json({error:'Password salah.'});
});
app.post('/api/admin/games',(req,res)=>{
  if(!isAdmin(req)) return res.status(401).json({error:'Unauthorized. Login admin dulu.'});
  const name = String(req.body?.name||'Cerebral Race – Bangun Ruang').slice(0,120);
  const id = newId(6);
  db.prepare(`INSERT INTO games (id,name,status,duration_sec,created_at) VALUES (?,?,?,?,?)`).run(id,name,'lobby',DURATION_SEC,Date.now());
  seedQuestions(id);
  res.json({gameId:id, name});
});
app.get('/api/admin/game/:id',(req,res)=>{
  if(!isAdmin(req)) return res.status(401).json({error:'Unauthorized'});
  const id = String(req.params.id).toUpperCase();
  const st = gameState(id);
  if(!st) return res.status(404).json({error:'Game tidak ditemukan'});
  const attempts = db.prepare(`SELECT player_name,question_id,answer_raw,correct,result,created_at FROM attempts WHERE game_id=? ORDER BY id DESC LIMIT 300`).all(id);
  res.json({...st, attempts});
});
app.post('/api/admin/game/:id/start',(req,res)=>{
  if(!isAdmin(req)) return res.status(401).json({error:'Unauthorized'});
  const id = String(req.params.id).toUpperCase();
  const g = ps.game.get(id);
  if(!g) return res.status(404).json({error:'Game tidak ditemukan'});
  if(g.status==='running') return res.json({ok:true});
  if(g.status==='ended') return res.status(400).json({error:'Game sudah berakhir. Buat game baru atau reset.'});
  const now = Date.now();
  db.prepare(`UPDATE games SET status='running', starts_at=?, ends_at=? WHERE id=?`).run(now, now+g.duration_sec*1000, id);
  pushState(id);
  broadcast(id,{type:'game_start'});
  res.json({ok:true});
});
app.post('/api/admin/game/:id/end',(req,res)=>{
  if(!isAdmin(req)) return res.status(401).json({error:'Unauthorized'});
  const id = String(req.params.id).toUpperCase();
  endGame(id,'manual');
  res.json({ok:true});
});
app.post('/api/admin/game/:id/reset',(req,res)=>{
  if(!isAdmin(req)) return res.status(401).json({error:'Unauthorized'});
  const id = String(req.params.id).toUpperCase();
  if(req.body?.confirm!==true) return res.status(400).json({error:'Reset membutuhkan konfirmasi.'});
  const g = ps.game.get(id);
  if(!g) return res.status(404).json({error:'Game tidak ditemukan'});
  tx(()=>{
    db.prepare(`UPDATE questions SET status='available', claimed_by=NULL, claimed_at=NULL WHERE game_id=?`).run(id);
    db.prepare(`UPDATE players SET score=0 WHERE game_id=?`).run(id);
    db.prepare(`DELETE FROM attempts WHERE game_id=?`).run(id);
    db.prepare(`UPDATE games SET status='lobby', starts_at=NULL, ends_at=NULL WHERE id=?`).run(id);
  });
  pushState(id);
  res.json({ok:true});
});
app.delete('/api/admin/game/:id',(req,res)=>{
  if(!isAdmin(req)) return res.status(401).json({error:'Unauthorized'});
  const id = String(req.params.id).toUpperCase();
  db.prepare(`DELETE FROM games WHERE id=?`).run(id);
  broadcast(id,{type:'game_deleted'});
  res.json({ok:true});
});
app.delete('/api/admin/game/:id/player/:pid',(req,res)=>{
  if(!isAdmin(req)) return res.status(401).json({error:'Unauthorized'});
  const id = String(req.params.id).toUpperCase();
  const pid = String(req.params.pid);
  db.prepare(`DELETE FROM players WHERE id=? AND game_id=?`).run(pid,id);
  pushState(id);
  res.json({ok:true});
});
app.get('/api/admin/game/:id/export.csv',(req,res)=>{
  if(!isAdmin(req)) return res.status(401).json({error:'Unauthorized'});
  const id = String(req.params.id).toUpperCase();
  const st = gameState(id);
  if(!st) return res.status(404).json({error:'Game tidak ditemukan'});
  let csv = 'Peringkat,Nama,Skor,Soal diklaim\n';
  st.leaderboard.forEach((p,i)=>{ csv += `${i+1},"${p.name.replace(/"/g,'""')}",${p.score},"${p.claims.join(' ')}"\n`; });
  res.setHeader('Content-Type','text/csv; charset=utf-8');
  res.setHeader('Content-Disposition',`attachment; filename="hasil-${id}.csv"`);
  res.send('\ufeff'+csv);
});

app.get('/api/game/:id/state',(req,res)=>{
  const id = String(req.params.id).toUpperCase();
  const st = gameState(id);
  if(!st) return res.status(404).json({error:'Kode game tidak ditemukan.'});
  res.json(st);
});

app.post('/api/game/:id/join',(req,res)=>{
  const id = String(req.params.id).toUpperCase();
  const g = ps.game.get(id);
  if(!g) return res.status(404).json({error:'Kode game tidak ditemukan.'});
  const name = String(req.body?.name||'').trim().slice(0,24);
  if(name.length<2) return res.status(400).json({error:'Nama minimal 2 huruf.'});
  if(g.status==='ended') return res.status(400).json({error:'Permainan sudah berakhir.'});
  const dupe = db.prepare(`SELECT id FROM players WHERE game_id=? AND lower(name)=lower(?)`).get(id,name);
  if(dupe) return res.status(409).json({error:'Nama sudah dipakai Champion lain. Gunakan nama lain.'});
  const pid = crypto.randomUUID();
  const token = crypto.randomUUID();
  db.prepare(`INSERT INTO players (id,game_id,name,token,score,created_at) VALUES (?,?,?,?,0,?)`).run(pid,id,name,token,Date.now());
  pushState(id);
  res.json({playerId:pid, token, name, gameId:id});
});
app.post('/api/game/:id/rejoin',(req,res)=>{
  const id = String(req.params.id).toUpperCase();
  const token = String(req.body?.token||'');
  const p = db.prepare(`SELECT * FROM players WHERE game_id=? AND token=?`).get(id,token);
  if(!p) return res.status(404).json({error:'Sesi tidak ditemukan. Daftar ulang.'});
  res.json({playerId:p.id, token:p.token, name:p.name, gameId:id});
});
app.get('/api/game/:id/me',(req,res)=>{
  const id = String(req.params.id).toUpperCase();
  const token = String(req.query.token||'');
  const p = db.prepare(`SELECT * FROM players WHERE game_id=? AND token=?`).get(id,token);
  if(!p) return res.status(404).json({error:'Sesi tidak ditemukan'});
  const claims = ps.claimsOf.all(id,p.id).map(r=>r.code);
  res.json({playerId:p.id, name:p.name, score:p.score, claims});
});

// jawab / klaim — ATOMIK (sinkron dalam satu transaksi; Node single-threaded → tidak ada interleaving)
app.post('/api/game/:id/answer',(req,res)=>{
  const id = String(req.params.id).toUpperCase();
  const { token, questionId, answer } = req.body||{};
  const g = ps.game.get(id);
  if(!g) return res.status(404).json({error:'Game tidak ditemukan'});
  if(g.status!=='running') return res.status(400).json({error: g.status==='lobby' ? 'Permainan belum dimulai. Tunggu guru menekan Mulai.' : 'Permainan sudah berakhir.'});
  if(g.ends_at && Date.now()>=g.ends_at){ endGame(id,'time_up'); return res.status(400).json({error:'Waktu habis. Permainan berakhir.'}); }
  const p = db.prepare(`SELECT * FROM players WHERE game_id=? AND token=?`).get(id,String(token||''));
  if(!p) return res.status(401).json({error:'Sesi peserta tidak valid. Daftar ulang.'});
  const qid = String(questionId||'').toUpperCase();
  const raw = String(answer??'').slice(0,200);
  if(!raw.trim()) return res.status(400).json({error:'Jawaban masih kosong.'});
  const btn = db.prepare(`SELECT * FROM questions WHERE game_id=? AND id=?`).get(id,qid);
  if(!btn) return res.status(404).json({error:'Soal tidak ditemukan.'});

  const r = tx(()=>{
    const cur = db.prepare(`SELECT * FROM questions WHERE game_id=? AND id=?`).get(id,qid);
    if(!cur) return {t:'notfound'};
    if(cur.status==='claimed'){
      const owner = cur.claimed_by ? ps.playerName.get(cur.claimed_by) : null;
      return {t:'claimed', by: owner?.name || 'Champion lain'};
    }
    const f = frontIds(id);
    if(!f.has(qid)) return {t:'locked'};
    const ok = isCorrect(raw, cur.answer_value);
    const now = Date.now();
    if(ok){
      const upd = db.prepare(`UPDATE questions SET status='claimed', claimed_by=?, claimed_at=? WHERE game_id=? AND id=? AND status='available'`).run(p.id, now, id, qid);
      if(upd.changes!==1) return {t:'claimed', by:'Champion lain'};
      const sc = db.prepare(`SELECT COUNT(*) AS v FROM questions WHERE game_id=? AND claimed_by=?`).get(id, p.id).v;
      db.prepare(`UPDATE players SET score=? WHERE id=?`).run(sc, p.id);
      db.prepare(`INSERT INTO attempts (game_id,player_id,player_name,question_id,answer_raw,correct,result,created_at) VALUES (?,?,?,?,?,?,?,?)`)
        .run(id,p.id,p.name,qid,raw,1,'correct',now);
      return {t:'win'};
    } else {
      db.prepare(`INSERT INTO attempts (game_id,player_id,player_name,question_id,answer_raw,correct,result,created_at) VALUES (?,?,?,?,?,?,?,?)`)
        .run(id,p.id,p.name,qid,raw,0,'wrong',now);
      return {t:'wrong'};
    }
  });

  if(r.t==='win'){
    pushState(id);
    const c = ps.countClaimed.get(id).v;
    const total = ps.countQ.get(id).v;
    if(c>=total) endGame(id,'all_claimed');
    return res.json({ok:true, correct:true, claimed:true, message:`Benar! Soal ${qid} berhasil kamu klaim.`});
  }
  if(r.t==='wrong') return res.json({ok:true, correct:false, message:'Belum tepat. Soal masih tersedia — coba lagi!'});
  if(r.t==='claimed') return res.status(409).json({ok:false, claimed:true, message:`Soal sudah diklaim oleh ${r.by}. Pilih soal depan lainnya!`});
  if(r.t==='locked') return res.status(403).json({ok:false, message:'Soal ini masih di belakang flip chart dan belum bisa dibuka.'});
  return res.status(404).json({error:'Soal tidak ditemukan'});
});

app.get('/healthz',(req,res)=>res.json({ok:true}));
app.get('/admin', (req,res)=>res.sendFile(path.join(__dirname,'public','admin.html')));
app.get('/play', (req,res)=>res.sendFile(path.join(__dirname,'public','play.html')));

server.listen(PORT, ()=>{
  console.log(`Cerebral Race berjalan di http://localhost:${PORT}`);
  console.log(`Admin default password: ${ADMIN_PASSWORD} (ubah via env ADMIN_PASSWORD)`);
});
