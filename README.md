# Game Kompetitif Matematika: Bangun Ruang — Cerebral Race

Website permainan kompetitif real-time untuk materi Bangun Ruang (10 flip chart, 50 soal).
Mekanisme mengadaptasi Cerebral Race (Clash of Champions): peserta berebut mengklaim soal tercepat.

## Fitur (sesuai spesifikasi)

- **10 flip chart × 5 soal = 50 soal** Bangun Ruang (teks & kunci dari dokumen sumber, tidak diubah).
- **Hanya soal terdepan tiap flip chart** yang bisa dipilih; soal belakang terkunci otomatis.
- **Adapto X**: kolom jawaban + keypad numerik (mendukung koma desimal Indonesia & titik ribuan).
- **Validasi di backend**, kunci jawaban TIDAK dikirim ke frontend. Normalisasi angka Indonesia-aware
  (`2.156` → 2156; `169,56` → 169.56). Semua kunci bulat, toleransi 1e-6.
- **Atomic claim** via transaksi SQLite: dua jawaban benar bersamaan → hanya 1 pemenang; yang kalah
  menerima info "sudah diklaim oleh …".
- **Real-time** via WebSocket: klaim, skor, leaderboard, timer tersiar ke semua perangkat tanpa reload.
- **Timer server-side 40 menit** + auto-end (waktu habis / semua 50 diklaim).
- **Roles**: Champion (siswa) & Admin (guru, password).
- **Persistensi**: SQLite (`game.db`). Refresh/tab ditutup/internet putus → sesi + progres aman.
- **Admin dashboard**: buat game (kode 6 huruf), lobby → mulai → akhiri manual, timer, reset
  (konfirmasi ganda), hapus game, keluarkan peserta, pantau 50 soal + riwayat jawaban, leaderboard live, export CSV.
- **Pendaftaran**: nama unik per game (case-insensitive), token sesi di localStorage untuk rejoin otomatis.

## Cara menjalankan

```bash
cd cerebral-race
npm install
npm start
# buka http://localhost:3000
# Admin: http://localhost:3000/admin  (password default: guru123)
```

Ubah password & port:

```bash
ADMIN_PASSWORD=rahasiaBaru PORT=3000 npm start
```

### Alur demo (2 menit)

1. Buka `/admin` → login → **Buat Game** → catat kode (mis. `KX7P2Q`).
2. Di HP/laptop lain (atau tab lain) buka `/` → isi kode + nama → **Masuk**.
3. Daftarkan 2–3 Champion untuk simulasi perebutan.
4. Admin tekan **Mulai** → arena LIVE, timer 40:00 berjalan.
5. Champion klik soal bercahaya → jawab via Adapto X → klaim pertama menang.
6. Leaderboard & flip chart berubah real-time di semua perangkat.
7. Admin bisa **akhiri**, **export CSV**, atau **reset** (ketik RESET).

### Main di jaringan kelas (satu WiFi)

Jalankan server di laptop guru, lalu siswa membuka `http://<IP-laptop-guru>:3000`
(contoh `http://192.168.1.10:3000`). Pastikan firewall mengizinkan port 3000.

## Struktur

```
cerebral-race/
  server.js          # Express + SQLite + WebSocket (sumber kebenaran: database)
  public/
    index.html       # landing + daftar Champion
    play.html        # arena + Adapto X + leaderboard live
    admin.html       # dashboard guru
    style.css        # tema Clash-of-Champions (gelap + emas)
  game.db            # dibuat otomatis (persistensi)
  package.json
```

## Catatan desain soal

- 50 soal & kunci diambil dari `Soal_Flip_Chart_dan_Kunci_Jawaban.docx` (termasuk koreksi 4D = 576 cm²).
- Hanya soal depan tiap chart yang `front` (dihitung server: available dengan `pos` terkecil per chart).
- Frontend tidak pernah menerima `answer_value`; endpoint `/api/game/:id/state` hanya berisi teks soal + status.
