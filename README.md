# StudyShare — realtime 교안 sharing

A self-hosted study room modeled on the 교안 tab of the LMS. The teacher shares lecture material (a PDF, PowerPoint, Word or Excel file, images, or a live HTML page) and explains it while writing on it. Students either follow the teacher's screen live (**강사 화면 따라가기 중**) or browse on their own (**혼자 보기**), and each student keeps private notes (**내 필기**) on top.

## Features

| Area | What it does |
| --- | --- |
| 교안 formats | **PDF** as is. **PowerPoint, Word, Excel** (`ppt pptx pps ppsx odp doc docx rtf odt xls xlsx ods`) are converted to PDF on the server. **Images** become pages: several images uploaded together form one 교안 (one page each, in name order), GIF/WebP/BMP/AVIF are re-encoded to PNG in the browser, and sideways phone photos are turned upright. **HTML** runs live (next row). The 파일 tab always keeps the original file. |
| Live HTML | An `.html` file, or a `.zip` of a folder (page plus its images, scripts and audio), runs in a sandboxed frame laid out at 1280×720 for everyone and scaled to fit. Students follow the teacher's slide (`#/3`-style hashes, reveal.js) and scroll position, and can still click and type in the page. Ink is kept per slide and sticks to scrolled content. Pages that use `localStorage` keep working. |
| Pages | **빈 판서**: a whiteboard 교안 with blank, squared or lined pages. The page menu inserts a blank or squared page, or an image, after the current page, and deletes the current page. Ink and question links on later pages move with them. **Ctrl+V** pastes a copied screenshot as the next page (or as a new 교안 when an HTML page is on screen). Teachers can also drop files on the 교안 area. |
| Sync | The teacher's page changes are pushed to every student in real time. A student who navigates manually switches to 혼자 보기 automatically. The pill then shows `혼자 보기 · 강사 p.N`, and one click jumps back to following. |
| 강사 판서 | Pen, text, stroke eraser, laser pointer, 3 sizes × 4 colors, undo, and clear page. Strokes stream live while drawn (40 ms batches) and are saved per page, so late joiners see them. Students can hide the teacher's ink with **강사 판서 ON/OFF**. |
| 내 필기 | The same tools on a private layer. Notes are stored on the server per student, so they survive refresh and follow the student to other devices if a password was set. A stylus turns on palm rejection. |
| Capture / download | 📷 saves the current page as a PNG with the visible ink. ⬇ downloads the PDF with the ink merged into the annotated pages (for converted files, the converted PDF). On an HTML 교안, ⬇ downloads the uploaded file and 📷 is off. |
| Side panel (분할 보기) | **질문**: anonymous option, likes, 좋아요순/최신순 sort, teacher answers, mark resolved; each question is linked to its page (`p.N` jumps there). **채팅**. **AI 도우미**: optional. |
| 화면 공유 | The teacher shares a screen or window (**화면 공유** in the 교안 toolbar) for things that aren't a 교안: code, software demos, video. Students who follow see it in place of the 교안, can switch back with **교안 보기**, and double-click for fullscreen. The teacher's PC encodes it **once**, whatever the class size, and picks the graphics chip's encoder when there is one. Two modes: **글자·코드 선명하게** (15 fps, sharp text) and **동영상 부드럽게** (30 fps). Optional **relay PCs** take part of the class off the teacher's PC; see [화면 공유 and relay PCs](#화면-공유-and-relay-pcs). |
| Raise hand ✋ | Students raise or lower a hand. The teacher sees a badge and a list, and can lower one hand or all of them. |
| 파일 (shared files) | The teacher uploads any file type (multi-select or drag and drop) with an optional tag such as `추가자료`, and everyone can download. Files are grouped by date (오늘 / 어제 / 이번 주 / 이번 달 / 이전), with list/card views, type filters (이미지, PDF, 노트북, 코드·데이터, 문서), search (`#tag` filters by tag), and **모두 받기**, which downloads the current list as one ZIP. Images, text/code and Jupyter notebooks preview in the page, and PDFs open in a new tab. 교안 PDFs appear here too, and the **교안** button opens them in the 교안 tab. |
| 파일: teacher tools | **숨기기/공개**: upload ahead of time (e.g. answers) and reveal later. Students never receive hidden files. **다운로드 현황**: a live count per file, plus who has and hasn't downloaded. **이름·태그 수정**, **교안으로 등록** (turn an uploaded PDF, Office file, image, HTML page or ZIP into a 교안), and delete. Students get a toast and a badge on the 파일 tab when a file is shared. |
| Other | 홈 (class info, who's online, copy join link), dark mode, fullscreen, keyboard ←/→ and Ctrl+Z, mobile layout. 실습 is a placeholder. |

## Quick start

**Windows, one click:** double-click `run.bat`. It installs dependencies on the first run, rebuilds the client when its source changed, starts the production server and opens the browser. Close the window to stop the server. Double-clicking it again while it is running only opens the browser.

Requires Node.js 22.13+ (tested with 24). On this PC Node is installed at `C:\Program Files\nodejs` but is not on `PATH` in every shell. If `npm` isn't found, run this first in PowerShell: `$env:Path = "C:\Program Files\nodejs;$env:Path"`.

```bash
npm install
npm run dev          # http://localhost:3000 (server + Vite hot reload on one port)
```

1. Open http://localhost:3000, choose **새 수업 만들기**, and enter a title, a teacher name and a PIN. You enter as the teacher.
2. Open **교안**, click **+** → **파일 올리기** and choose a PDF, PowerPoint, images or an HTML page (or drop the files on the page).
3. In another browser or an incognito window, open `http://<your-ip>:3000/room/<code>` (**홈 → 학생 입장 링크 복사**). Enter a name to join as a student. A password is optional and lets the student use the same name and notes on other devices.

Production:

```bash
npm run build        # builds the client into dist/
npm start            # serves dist/ + API + WebSocket on PORT
```

Students on the same Wi-Fi can connect to the `Network:` address that is printed at startup.

## Configuration

Settings are read from `.env` or `env.txt` in the project root (see [.env.example](.env.example)):

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Listen address |
| `DATA_DIR` | `data` | SQLite DB (`study.db`) + uploaded files |
| `MAX_UPLOAD_MB` | `200` | Size limit per uploaded file (교안 PDFs and shared files) |
| `ADMIN_PASSWORD` | *(empty)* | When set, only people who know it can create classes |
| `TRUST_PROXY` | `0` | Set `1` behind nginx/Caddy (HTTPS cookies, real client IPs) |
| `OFFICE_CONVERTER` | `auto` | How Office files become 교안: `auto` (Microsoft Office if installed, else LibreOffice), `msoffice`, `libreoffice` or `off` |
| `SOFFICE_PATH` | *(empty)* | LibreOffice's `soffice` binary, if it isn't on `PATH` or in the usual install folder |
| `OPENAI_API_KEY`, `LLM_MODEL` | *(empty)*, `gpt-4o-mini` | Turns on the AI 도우미 tab. The key is used only on the server. |
| `SCREEN_SHARE` | *(on)* | `off` turns 화면 공유 off |
| `SCREEN_PORT` | `PORT`+1 | 화면 공유 to students on UDP and TCP; the 99 UDP ports after it carry the screen to relay PCs |
| `SCREEN_IP` | *(every IPv4 address)* | Comma-separated addresses to offer students, if the automatic list picks a wrong adapter |
| `SCREEN_DIRECT_SEATS` | `10` | Students the teacher's PC serves before relay PCs get more (a share, not a limit) |
| `RELAY_KEY` | *(generated)* | Password relay PCs connect with. Empty = made once and kept in `DATA_DIR/relay.key` |

## 화면 공유 and relay PCs

The browser only lets a page capture the screen on `localhost` or over HTTPS, so the teacher opens StudyShare on their own PC at `http://localhost:3000` (`run.bat` does). Students use the PC's network address. **홈 → 학생 입장 링크 복사** gives that address even when the teacher is on `localhost`.

Run `firewall.bat` once on the teacher's PC. It asks for administrator rights and opens TCP 3000 (the page), UDP and TCP 3001 (screen to students), and UDP 3002–3100 (screen to relay PCs), on Domain and Private networks only. `firewall.bat remove` undoes it. On a company PC, IT may have to do this, or a group policy may override it.

**How the load works.** The teacher's browser encodes the screen once and sends it to the server, which copies packets to each student without decoding them (an SFU, [mediasoup](https://mediasoup.org)). The teacher's PC therefore does one encode regardless of class size, and forwarding is cheap. Measured on a Ryzen 5 3600 with 30 students and a worst-case 1080p stream at the 2.5 Mbps cap, the forwarding process used about 20% of one CPU core, and the PC sent about 75 Mbps. What grows with the class is **network traffic**: about 2.5 Mbps per student (5 Mbps in 동영상 mode). Compare that to the teacher PC's link speed (`Get-NetAdapter` → LinkSpeed): 30 students fit easily on gigabit Ethernet, but not in 동영상 mode on a 100 Mbps port or over Wi-Fi.

**Relay PCs** add capacity where that runs out. A relay receives the screen once from the teacher's PC and sends it to the students the server assigns to it. Students never pick a PC; they all open the teacher's address. The server puts each new student on the PC with the most free seats (`SCREEN_DIRECT_SEATS` on the teacher's PC, `--seats`, default 30, on a relay). If a relay is switched off, its students move to another PC within seconds. A student who gets no picture through a PC (a firewall, say) is moved too. A relay only helps if it has its own network link: on the same Wi-Fi as the students, it adds traffic instead of removing it.

To add a relay PC:

1. On the teacher's PC, run `npm run relay:bundle` once. This makes `relay-bundle/` (about 100 MB): Node itself, the relay as one script, the mediasoup worker and batch files. Nothing has to be installed on the relay PC.
2. Copy the folder to the spare PC, and run its `firewall.bat` once.
3. Run `run-relay.bat`, and enter the address and key shown under **화면 공유 → 릴레이 PC 연결 방법**. The teacher's sharing panel then lists the PC and its students.

From a checkout with Node installed, `npm run relay -- --origin http://<teacher-pc>:3000 --key <key>` does the same.

## How it works

```
Browser (React + pdf.js)                         Server (Express + Socket.IO + SQLite)
───────────────────────                          ─────────────────────────────────────
PDF rendered locally by pdf.js  ◄── GET /api/docs/:id/file (range requests, auth)
Ink layers = <canvas> over page ◄── strokes:get ── strokes table (per doc/page/layer/owner)
teacher pen  ── ink:live (batches) ──►  relayed to room (not stored)
             ── stroke:add ─────────►  stored, broadcast as stroke:added
student note ── stroke:add ─────────►  stored, sent only to that student's other devices
teacher nav  ── nav ────────────────►  stored on room, broadcast teacher:nav
```

- **Ink is vectors, not video.** Each stroke is a list of points normalized to the page (0–1), and its width is measured in 1/1000 of the page width. Ink therefore stays sharp at any screen size or zoom, a stroke costs a few hundred bytes, late joiners get the full state, and export can redraw it at any resolution.
- **The server is the source of truth.** It stores the teacher's position, the documents and every stroke. On (re)connect each client gets a `snapshot`, so a dropped Wi-Fi connection recovers on its own.
- **Privacy.** Teacher ink goes to the whole room. Personal notes are visible only to their owner, and the server enforces this, as covered by tests. Questions asked anonymously hide the author from everyone, including the teacher.
- **Every 교안 is a PDF or a live page.** Images, Office files and whiteboards are turned into a PDF once, on upload, so the viewer, ink, capture, export and AI context work the same for all of them. Microsoft Office does the conversion through COM automation (`server/office-to-pdf.ps1`, macros disabled, one at a time, with a 3-minute limit; a stuck Office process is ended). Otherwise LibreOffice does it headless. The startup log shows which one is in use (`Office → 교안: PowerPoint, Word, Excel`). HWP needs LibreOffice, ideally with the H2Orestart extension.
- **Live HTML is sandboxed.** The page is served from `/api/site/<id>/<token>/…` into an `<iframe sandbox>` without `allow-same-origin`, and with the same `Content-Security-Policy: sandbox` header in case the URL is opened directly. Its scripts get an opaque origin, so they can't read the app's cookies or call the API as the viewer. Such a frame sends no cookies, so the path carries an HMAC token valid for 1–2 days. A small bridge script (`server/site-bridge.js`) injected into each HTML page reports the slide and scroll position over `postMessage`, which is how students follow and how ink stays on its slide.
- **Page edits keep ink in place.** Inserting or deleting a page writes a new PDF revision (`<id>.r<rev>.pdf`; clients reload it by `rev`). The stored ink and question links on later pages are renumbered in the same transaction, and ink on a deleted page is removed. The original upload in the 파일 tab is never changed.
- **One file list.** Every upload is a row in `files`. A 교안 also has a `documents` row with the same id, so it shows in both tabs, and deleting it from either tab removes both, with any converted PDF or unpacked HTML site. 교안 PDFs uploaded before the 파일 tab existed are added to `files` automatically on startup.
- **Safe file serving.** Downloads are always `Content-Disposition: attachment` with `nosniff`. Previews are allowed only for raster images, PDFs and text, and text is served as sandboxed `text/plain`, so an uploaded `.html` or `.svg` can never run in the app's origin. ZIPs are streamed with stored (uncompressed) entries, using CRCs computed at upload, so there's no extra dependency and the browser shows real progress.
- **Security.** PINs and passwords are hashed with scrypt. Sessions use HTTP-only, SameSite cookies, and only a SHA-256 of the token is stored. Wrong PINs are rate-limited. Cross-origin WebSockets are rejected. Every socket event is validated with zod and authorized by role and room.

```
server/   index.ts (HTTP + Vite/dist) · api.ts (REST, uploads, downloads) · realtime.ts (Socket.IO events)
          repo.ts / db.ts (SQLite) · auth.ts · schemas.ts · ai.ts (OpenAI streaming) · zip.ts (streaming ZIP)
          convert.ts (images/Office/whiteboards → PDF, page edits) · office-to-pdf.ps1 (Microsoft Office)
          site.ts + site-bridge.js (live HTML) · unzip.ts
          screen.ts (화면 공유: shares, relay PCs, which PC serves whom) · media.ts (mediasoup, also used by relays)
          relay.ts (relay PC program) · relay-bundle.ts (npm run relay:bundle)
client/   src/screen.ts (capture, send, receive, switch PC) · components/ScreenShare.tsx (화면 공유 UI)
          src/components/PdfViewer.tsx · HtmlViewer.tsx · InkLayers.tsx (drawing) · LecturePane.tsx (toolbar)
          FilesPane.tsx (파일) · lecture.ts (adding 교안 and pages) · frame.ts (talks to the HTML frame)
          Questions / Chat / AiPanel / Room / Lobby / Modal · store.ts (zustand) · socket.ts · export.ts
shared/   protocol.ts (types shared by both sides) · files.ts (file kinds, preview rules)
relay/    run-relay.bat · firewall.bat · README.txt (copied into relay-bundle/)
firewall.bat + firewall.ps1   open Windows Firewall for the page and 화면 공유
```

## Suggested next steps

- **Lecture replay.** Every page change and stroke is already an event. Storing them with timestamps, plus the teacher's audio, would let students replay the class with the ink appearing in sync, at a fraction of the size of a screen recording.
- **Assignment submission.** The 파일 tab is teacher → students only. A per-student upload box (과제 제출), visible only to the teacher, would reuse the same storage, the download-stats table, and ZIP-all for grading.
- **AI controls for the teacher.** Add a switch to turn AI 도우미 off during quizzes, and an "AI answer draft" button on student questions.
- **Scale-out.** One Node process handles a classroom comfortably. For many simultaneous classes, add the Socket.IO Redis adapter and move SQLite to Postgres.
- **More tools.** Highlighter, shapes, zoom and pan for dense pages, and a page-thumbnail sidebar.
- **Richer HTML sync.** Slides are followed through the URL hash, reveal.js and scrolling. A deck that keeps its slide only in JavaScript state could report it through a tiny opt-in API (e.g. `postMessage({type: 'ss:slide', n})`). Uploading a folder directly, instead of a ZIP, would also help.
- **PowerPoint animations.** Conversion keeps each slide's final state. Exporting every animation step as its own page would let the teacher reveal bullets one by one.
- **HTTPS deployment.** Put the server behind Caddy or nginx with `TRUST_PROXY=1`. HTTPS also unlocks clipboard copy on LAN IP addresses.
