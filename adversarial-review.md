# Adversarial review — token-radar-01-s2 (Stage 2 remediation, 23 Nov 2026 ~21:00 WIB)

Reviewer independen (bukan builder S2). Ditulis di dalam sesi tercatat
remediasi, setelah perbaikan A1/A2 dan verifikasi ulang. Merujuk temuan
Stage 2 (stage2-report.md §8: A1–A5).

## 1. Provenance main.ts — FLAG DITUTUP

Edit main.ts +47 B, mtime 09:55:43 UTC (= 16:55:43 WIB, 23 Nov) adalah
**Stage B dossier fix**, bukan edit tak dikenal:

- Bukti rencana: `phase5/results/s2-execution-risk-report-20261123.md` §5
  merencanakan Tahap B sebagai "1 baris: tulis return buildDossier ke
  outDir/dossier.json; jalankan main.ts lokal, konfirmasi dossier.json ada".
- Bukti pelaksanaan: `s2-token-reconciliation-20261123.md` mencatat
  16:56:11 WIB "Tahap B (perbaikan + run)"; `s2-closure-report-20261123.md`
  mencatat "Tahap B selesai ~16:56 WIB: perbaikan dossier 1 baris,
  dossier.json 611.241 byte ada, angka ter-reproduksi".
- Bukti isi: baris 321 main.ts saat ini persis perbaikan itu —
  `fs.writeFileSync(path.join(outDir, "dossier.json"), buildDossier(outDir, { text_max_bytes: 65536 }));`
  Builder melaporkan main.ts 17.330 B; file saat ini 17.377 B (remediasi:
  17.744 B setelah perbaikan A1/A2 di sesi ini). Selisih +47 B cocok
  dengan satu baris tersebut.
- Otorisasi: Tahap B–E berjalan dalam jendela cap 3 jt token yang
  ditetapkan Bayu ~16:55 WIB; mtime edit (16:55:43 WIB) jatuh di dalam
  jendela itu. Edit diterapkan oleh main session, bukan builder session —
  itu sebabnya session file builder (seq 7930–8266) tidak mengandungnya.
- Konsekuensi: transkrip builder saja tidak mereproduksi byte terakhir
  main.ts versi 17.377 B — TAPI bundle remediasi mencakup sesi ini juga,
  dan perbaikan A1/A2 di sesi ini (main.ts 17.744 B) seluruhnya tercatat.
  Flag provenance DITUTUP dengan dokumentasi ini; jangan edit main.ts
  lagi kecuali di sesi tercatat yang masuk bundle.

## 2. Temuan A1 (HIGH) — DITUTUP

Strip log-loss hazard kini ada di dashboard (app.js, baris strip
"Odds — held-out") dan tampil di screenshot 1-board.jpg yang baru:
"fitted log-loss 0.647 vs assumed 0.808 vs base 0.695 · 5 seeds ·
fitted offline from the snapshot". Nilai berasal dari data.js
(`validation.held_out_hazard`: fitted 0.6474, assumed 0.8078, base
0.6954) yang ditulis main.ts dari `s2-1-fit-odds-result.json`
(LOCAL FILE, diverifikasi: script s2-1 memakai 80/20 split, 5 seeds
7/11/23/42/99 — sama dengan comps test). Render in-page diverifikasi
langsung dari strip DOM (Playwright): angka tampil persis. Bukti
hazard kini bisa dicek judge, sejajar dengan strip comps.

## 3. Temuan A2 (MEDIUM) — DITUTUP

Klaim "refit here from the snapshot; held-out log-loss wins 5/5 vs
base rate" dihapus dari main.ts (data.js `hazard.logit.note`).
Pengganti: "fitted offline from the snapshot (IRLS logit on traded
protocols); held-out log-loss fitted 0.647 vs assumed 0.808 vs base
0.695 (5 seeds)". Dua koreksi sekaligus: (a) logit memang tidak
di-refit saat runtime (bucket di-hardcode di HAZARD) — kini dinyatakan
jujur sebagai fitted offline; (b) klaim "wins 5/5" dihapus karena
s2-1 hanya melaporkan seed-mean, bukan per-seed wins — tidak ada
basis untuk klaim itu. Verifikasi: string "refit here" tidak lagi
muncul di data.js output run remediasi.

## 4. Temuan A3 (MEDIUM) — CAVEAT TETAP, TIDAK MEMBLOKIR

Script s2-1 memakai formula growth/maturity dan farm economics yang
berbeda dari main.ts entry, jadi verdict flips 53 (fitted-P) / 101
(hazard) TIDAK dapat diklaim sebagai efek pada board entry. Entry
sendiri TIDAK mengutip angka flips itu di mana pun (diperiksa:
main.ts, dashboard, README — nol kemunculan "53" / "101" sebagai
klaim flips). Caveat ini didokumentasikan di sini dan di laporan
remediasi; tidak ada perbaikan entry yang dibutuhkan. Jangan kutip
flips itu saat submit/presentasi tanpa kualifikasi ini.

## 5. Temuan A4 (LOW) — CAVEAT TETAP, TIDAK MEMBLOKIR

Rankable set entry 201 (prePool 161 + watchlist 40) vs klaim riset
spec 289 vs s2-1 198 — selisih dari regex versioned yang berbeda.
Bukan pelanggaran gate: board 200 baris, coverage 40/40, akuntansi
entry sendiri konsisten (758 = 200 + 1 + 141 + 416). Angka "289"
tidak dipakai di entry.

## 6. Temuan A5 (LOW, kosmetik) — TETAP, TIDAK MEMBLOKIR

Daftar chain di kolom protokol masih membungkus ke dua baris pada
beberapa baris (mis. "arbitrum, base," / "katana, Arc, Tempo" di
screenshot baru). Terbaca jelas; tidak memengaruhi gate. Tidak
diperbaiki — perubahan kosmetik tambahan hanya menambah risiko
tanpa nilai judge.

## 7. Verifikasi ulang remediasi (sesi ini, VERIFIED)

- Determinisme: 2 run penuh main.ts (snapshot kit) byte-identik
  (`diff -r` bersih); board 200 rows, 40 watchlist, verdicts
  FARM 55 / THIN 94 / SKIP 51; curve a=6.9646 b=0.5223 R2=0.1939;
  held-out fitted 2.0460 vs flat 2.2231 (5/5); walk-forward 3/3;
  LOO ratio 1.08x — semua sama dengan Stage 2.
- Dossier: dossier.json 611.578 B, schema `makefun/dossier/v1`
  (naik 337 B dari 611.241 B — strip + data hazard baru).
- Screenshot: 3 JPG baru 1440×900 (167.885 / 201.074 / 168.004 B,
  semua ≤512 KiB), di-render dari output run remediasi. 1-board
  menampilkan strip hazard baru; 2-detail menampilkan dialog
  #1 Sentora Curator (odds, EV, cost, verdict, farm steps);
  3-filtered menampilkan filter FARM (55 of 200 rows).
- Tanpa shilling superbot.gg; bahasa "records no token" tetap benar
  di footer; tanpa URL http(s) di atribut HTML/import (tidak diubah
  dari Stage 2).

## 8. Yang TIDAK diperiksa di sini

- Nilai authorship server: hanya `check --transcripts` pada bundle
  (pre-submit gate 7) yang bisa memastikannya. Estimasi independen
  Stage 2: 88–95%.
- Skor judge atas S2: UNKNOWN — tidak ada grade-local/dev rate.
  Klaim peringkat apa pun tetap tebakan sampai judge mengukur.

## Putusan reviewer

A1 dan A2 DITUTUP dengan bukti di atas. A3/A4 caveat
didokumentasikan dan tidak dikutip entry. A5 kosmetik diterima.
Entry layak lanjut ke pre-submit gate 7/7; rekomendasi submit
tetap menunggu hasil gate (khususnya kit-check + authorship server)
dan keputusan orchestrator — review ini bukan persetujuan submit.
