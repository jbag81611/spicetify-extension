// NAME: LocalCast
// DESCRIPTION: Spotify Connect로 스피커에서 듣다가 로컬파일 차례가 되면 AirPlay 2로 자동 전송하고, 스포티파이 곡이 나오면 다시 Connect로 돌려놓습니다.
// 필요: 같은 PC에서 localcast_helper.py 실행 중
// v4: 곡 매칭 강화(제목/아티스트, 대기열 기준 역추적), 셔플 지원, 전환 딜레이 단축

(async function LocalCast() {
  "use strict";

  while (!(window.Spicetify && Spicetify.Player && Spicetify.Player.addEventListener &&
           Spicetify.Platform && Spicetify.CosmosAsync && Spicetify.showNotification)) {
    await new Promise((r) => setTimeout(r, 300));
  }

  const VERSION = "v52.7-airplay";
  const HELPER = "http://127.0.0.1:8765";
  const STORE_KEY = "localcast:enabled";
  const TAG = "[LocalCast]";
  const TICK_MS = 200;

  let cfg = { speaker_name: "Aura Studio 5", pc_device_name: "", switch_lead_ms: 800, max_speaker_volume: 50 };
  const maxSpk = () => { const v = Number(cfg.max_speaker_volume); return (isFinite(v) && v >= 5 && v <= 100 ? v : 50) / 100; };
  let lastCapNote = 0;
  function capNotice() {
    if (Date.now() - lastCapNote > 5000) { lastCapNote = Date.now(); notify(`오라스튜디오 최대 볼륨 ${Math.round(maxSpk() * 100)}%`); }
  }
  let enabled = readEnabled();
  let helperOk = false;
  let lastHelperCheck = 0;
  let mode = "idle";            // idle | connect | cast | pc
  let busy = false;
  let enteringCast = false;
  let lastLocal = null;         // 마지막으로 본 로컬파일 재생 위치 {uri, prog, dur}     // 로컬파일로 넘어가는 중 (AirPlay를 먼저 시작해 둔 상태)
  let ticking = false;
  let speakerId = null;         // 돌아갈 스피커(Connect) 기기 id
  let castedUri = null;         // 지금 캐스트 중인(또는 시작한) 로컬파일
  let castFailUri = null;       // 캐스트 실패한 곡 (재시도 방지)
  let fromKey = null;           // PC로 넘어갈 때 재생 중이던 스포티파이 곡
  let switchedFor = null;       // 이 곡(key)에서 이미 전환함
  let enterFailAt = 0;
  let skippedFail = null;
  let internalPlay = 0;         // LocalCast가 직접 재생 명령을 보내는 중 (가로채기 제외)
  let lastSync = 0;
  let lastVol = null;
  const SPKVOL_KEY = "localcast:spkvol";
  let lastSpeakerVol = (() => { try { const v = parseFloat(localStorage.getItem(SPKVOL_KEY)); return isNaN(v) ? null : v; } catch (e) { return null; } })();
  function rememberSpeakerVol(v) {
    if (typeof v !== "number" || v < 0 || v > 1 || Math.abs(v - (lastSpeakerVol ?? -1)) < 0.004) return;
    lastSpeakerVol = v;
    try { localStorage.setItem(SPKVOL_KEY, String(v)); } catch (e) { /* 무시 */ }
  }
  let volHoldUntil = 0;
  let pcSince = 0;              // PC가 재생 기기가 된 시각 (볼륨 복원은 확실할 때만)         // AirPlay 시작 직후: PC 볼륨이 스피커로 새어 나가지 않게 잠시 고정
  let plan = null;              // { key, row, ctxUri, queueNextUri, why }
  let endTimerKey = null;
  let userLocalQueue = [];      // 스피커 연결 중 "대기열에 추가/다음에 재생"한 로컬파일 (Connect가 버리므로 따로 기억)
  let lastPlanMsg = "";
  // PC 스피커 볼륨과 AirPlay(오라스튜디오) 볼륨 분리:
  // AirPlay 중에는 Spotify 볼륨바가 스피커 볼륨을 조절하고, 끝나면 PC 볼륨을 원래대로 되돌림.
  // Spotify가 중간에 꺼져도 다음에 되돌릴 수 있게 저장해 둠.
  const PCVOL_KEY = "localcast:pcvol";
  const LASTPC_KEY = "localcast:lastpcvol";
  let lastPcVol = (() => { try { const v = parseFloat(localStorage.getItem(LASTPC_KEY)); return isNaN(v) ? null : v; } catch (e) { return null; } })();
  function rememberPcVol(v) {
    if (typeof v !== "number" || v < 0 || v > 1 || Math.abs(v - (lastPcVol ?? -1)) < 0.004) return;
    lastPcVol = v;
    try { localStorage.setItem(LASTPC_KEY, String(v)); } catch (e) { /* 무시 */ }
  }
  let pcVolBefore = (() => { try { const v = parseFloat(localStorage.getItem(PCVOL_KEY)); return isNaN(v) ? null : v; } catch (e) { return null; } })();
  function savePcVol(v) {
    pcVolBefore = v;
    try { if (typeof v === "number") localStorage.setItem(PCVOL_KEY, String(v)); else localStorage.removeItem(PCVOL_KEY); } catch (e) { /* 무시 */ }
  }
  // ───────── 볼륨 안전장치: PC 볼륨이 절대 스피커로 가지 않게 ─────────
  // Spotify 볼륨 명령(setVolume)은 "지금 재생 기기"에 적용됨 → 명령 직전에 재생 기기를 반드시 확인
  const bootAt = Date.now();
  const connState = () => { const c = Spicetify.Platform && Spicetify.Platform.ConnectAPI; return c && c.state; };
  const devIdOf = (d) => d && (d.id || d.deviceId || d.identifier);
  function activeIdNow() {
    const st = connState();
    if (!st) return null;
    const a = devIdOf(st.activeDevice);
    if (a) return a;
    const raw = st.devices || [];
    const arr = Array.isArray(raw) ? raw : Object.values(raw);
    return devIdOf(arr.find((d) => d && d.isActive)) || null;
  }
  function localIdNow() {
    const st = connState();
    if (!st) return null;
    const raw = st.devices || [];
    const arr = Array.isArray(raw) ? raw : Object.values(raw);
    const l = arr.find((d) => d && d.isLocal);
    if (l) return devIdOf(l);
    const byName = arr.find((d) => d && cfg.pc_device_name && norm(d.name || "") === norm(cfg.pc_device_name));
    return byName ? devIdOf(byName) : null;
  }
  const isPcActiveNow = () => { const a = activeIdNow(), l = localIdNow(); return !!a && !!l && a === l; };
  // 사용자가 볼륨바/음소거/단축키를 직접 만졌는지 (그 외의 볼륨 변화는 의심)
  let userVolAt = 0, volDrag = false;
  const userVol = (ms = 1500) => volDrag || Date.now() - userVolAt < ms;
  const VOLSEL = '[data-testid="volume-bar"], .volume-bar, .main-nowPlayingBar-volumeBar, .volume-bar__icon-button, [data-testid="volume-bar-toggle-mute-button"], [aria-label*="볼륨"], [aria-label*="olume"], [aria-label*="음소거"]';
  const onVolUi = (e) => { try { const t = e.target; return !!(t && t.closest && t.closest(VOLSEL)); } catch (x) { return false; } };
  document.addEventListener("pointerdown", (e) => { if (onVolUi(e)) { volDrag = true; userVolAt = Date.now(); } }, true);
  document.addEventListener("pointermove", () => { if (volDrag) userVolAt = Date.now(); }, true);
  const endDrag = () => { if (volDrag) { volDrag = false; userVolAt = Date.now(); } };
  document.addEventListener("pointerup", endDrag, true);
  document.addEventListener("pointercancel", endDrag, true);
  document.addEventListener("wheel", (e) => { if (onVolUi(e)) userVolAt = Date.now(); }, true);
  document.addEventListener("keydown", (e) => {
    if (onVolUi(e) || ((e.ctrlKey || e.metaKey) && /^Arrow(Up|Down)$/.test(e.key)) || /^Audio(Volume|Mute)/.test(e.key || "")) userVolAt = Date.now();
  }, true);
  // 지정한 기기가 지금 재생 기기일 때만 볼륨을 바꿈 (아니면 아무것도 안 함 → 다른 기기로 새지 않음)
  function setVolIfActive(id, v) {
    if (!id || typeof v !== "number") return false;
    if (activeIdNow() !== id) return false;
    try { Spicetify.Player.setVolume(v); return true; } catch (e) { return false; }
  }
  // 스피커 볼륨 지키기: 전환 직후 일정 시간 동안 스피커 볼륨이 PC 볼륨 쪽으로 바뀌면 되돌림
  let spkGuard = null;   // { until, vol }
  function guardSpeaker(vol, ms) { if (typeof vol === "number") spkGuard = { until: Date.now() + ms, vol: Math.min(vol, maxSpk()) }; }
  const nearPc = (v) => [pcVolBefore, lastPcVol].some((p) => typeof p === "number" && Math.abs(v - p) < 0.015);
  // 스피커가 재생 기기가 된 뒤 원하는 볼륨이 확실히 걸릴 때까지 확인
  async function enforceSpeakerVol(id, vol, ms = 3500) {
    if (!id || typeof vol !== "number") return;
    vol = Math.min(vol, maxSpk());
    const end = Date.now() + ms;
    let stable = 0;
    while (Date.now() < end && stable < 3) {
      if (activeIdNow() === id) {
        const cv = Spicetify.Player.getVolume();
        if (typeof cv === "number" && Math.abs(cv - vol) > 0.01 && !userVol()) { setVolIfActive(id, vol); stable = 0; }
        else stable++;
      }
      await sleep(250);
    }
    guardSpeaker(vol, 6000);
  }

  // PC가 재생 기기일 때만 복원 (아니면 기억해 두고 나중에 PC가 재생 기기가 되면 복원)
  function restorePcVol(why) {
    if (typeof pcVolBefore !== "number") return false;
    if (Date.now() - bootAt < 8000) return false;          // Spotify가 막 켜짐: 기기 정보가 아직 부정확할 수 있음
    const lid = localIdNow();
    if (!setVolIfActive(lid, pcVolBefore)) return false;
    log(`PC 볼륨 복원 ${Math.round(pcVolBefore * 100)}% (${why})`);
    savePcVol(null);
    return true;
  }

  // 셔플용 기록
  let shuffleCtx = null;
  let playedLocals = new Set();
  let spotifyPlayed = 0;
  let lastSongKey = null;

  // ───────── 기본 유틸 ─────────
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => String(s || "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
  const errMsg = (e) => String(e && e.message ? e.message : e);

  function readEnabled() { try { return localStorage.getItem(STORE_KEY) !== "0"; } catch (e) { return true; } }
  function saveEnabled(v) { try { localStorage.setItem(STORE_KEY, v ? "1" : "0"); } catch (e) { /* 무시 */ } }
  function log(...a) {
    console.log(TAG, ...a);
    const msg = a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ");
    helper("/log", { msg }, 1500).catch(() => {});
  }
  function notify(msg, isError) {
    try { Spicetify.showNotification("LocalCast: " + msg, !!isError, 3500); } catch (e) { /* 무시 */ }
  }
  async function helper(path, body, timeoutMs = 8000, retry = /^\/(stop|mute|volume)$/.test(path)) {
    try { return await helperOnce(path, body, timeoutMs); }
    catch (e) {
      if (!retry) throw e;
      await sleep(400);
      return await helperOnce(path, body, timeoutMs);
    }
  }
  async function helperOnce(path, body, timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(HELPER + path, body === undefined
        ? { signal: ctrl.signal }
        : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: ctrl.signal });
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }
  async function checkHelper() {
    lastHelperCheck = Date.now();
    try {
      const r = await helper("/config", undefined, 2000);
      if (r && r.ok) {
        cfg = { ...cfg, ...r };
        const was = helperOk;
        helperOk = true;
        if (!was) log(`확장 연결됨 (${VERSION})`);
        return true;
      }
    } catch (e) { /* 꺼져 있음 */ }
    if (helperOk) notify("보조 프로그램 연결이 끊겼어요", true);
    helperOk = false;
    return false;
  }
  async function waitFor(fn, timeoutMs, stepMs = 70) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      try { if (await fn()) return true; } catch (e) { /* 계속 */ }
      await sleep(stepMs);
    }
    return false;
  }

  // ───────── 곡 정보 ─────────
  const isLocalTrack = (t) => !!t && (t.isLocal === true || String(t.uri || "").startsWith("spotify:local:"));
  const isPlayable = (t) => !!t && /^spotify:(track|episode|local):/.test(String(t.uri || ""));
  const keyOf = (t) => (t ? (t.uid || "") + "|" + t.uri : null);
  const normUri = (u) => { try { return decodeURIComponent(String(u || "").replace(/\+/g, " ")).normalize("NFC").toLowerCase(); } catch (e) { return String(u || "").toLowerCase(); } };
  const sameTrack = (a, b) => !!a && !!b && normUri(a) === normUri(b);
  const localTitle = (u) => { const p = String(u || "").split(":"); return p.length >= 5 ? normUri(p[4]) : ""; };
  const localPart = (u, i) => { const p = String(u || "").split(":"); try { return p.length > i ? decodeURIComponent(p[i].replace(/\+/g, " ")) : ""; } catch (e) { return p[i] || ""; } };
  const nameOf = (t) => (t && (t.name || (t.metadata && t.metadata.title) || t.title)) || "";
  const msOf = (t) => (t && ((t.duration && t.duration.milliseconds) || (t.metadata && Number(t.metadata.duration)) || t.ms)) || 0;
  const artistOf = (t) => (t && ((t.artists && t.artists[0] && t.artists[0].name) || (t.metadata && t.metadata.artist_name) || t.artist)) || "";
  const cur = () => (Spicetify.Player.data && Spicetify.Player.data.item) || null;
  const isShuffle = (d) => {
    try { return !!(d && (d.shuffle || d.smartShuffle)) || !!(Spicetify.Player.getShuffle && Spicetify.Player.getShuffle()); } catch (e) { return false; }
  };
  const playlistOf = (uri) => { const m = String(uri || "").match(/^spotify:(?:user:[^:]+:)?playlist:([A-Za-z0-9]+)/); return m ? "spotify:playlist:" + m[1] : null; };

  function nextItems() {
    const d = Spicetify.Player.data;
    if (d && Array.isArray(d.nextItems) && d.nextItems.length) return d.nextItems;
    try { const q = Spicetify.Platform.PlayerAPI._queue._queueState; return [...(q.queued || []), ...(q.nextUp || [])]; } catch (e) { return []; }
  }
  const nextTrack = () => nextItems().find(isPlayable) || null;

  function planLog(msg) { if (msg !== lastPlanMsg) { lastPlanMsg = msg; log("[판단] " + msg); } }

  // ───────── 기기 (Spotify 앱 내부 Connect 목록) ─────────
  async function devices() {
    const list = [];
    const c = Spicetify.Platform.ConnectAPI;
    let st = c && c.state;
    try { if (!st && c && typeof c.getState === "function") st = await c.getState(); } catch (e) { /* 무시 */ }
    if (st) {
      const raw = st.devices || [];
      const arr = Array.isArray(raw) ? raw : Object.values(raw);
      const act = st.activeDevice || null;
      const idOf = (d) => d && (d.id || d.deviceId || d.identifier);
      const actId = idOf(act);
      for (const d of arr) {
        const id = idOf(d);
        if (!id || list.some((x) => x.id === id)) continue;
        list.push({ id, name: d.name || "", type: d.type || "", active: !!(d.isActive || (actId && id === actId)), local: !!d.isLocal, volume: typeof d.volume === "number" ? d.volume : null });
      }
      if (actId && !list.some((x) => x.id === actId)) list.push({ id: actId, name: act.name || "", type: act.type || "", active: true, local: !!act.isLocal });
    }
    if (!list.length) {
      try {
        const r = await Spicetify.CosmosAsync.get("https://api.spotify.com/v1/me/player/devices");
        for (const d of (r && r.devices) || []) list.push({ id: d.id, name: d.name, type: d.type, active: !!d.is_active, local: false });
      } catch (e) { /* 무시 */ }
    }
    return list;
  }
  const isSpeaker = (d) => !!d && !!cfg.speaker_name && norm(d.name).includes(norm(cfg.speaker_name));
  function localId(list) {
    const l = list.find((d) => d.local);
    if (l) return l.id;
    const byName = list.find((d) => cfg.pc_device_name && norm(d.name) === norm(cfg.pc_device_name));
    return byName ? byName.id : null;
  }
  const activeIs = async (id) => ((await devices()).find((d) => d.active) || {}).id === id;

  async function transferTo(id, play = true) {
    try {
      const c = Spicetify.Platform.ConnectAPI;
      if (c && typeof c.transferPlayback === "function") {
        await c.transferPlayback(id, {});
        if (await waitFor(() => activeIs(id), 5000)) return true;
      }
    } catch (e) { log("ConnectAPI 전환 오류: " + errMsg(e)); }
    try { await Spicetify.CosmosAsync.put("https://api.spotify.com/v1/me/player", { device_ids: [id], play }); } catch (e) { /* 확인으로 판단 */ }
    return await waitFor(() => activeIs(id), 5000);
  }

  // ───────── 재생목록 (로컬파일 포함 원래 순서) ─────────
  let plCache = { uri: null, t: 0, rows: [] };
  let rowKeysLogged = false;
  async function playlistRows(uri) {
    if (plCache.uri === uri && Date.now() - plCache.t < 60000) return plCache.rows;
    const rows = [];
    for (let offset = 0; offset < 10000; offset += 100) {
      const page = await Spicetify.Platform.PlaylistAPI.getContents(uri, { limit: 100, offset });
      const items = (page && page.items) || [];
      if (!rowKeysLogged && items[0]) { rowKeysLogged = true; log("[진단] 재생목록 항목 필드: " + Object.keys(items[0]).join(",")); }
      for (const r of items) {
        rows.push({
          uid: r.uid, uri: r.uri, name: nameOf(r), ms: msOf(r), artist: artistOf(r),
          album: (r.album && r.album.name) || "",
          isLocal: !!r.isLocal || String(r.uri || "").startsWith("spotify:local:"),
        });
      }
      if (items.length < 100) break;
    }
    plCache = { uri, t: Date.now(), rows };
    return rows;
  }

  // 스피커 재생 중에는 같은 곡이 다른 ID로 나올 수 있어서 제목·아티스트·길이로도 비교
  function scoreRow(r, it) {
    if (!r || !it) return 0;
    if (r.uid && it.uid && r.uid === it.uid) return 100;
    if (sameTrack(r.uri, it.uri)) return 90;
    const rn = norm(r.name), iname = norm(nameOf(it));
    if (!rn || !iname || rn !== iname) return 0;
    let s = 50;
    const ra = norm(r.artist), ia = norm(artistOf(it));
    if (ra && ia) s += ra === ia || ra.includes(ia) || ia.includes(ra) ? 20 : -15;
    const a = r.ms, b = msOf(it);
    if (a && b) s += Math.abs(a - b) < 4000 ? 15 : -5;
    return s;
  }
  function findRow(rows, it, near = -1) {
    let best = -1, bestScore = 0;
    rows.forEach((r, k) => {
      const s = scoreRow(r, it) + (near >= 0 && k > near ? 1 : 0);
      if (s > bestScore) { bestScore = s; best = k; }
    });
    return bestScore >= 40 ? best : -1;
  }

  // 순서대로 재생할 때: 지금 곡과 (스피커 대기열의) 다음 곡 사이에 로컬파일이 있는지
  async function planOrdered(ctxUri, item, qNext) {
    const rows = await playlistRows(ctxUri);
    const tag = nameOf(item);
    const ci = findRow(rows, item);
    if (ci >= 0 && rows[ci + 1] && rows[ci + 1].isLocal) {
      return { row: rows[ci + 1], why: `${tag}(${ci + 1}번) 다음 로컬파일 ${rows[ci + 1].name}` };
    }
    // 지금 곡을 못 찾았거나 다음이 로컬이 아니면, 대기열의 다음 곡 바로 앞에 로컬파일이 있는지 역추적
    const ni = qNext ? findRow(rows, qNext, ci) : -1;
    if (ni > 0 && rows[ni - 1].isLocal && (ci < 0 || ci < ni - 1)) {
      let k = ni - 1;
      while (k - 1 >= 0 && rows[k - 1].isLocal && (ci < 0 || k - 1 > ci)) k--;
      return { row: rows[k], why: `대기열 다음 곡 ${nameOf(qNext)}(${ni + 1}번) 앞의 로컬파일 ${rows[k].name}` };
    }
    if (ci < 0 && ni < 0) {
      planLog(`${tag} → 재생목록(${rows.length}곡)에서 지금 곡·다음 곡 모두 못 찾음 [지금 ${nameOf(item)} / ${artistOf(item)} / ${item.uri}] [다음 ${qNext ? nameOf(qNext) + " / " + qNext.uri : "없음"}]`);
    } else {
      planLog(`${tag} → 다음은 로컬파일 아님 (지금 ${ci + 1}번, 대기열 다음 ${ni + 1}번 / 전체 ${rows.length}곡)`);
    }
    return null;
  }

  // 셔플일 때: 남은 로컬파일 비율만큼 확률적으로 끼워 넣기 (곡마다 한 번만 결정)
  async function planShuffle(ctxUri, item) {
    const rows = await playlistRows(ctxUri);
    if (shuffleCtx !== ctxUri) { shuffleCtx = ctxUri; playedLocals = new Set(); spotifyPlayed = 0; }
    let locals = rows.filter((r) => r.isLocal && !playedLocals.has(normUri(r.uri)));
    if (!locals.length && rows.some((r) => r.isLocal)) { playedLocals = new Set(); locals = rows.filter((r) => r.isLocal); }
    if (!locals.length) { planLog(`${nameOf(item)} → 셔플: 재생목록에 로컬파일 없음`); return null; }
    const spotifyLeft = Math.max(1, rows.filter((r) => !r.isLocal).length - spotifyPlayed);
    const p = locals.length / (locals.length + spotifyLeft);
    if (Math.random() < p) {
      const row = locals[Math.floor(Math.random() * locals.length)];
      return { row, why: `셔플: ${Math.round(p * 100)}% 확률로 로컬파일 ${row.name} 선택` };
    }
    planLog(`${nameOf(item)} → 셔플: 이번엔 스포티파이 곡 (로컬파일 확률 ${Math.round(p * 100)}%)`);
    return null;
  }

  async function makePlan(data, item) {
    const key = keyOf(item);
    if (plan && plan.key === key) return plan;       // 곡마다 한 번만 결정 (셔플 확률 고정)
    const ctxUri = playlistOf(data.context && data.context.uri);
    const qNext = nextTrack();
    let p = null;
    const n0 = nextItems()[0];
    const spotifyQueued = !!(n0 && n0.provider === "queue");   // 사용자가 대기열에 넣은 스포티파이 곡이 먼저
    if (userLocalQueue.length && !spotifyQueued) {
      p = { row: userLocalQueue[0], why: "대기열에 추가한 로컬파일 " + userLocalQueue[0].name };
    } else if (qNext && isLocalTrack(qNext)) {
      p = { row: { uri: qNext.uri, uid: qNext.uid, name: nameOf(qNext) }, why: "대기열 다음 곡이 로컬파일" };
    } else if (!ctxUri) {
      planLog(`${nameOf(item)} → 재생목록에서 재생 중이 아님`);
    } else if (!Spicetify.Platform.PlaylistAPI || !Spicetify.Platform.PlaylistAPI.getContents) {
      planLog("PlaylistAPI 없음");
    } else {
      try {
        p = isShuffle(data) ? await planShuffle(ctxUri, item) : await planOrdered(ctxUri, item, qNext);
      } catch (e) { planLog("재생목록 읽기 실패: " + errMsg(e)); }
    }
    plan = { key, ctxUri, queueNextUri: qNext ? qNext.uri : null, queueNextName: qNext ? nameOf(qNext) : null, row: p ? p.row : null };
    if (p) planLog(`${nameOf(item)} → ${p.why} (곡 끝 ${cfg.switch_lead_ms}ms 전에 전환)`);
    return plan;
  }

  // ───────── 전환 동작 ─────────
  function castBody(src, positionMs, paused, volume) {
    return {
      volume: typeof volume === "number" ? volume : Spicetify.Player.getVolume(),
      uri: src.uri,
      title: nameOf(src) || localTitle(src.uri),
      artist: artistOf(src),
      album: (src.album && (src.album.name || src.album)) || "",
      duration_ms: msOf(src),
      position_ms: positionMs || 0,
      paused: !!paused,
      ctx: castCtx || playlistOf(Spicetify.Player.data && Spicetify.Player.data.context && Spicetify.Player.data.context.uri) || null,
    };
  }

  // ───────── 스피커 지연 보정 (가사·재생바 = 실제로 들리는 소리) ─────────
  // AirPlay는 보낸 소리가 스피커에서 D ms 뒤에 들림. 그래서
  //  · 새로 틀 때: 소리가 실제로 나올 때까지 Spotify 재생바를 그 위치에 잠깐 멈춰 둠(hold)
  //  · 탐색/다시 재생: Spotify 재생바를 D만큼 앞(과거)으로 옮겨, 소리가 나는 순간 정확히 그 위치에 오게 함
  //  · 보조 프로그램에 알리는 위치 = Spotify 위치 + D
  const audioDelay = () => { const v = Number(cfg.audio_delay_ms); return isFinite(v) && v >= 0 && v <= 6000 ? v : 1700; };
  let hold = null;               // { uri, pos, until }
  let ignoreJumpUntil = 0;       // 우리가 옮긴 재생 위치는 사용자 탐색으로 보지 않음
  const holding = () => !!hold;
  function internalSeek(ms) {
    ignoreJumpUntil = Date.now() + 1500;
    seekWatch = null;
    try { Spicetify.Player.seek(Math.max(0, Math.round(ms))); } catch (e) { /* 무시 */ }
  }
  function holdAt(uri, pos, ms) {
    hold = { uri, pos: Math.max(0, pos), until: Date.now() + Math.max(0, ms) };
    ignoreJumpUntil = hold.until + 1500;
    seekWatch = null;
  }
  setInterval(() => {
    if (!hold) return;
    try {
      const it = cur();
      const d = Spicetify.Player.data;
      const mine = it && sameTrack(it.uri, hold.uri);
      // 로컬파일로 넘어가는 중(enteringCast)엔 아직 이전 곡이 보일 수 있어 기다림
      if (!enteringCast && (mode !== "cast" || (it && !mine && !isLocalTrack(it)))) { hold = null; return; }
      if (Date.now() > hold.until + 8000) { hold = null; return; }
      if (Date.now() < hold.until) {
        // 소리가 나오기 전: 재생바를 시작 위치에 멈춰 둠 (PC는 음소거라 소리 영향 없음)
        if (mine && d && !d.isPaused) { try { Spicetify.Player.pause(); } catch (e) { /* 무시 */ } }
        if (mine && Math.abs(Spicetify.Player.getProgress() - hold.pos) > 400) internalSeek(hold.pos);
        return;
      }
      const h = hold;
      hold = null;
      if (!mine) { if (enteringCast) hold = { ...h, until: Date.now() + 100 }; return; }
      internalSeek(h.pos);
      internalPlay++;
      try { Spicetify.Player.play(); } catch (e) { /* 무시 */ } finally { setTimeout(() => internalPlay--, 300); }
      lastPausedSeen = false;
      lastSync = Date.now();
    } catch (e) { hold = null; }
  }, 50);
  // 스피커 소리를 P부터 다시 시작 (탐색·다시 재생). Spotify 재생바는 소리가 날 때 정확히 P에 오도록 맞춤
  async function restartAudioAt(it, P, seek) {
    // 재생바를 뒤로 돌리지 않음: 누른 위치(P)에 잠깐 세워 뒀다가 스피커에서 소리가 나오는 순간 함께 출발
    holdAt(it.uri, P, audioDelay());
    const r = await helper("/sync", { position_ms: P, paused: false, uri: it.uri, seek }, 15000).catch(() => null);
    lastSync = Date.now();
    return r;
  }

  function startCast(src, positionMs, paused, volume, holdStart = true) {
    castedUri = src.uri;
    playedLocals.add(normUri(src.uri));
    const body = castBody(src, positionMs, paused, volume);
    return helper("/cast", body, 30000).then((r) => {
      lastSync = Date.now();
      if (r && r.ok) {
        log("AirPlay 시작: " + body.title);
        // 소리는 지금부터 D ms 뒤에 스피커에서 나옴 → 그때까지 재생바를 시작 위치에 멈춰 둠 (가사 싱크)
        if (holdStart && !paused && (mode === "cast" || enteringCast) && sameTrack(castedUri, src.uri)) holdAt(src.uri, positionMs, audioDelay());
        // 그사이 스포티파이 곡으로 돌아갔으면 늦게 시작된 AirPlay를 바로 끔
        if (!enteringCast && (mode !== "cast" || !sameTrack(castedUri, src.uri))) {
          if (mode !== "cast") { log("늦게 시작된 AirPlay 정리"); helper("/stop", {}, 15000).catch(() => {}); }
        }
        return true;
      }
      if (r && String(r.error || "").includes("취소")) return false;
      const why = r && r.error === "not_found" ? "PC에서 파일을 찾지 못했어요"
        : r && r.error === "unsupported_format" ? "지원하지 않는 파일 형식이에요"
        : "AirPlay 전송 실패 (" + (r && r.error) + ")";
      castFailUri = src.uri;
      if (sameTrack(castedUri, src.uri)) castedUri = null;
      notify(`${why}: ${body.title} → 다음 곡으로`, true);
      log(why, body);
      return false;
    }).catch((e) => {
      if (sameTrack(castedUri, src.uri)) castedUri = null;
      castFailUri = src.uri;
      log("AirPlay 요청 오류 " + errMsg(e));
      return false;
    });
  }

  // row: 재생할 로컬파일 {uid, uri, name...}, ctxUri: 재생목록, manual: 오른쪽 클릭
  // keepPlaying: PC에서 이미 재생 중인 로컬파일을 끊지 않고 그 위치부터 스피커로 보냄
  let castCtx = null;   // 로컬파일을 틀 때의 재생목록 (Spotify를 다시 켰을 때 이어받기용)
  async function enterCast({ row, ctxUri = null, manual = false, keepPlaying = false, reason = "" }) {
    if (!manual && Date.now() - enterFailAt < 8000) return false;
    if (!manual && peers.length) { log(`[진단] 다른 PC(${peers.map((p) => p.host).join(", ")})가 이미 AirPlay 중 → 자동 전환 안 함`); return false; }
    castCtx = ctxUri || playlistOf(Spicetify.Player.data && Spicetify.Player.data.context && Spicetify.Player.data.context.uri) || castCtx;
    busy = true;
    let entered = false;
    enteringCast = true;
    const t0 = Date.now();
    const before = cur();
    fromKey = before && !isLocalTrack(before) ? keyOf(before) : null;
    if (!ctxUri) ctxUri = playlistOf(Spicetify.Player.data && Spicetify.Player.data.context && Spicetify.Player.data.context.uri);
    try {
      const list = await devices();
      const lid = localId(list);
      const act = list.find((d) => d.active);
      // 곡이 바뀌는 순간 Spotify가 재생 기기 정보를 잠깐 비울 때가 있음 → Connect 중이었으면 스피커로 간주
      const assumeSpk = !act && mode === "connect" && !!speakerId;
      if (!manual && !assumeSpk && (!act || !isSpeaker(act))) {
        log(`[진단] 전환 취소: 지금 재생 기기 ${act ? act.name : "알 수 없음"}`);
        return false;
      }
      if (!lid) throw new Error("이 PC를 Spotify 기기 목록에서 찾지 못했어요");
      if (act && isSpeaker(act)) speakerId = act.id;
      if (!speakerId) {
        const sp = list.find(isSpeaker);
        if (!sp) throw new Error("스피커가 Spotify 기기 목록에 없어요");
        speakerId = sp.id;
      }
      log(`PC로 전환 → ${reason}`);
      // 딜레이 단축: 캐스트 시작, 음소거, PC 전환을 동시에
      castFailUri = null;
      // 스피커 볼륨 그대로 AirPlay로 (PC Spotify 볼륨이 100%여도 스피커가 커지지 않게)
      const spk = list.find((d) => d.id === speakerId);
      let spkVol;
      if (act && isSpeaker(act)) spkVol = Spicetify.Player.getVolume();
      else {
        // PC에서 스피커로 옮길 때: 스피커에서 마지막으로 듣던 볼륨 (둘 중 작은 값 → 절대 크게 시작 안 함)
        const c = [lastSpeakerVol, spk && spk.volume].filter((v) => typeof v === "number" && v >= 0 && v <= 1);
        spkVol = c.length ? Math.min(...c) : null;
      }
      if (typeof spkVol !== "number" || spkVol < 0 || spkVol > 1) spkVol = 0.2;
      spkVol = Math.min(spkVol, maxSpk());
      log(`스피커 볼륨 ${Math.round(spkVol * 100)}%로 시작`);
      const startPos = keepPlaying ? Spicetify.Player.getProgress() : 0;  // 소리가 날 때까지 재생바를 멈춰 두므로 그 위치 그대로
      // 스피커가 Connect로 재생 중이면 먼저 PC로 옮긴 뒤 AirPlay 시작
      // (Connect 재생 중에 AirPlay를 걸면 스피커가 응답하지 않음)
      const speakerStreaming = !!(act && isSpeaker(act)) || assumeSpk;
      let castP = null;
      const castNow = () => { castP = startCast(row, startPos, keepPlaying && !!(Spicetify.Player.data && Spicetify.Player.data.isPaused), spkVol); };
      if (!speakerStreaming) castNow();
      // 스피커에서 다음 곡으로 넘어가 버리기 전에 멈춰 두고 PC로 옮김 (다음 음원이 잠깐 보이지 않게)
      if (speakerStreaming && !keepPlaying) { try { Spicetify.Player.pause(); } catch (e) { /* 무시 */ } }
      const muteP = helper("/mute", { mute: true }).catch(() => {});
      if (!act || act.id !== lid) {
        if (speakerStreaming && !castP) {
          // 스피커는 이미 멈춘 상태 → PC로 옮기라는 명령이 들어가면 기다리지 않고 AirPlay 연결 시작 (딜레이 단축)
          const tp = transferTo(lid, false);
          await sleep(300);
          if (!castP) castNow();
          const ok = await tp;
          if (!ok) throw new Error("PC로 재생 전환 실패");
        } else {
          const ok = await transferTo(lid, false);
          if (!ok) throw new Error("PC로 재생 전환 실패");
        }
      }
      await muteP;
      if (!castP) castNow();   // PC로 넘어오자마자 바로 AirPlay 연결 (대기 없음)
      mode = "cast";
      // PC Spotify 볼륨 슬라이더를 스피커 볼륨으로 맞춤 (PC는 음소거 상태라 소리 안 남)
      try {
        if (typeof pcVolBefore !== "number") {
          // 스피커에서 넘어온 직후엔 슬라이더가 아직 스피커 볼륨이라, 기억해 둔 PC 볼륨(또는 PC 기기 정보)을 씀
          const pcDev = list.find((d) => d.id === lid);
          const pv = speakerStreaming
            ? (typeof lastPcVol === "number" ? lastPcVol : (pcDev && typeof pcDev.volume === "number" ? pcDev.volume : null))
            : Spicetify.Player.getVolume();
          if (typeof pv === "number") savePcVol(pv);
        }
        if (!setVolIfActive(lid, spkVol)) {
          await waitFor(() => activeIdNow() === lid, 1500, 50);
          setVolIfActive(lid, spkVol);
        }
      } catch (e) { /* 무시 */ }
      lastVol = spkVol;
      rememberSpeakerVol(spkVol);
      volHoldUntil = Date.now() + 3000;
      entered = true;
      if (keepPlaying) {
        fromKey = null;
        castP.then((ok) => { if (ok) log(`AirPlay 준비 완료 (${Date.now() - t0}ms)`); });
        return;
      }
      const isRow = () => { const it = cur(); return !!it && (sameTrack(it.uri, row.uri) || (isLocalTrack(it) && localTitle(it.uri) && localTitle(it.uri) === localTitle(row.uri))); };
      const PA = Spicetify.Platform.PlayerAPI;
      const attempts = [];
      if (row.queued && PA && PA.addToQueue && PA.skipToNext) {
        attempts.push(["대기열", async () => { await PA.addToQueue([{ uri: row.uri }]); await sleep(200); await PA.skipToNext(); }]);
      }
      if (ctxUri) attempts.push(["재생목록", () => Spicetify.Player.playUri(ctxUri, {}, { skipTo: { uid: row.uid, uri: row.uri } })]);
      if (ctxUri && row.uid) attempts.push(["재생목록(uri만)", () => Spicetify.Player.playUri(ctxUri, {}, { skipTo: { uri: row.uri } })]);
      if (PA && PA.play) attempts.push(["로컬 파일 목록", () => PA.play({ uri: "spotify:internal:local-files" }, {}, { skipTo: { uri: row.uri } })]);
      attempts.push(["곡만", () => Spicetify.Player.playUri(row.uri)]);
      let played = false;
      internalPlay++;
      try {
        for (const [name, fn] of attempts) {
          try { await fn(); } catch (e) { log(`재생 시도 오류(${name}): ${errMsg(e)}`); continue; }
          if (await waitFor(isRow, 3000)) {
            played = true; fromKey = null; log(`재생 시작: ${name} (${Date.now() - t0}ms)`);
            if (row.queued) { const i = userLocalQueue.findIndex((x) => sameTrack(x.uri, row.uri)); if (i >= 0) userLocalQueue.splice(i, 1); }
            break;
          }
        }
      } finally {
        internalPlay--;
      }
      if (!played) throw new Error("로컬파일 재생 시작 실패");
      castP.then((ok) => { if (ok) log(`AirPlay 준비 완료 (${Date.now() - t0}ms)`); });
    } catch (e) {
      log("AirPlay 모드 진입 실패: " + errMsg(e));
      notify(errMsg(e), true);
      try { Spicetify.Player.pause(); } catch (e2) { /* 무시 */ }
      helper("/stop", {}, 15000).catch(() => {});
      await helper("/mute", { mute: false }).catch(() => {});
      castedUri = null;
      mode = "idle";
      enterFailAt = Date.now();
    } finally {
      busy = false;
      enteringCast = false;
    }
    return entered;
  }

  async function syncCast(force) {
    const vol = Spicetify.Player.getVolume();
    if (lastVol !== null && typeof vol === "number" && Math.abs(vol - lastVol) > 0.004) {
      // 사용자가 볼륨바를 만지지 않았는데 바뀜 = PC 볼륨이 새어 들어온 것 → 스피커로 보내지 않고 되돌림
      const byUser = userVol(2500);
      const pcLeak = !byUser && (nearPc(vol) || vol - lastVol > 0.15);
      const pcNow = isPcActiveNow();
      if (!pcNow || (Date.now() < volHoldUntil && !byUser) || pcLeak) {
        if (pcNow) { try { Spicetify.Player.setVolume(lastVol); } catch (e) { /* 무시 */ } }
        if (pcLeak && pcNow) log(`PC 볼륨 ${Math.round(vol * 100)}%가 스피커로 가는 것 막음 → ${Math.round(lastVol * 100)}% 유지`);
      } else if (vol > maxSpk() + 0.004) {
        try { Spicetify.Player.setVolume(maxSpk()); } catch (e) { /* 무시 */ }
        capNotice();
        if (Math.abs(lastVol - maxSpk()) > 0.004) { lastVol = maxSpk(); rememberSpeakerVol(lastVol); helper("/volume", { level: lastVol }).catch(() => {}); }
      } else {
        lastVol = vol;
        rememberSpeakerVol(vol);
        helper("/volume", { level: vol }).catch(() => {});
      }
    }
    if (holding()) return;
    const now = Date.now();
    if (!force && now - lastSync < 1000) return;
    lastSync = now;
    const it = cur();
    const paused = !!(Spicetify.Player.data && Spicetify.Player.data.isPaused);
    helper("/sync", {
      position_ms: Spicetify.Player.getProgress() + (paused ? 0 : audioDelay()),
      paused,
      uri: it && it.uri,
    }).then((r) => {
      // 보조 프로그램이 다시 켜져 전송 정보를 잃었으면 → 지금 위치에서 AirPlay 다시 시작 (+ PC 음소거)
      if (r && r.reason === "not_casting" && mode === "cast" && !busy && it && isLocalTrack(it) && sameTrack(castedUri, it.uri)) {
        if (Date.now() - lastRecast < 5000) return;
        lastRecast = Date.now();
        log("AirPlay 연결 복구: 보조 프로그램이 전송을 잃어 다시 시작");
        helper("/mute", { mute: true }).catch(() => {});
        castedUri = null;
        startCast(it, Spicetify.Player.getProgress() + audioDelay(), paused, typeof lastVol === "number" ? lastVol : undefined, false);
      }
    }).catch(() => {});
  }
  let lastRecast = 0;

  // ───────── 탐색(뒤로/앞으로 감기) 바로 반영 ─────────
  // 재생 위치가 예상과 1.2초 넘게 다르면 탐색으로 보고, 드래그가 끝나면(0.25초) 바로 스피커도 그 위치로
  let seekWatch = null;
  let seekTimer = null;
  let lastPausedSeen = null;
  let lastResumeUri = null, lastResumeAt = 0;
  const SEEK_AHEAD_MS = 150;   // 연결 안에서 위치만 옮기는 시간만큼 앞에서 시작
  async function sendSeek(tries = 0) {
    seekTimer = null;
    const d = Spicetify.Player.data;
    const it = cur();
    if (busy || mode !== "cast" || !it || !isLocalTrack(it) || !sameTrack(castedUri, it.uri) || (d && d.isPaused)) return;
    // 곡이 바뀌는 순간 위치가 0으로 먼저 바뀌는 경우가 있어, 바로 다음 곡으로 넘어가면 보내지 않음
    if (seekWatch && seekWatch.uri !== it.uri) return;
    if (holding()) return;
    const r = await restartAudioAt(it, Spicetify.Player.getProgress() + SEEK_AHEAD_MS, true);
    if (r && r.action === "busy" && tries < 20) seekTimer = setTimeout(() => sendSeek(tries + 1), 250);
  }
  function watchSeek() {
    if (!enabled || mode !== "cast") { seekWatch = null; return; }
    const it = cur();
    const d = Spicetify.Player.data;
    if (!it || !isLocalTrack(it) || !sameTrack(castedUri, it.uri)) { seekWatch = null; return; }
    const now = Date.now();
    const p = Spicetify.Player.getProgress();
    const paused = !!(d && d.isPaused);
    if (holding() || busy || now < ignoreJumpUntil) { seekWatch = { uri: it.uri, p, t: now, paused }; lastPausedSeen = paused; return; }
    // 일시정지/다시 재생을 바로 스피커에 반영 (1초 주기 동기화를 기다리지 않음)
    if (lastPausedSeen !== null && paused !== lastPausedSeen && seekWatch && seekWatch.uri === it.uri) {
      lastPausedSeen = paused;
      if (paused) { lastSync = now; helper("/sync", { position_ms: p, paused: true, uri: it.uri }).catch(() => {}); }
      else if (!sameTrack(it.uri, lastResumeUri) || now - lastResumeAt > 400) {
        lastResumeUri = it.uri; lastResumeAt = now;
        restartAudioAt(it, p, false);
      }
      seekWatch = { uri: it.uri, p: Spicetify.Player.getProgress(), t: now, paused };
      return;
    }
    lastPausedSeen = paused;
    if (seekWatch && seekWatch.uri === it.uri && !paused && !seekWatch.paused) {
      const expected = seekWatch.p + (now - seekWatch.t);
      if (Math.abs(p - expected) > 2000) {
        if (seekTimer) clearTimeout(seekTimer);
        // 처음(0초 근처)으로 가는 건 곡이 바뀌는 중일 수 있어 조금 더 기다렸다가 확인
        //  (이전/다음 곡 버튼을 눌렀을 때 로컬파일 첫부분이 잠깐 들리지 않게)
        seekTimer = setTimeout(() => sendSeek(0), p < 1500 ? 1000 : 150);
      }
    }
    seekWatch = { uri: it.uri, p, t: now, paused };
  }
  setInterval(() => { try { watchSeek(); } catch (e) { /* 무시 */ } }, 100);

  async function returnToConnect() {
    busy = true;
    const t0 = Date.now();
    try {
      const list = await devices();
      const lid = localId(list);
      const act = list.find((d) => d.active);
      if (act && act.id !== lid) { await exitCast("다른 기기가 선택됨: " + act.name, true); return; }
      const target = (speakerId && list.find((d) => d.id === speakerId)) || list.find(isSpeaker);
      if (!target) throw new Error("스피커가 Spotify 기기 목록에 없어요");
      log("스피커(Connect)로 복귀");
      // AirPlay로 듣던 볼륨을 Connect 볼륨에도 그대로 이어가기
      const apVol = typeof lastVol === "number" ? Math.min(lastVol, maxSpk()) : null;
      // PC 볼륨은 여기서 되돌리지 않음: 되돌린 직후 스피커로 옮기면 Spotify가 그 볼륨을 스피커로 가져갈 수 있음.
      // 슬라이더를 스피커 볼륨으로 둔 채 옮기고, PC 볼륨은 나중에 PC가 재생 기기가 될 때 복원.
      if (apVol !== null) setVolIfActive(lid, apVol);
      // 딜레이 단축: 기다리지 않고 바로 캐스트 종료 → Connect 전환
      // 딜레이 단축: Connect 전환을 바로 시작하고, AirPlay는 0.6초 뒤에 끊음
      // (Spotify 서버를 거쳐 스피커가 Connect로 바뀌기 전에 AirPlay가 먼저 끝나 있어야 스피커가 붙잡히지 않음)
      castedUri = null;
      // 버튼으로 넘긴 경우(로컬파일이 끝나지 않았는데 바뀜) → AirPlay를 바로 끊어 로컬 음악이 더 나오지 않게
      const skipped = !lastLocal || !lastLocal.dur || lastLocal.dur - lastLocal.prog > 3000;
      let stopNow = null;
      if (skipped) stopNow = helper("/stop", {}, 15000).catch(() => {});
      // 넘길 곡이 PC에서 확실히 시작된 뒤에 옮김 (너무 빨리 옮기면 Spotify가 아직 로컬파일을 지금 곡으로 알고
      // 스피커가 그걸 건너뛰어 그 다음 곡(奏 등)으로 가 버림)
      const intended = cur();
      const ctxNow = playlistOf(Spicetify.Player.data && Spicetify.Player.data.context && Spicetify.Player.data.context.uri);
      await waitFor(() => { const it = cur(); return !!it && !isLocalTrack(it) && Spicetify.Player.getProgress() > 150; }, 700, 50);
      await sleep(250);
      const stopP = stopNow || sleep(600).then(() => helper("/stop", {}, 15000)).catch(() => {});
      const ok = await transferTo(target.id, true);
      await stopP;
      if (!ok) throw new Error("스피커로 전환 실패");
      // 스피커가 다른 곡으로 시작했으면 원래 넘기려던 곡으로 바로잡음
      if (intended && !isLocalTrack(intended)) {
        await sleep(400);
        const now = cur();
        if (now && norm(nameOf(now)) !== norm(nameOf(intended))) {
          log(`[진단] 스피커가 ${nameOf(now)}(으)로 시작 → ${nameOf(intended)}(으)로 바로잡음`);
          internalPlay++;
          try {
            if (ctxNow) await Spicetify.Player.playUri(ctxNow, {}, { skipTo: { uid: intended.uid, uri: intended.uri } });
            else await Spicetify.Player.playUri(intended.uri);
          } catch (e) {
            try { if (ctxNow) await Spicetify.Player.playUri(ctxNow, {}, { skipTo: { uri: intended.uri } }); } catch (e2) { /* 무시 */ }
          } finally { internalPlay--; }
        }
      }
      if (Spicetify.Player.data && Spicetify.Player.data.isPaused) Spicetify.Player.play();
      if (apVol !== null) {
        await enforceSpeakerVol(target.id, apVol);
        log(`Connect 볼륨 = AirPlay 볼륨 ${Math.round(apVol * 100)}%`);
      }
      helper("/mute", { mute: false }).catch(() => {});
      mode = "connect";
      speakerId = target.id;
      log(`복귀 완료 (${Date.now() - t0}ms)`);
    } catch (e) {
      log("복귀 실패: " + errMsg(e));
      notify(errMsg(e) + " → PC에서 계속 재생", true);
      await helper("/mute", { mute: false }).catch(() => {});
      mode = "idle";
    } finally {
      busy = false;
    }
  }

  async function exitCast(reason, alreadyBusy) {
    if (!alreadyBusy) busy = true;
    try {
      log("AirPlay 모드 종료: " + reason);
      await helper("/stop", {}, 15000).catch(() => {});
      // PC에서 계속 듣는 경우 PC 볼륨부터 되돌린 뒤 음소거 해제 (갑자기 커지거나 작아지지 않게)
      try {
        const l = await devices();
        const a = l.find((d) => d.active);
        if (a && a.id === localId(l)) restorePcVol("AirPlay 종료");
      } catch (e) { /* 무시 */ }
      await helper("/mute", { mute: false }).catch(() => {});
    } finally {
      mode = "idle";
      castedUri = null;
      if (!alreadyBusy) busy = false;
    }
  }

  // ───────── 메인 루프 ─────────
  async function tick() {
    if (ticking || busy || !enabled) return;
    ticking = true;
    try {
      if (!helperOk) {
        if (Date.now() - lastHelperCheck > (mode === "cast" ? 1500 : 5000)) await checkHelper();
        if (!helperOk) return;
      }
      const data = Spicetify.Player.data;
      const item = data && data.item;
      if (!item) return;

      const list = await devices();
      const active = list.find((d) => d.active);
      const lid = localId(list);

      if (mode === "cast") {
        if (active && lid && active.id !== lid) { await exitCast("다른 기기가 선택됨: " + active.name); return; }
        if (isLocalTrack(item)) {
          lastLocal = { uri: item.uri, prog: Spicetify.Player.getProgress(), dur: Number(Spicetify.Player.getDuration()) || msOf(item) || 0 };
          fromKey = null;   // 로컬파일이 나오기 시작했으면, 이후 스포티파이 곡(뒤로 가기 포함)은 전부 Connect로 복귀
          if (sameTrack(castFailUri, item.uri)) {
            // 파일을 못 찾은 곡은 PC에서 조용히 재생되지 않게 넘김
            if (skippedFail !== keyOf(item)) { skippedFail = keyOf(item); Spicetify.Player.next(); }
          } else if (!sameTrack(castedUri, item.uri)) {
            castFailUri = null;
            startCast(item, Spicetify.Player.getProgress(), !!data.isPaused);
          } else {
            await syncCast(false);
          }
        } else if (isPlayable(item) && keyOf(item) !== fromKey) {
          await returnToConnect();
        }
        return;
      }

      if (!active || active.id !== lid) pcSince = 0;
      const spkOn = (active && isSpeaker(active)) || (!active && mode === "connect" && !!speakerId);
      if (!active && spkOn && !diagSeen.has("noactive")) { diagSeen.add("noactive"); log("[진단] 재생 기기 정보가 잠깐 비어 있음 → Connect 유지로 처리"); }
      if (spkOn) {
        if (mode !== "connect") {
          log("Connect 모드: " + active.name);
          // 다른 기기에서 막 넘어옴 → 잠시 동안 스피커 볼륨이 PC 볼륨으로 바뀌지 않게 지킴
          if (!spkGuard || Date.now() > spkGuard.until) guardSpeaker(lastSpeakerVol, 6000);
        }
        mode = "connect";
        if (active) speakerId = active.id;
        let cv = Spicetify.Player.getVolume();
        if (typeof cv === "number" && active && !userVol(2500)) {
          const g = spkGuard && Date.now() < spkGuard.until ? spkGuard : null;
          const ref = g ? g.vol : lastSpeakerVol;
          // 스피커 볼륨이 사용자 조작 없이 (PC 볼륨 값으로 / 갑자기 크게) 바뀌면 되돌림
          const leak = typeof ref === "number" && cv > ref + 0.02 && (nearPc(cv) || (g && cv - ref > 0.1));
          if (leak && setVolIfActive(active.id, ref)) {
            log(`스피커 볼륨이 ${Math.round(cv * 100)}%로 바뀜(PC 볼륨) → ${Math.round(ref * 100)}%로 되돌림`);
            cv = ref;
          }
        }
        if (typeof cv === "number" && cv > maxSpk() + 0.004) {
          try { Spicetify.Player.setVolume(maxSpk()); } catch (e) { /* 무시 */ }
          log(`Connect 볼륨 ${Math.round(cv * 100)}% → 최대 ${Math.round(maxSpk() * 100)}%로 제한`);
          capNotice();
        } else if (!spkGuard || Date.now() > spkGuard.until || userVol(2500)) rememberSpeakerVol(cv);
        const p = await makePlan(data, item);
        if (p.row) {
          // 스피커(Connect) 재생 중엔 getDuration()이 0일 때가 있어 곡 정보의 길이로 보완
          const dur = Number(Spicetify.Player.getDuration()) || msOf(item) || (data.duration && (data.duration.milliseconds || data.duration)) || 0;
          const prog = Number(Spicetify.Player.getProgress()) || 0;
          const remaining = dur - prog;
          const lead = Number(cfg.switch_lead_ms || 800);
          // 0.2초 간격 확인만으로는 늦을 수 있어, 끝이 가까우면 정확한 시각에 한 번 더 예약
          if (!data.isPaused && dur > 0 && remaining > lead && remaining < lead + 1500 && endTimerKey !== p.key) {
            endTimerKey = p.key;
            const pk = p.key, prow = p.row, pctx = p.ctxUri;
            setTimeout(async () => {
              try {
                const d2 = Spicetify.Player.data;
                if (!enabled || busy || mode !== "connect" || switchedFor === pk || !d2 || d2.isPaused || keyOf(d2.item) !== pk) return;
                switchedFor = pk;
                const ok = await enterCast({ row: prow, ctxUri: pctx, reason: "곡 끝 → 로컬파일 " + (prow.name || localTitle(prow.uri)) });
                if (!ok && mode !== "cast") switchedFor = null;
              } catch (e) { /* 무시 */ }
            }, Math.max(0, remaining - lead));
          }
          if (dur > 0 && remaining < 8000 && !diagSeen.has("end:" + p.key)) {
            diagSeen.add("end:" + p.key);
            log(`[진단] 곡 끝 확인: 길이 ${Math.round(dur / 1000)}초, 위치 ${Math.round(prog / 1000)}초 (getDuration ${Spicetify.Player.getDuration()})`);
          }
          if (!data.isPaused && dur > 0 && remaining <= lead && switchedFor !== p.key) {
            switchedFor = p.key;
            const ok = await enterCast({ row: p.row, ctxUri: p.ctxUri, reason: "곡 끝 → 로컬파일 " + (p.row.name || localTitle(p.row.uri)) });
            if (!ok && mode !== "cast") switchedFor = null;   // 못 넘어갔으면 다음 확인 때 다시 시도
          }
        }
      } else if (active) {
        mode = active.id === lid ? "pc" : "idle";
        if (mode === "pc") { if (!pcSince) pcSince = Date.now(); } else pcSince = 0;
        // 이전에 되돌리지 못한 PC 볼륨이 남아 있으면, PC가 2초 이상 확실히 재생 기기일 때 복원
        if (mode === "pc" && typeof pcVolBefore === "number") { if (Date.now() - pcSince > 2000) restorePcVol("PC 재생"); }
        else if (mode === "pc" && Date.now() - pcSince > 2000 && isPcActiveNow()) rememberPcVol(Spicetify.Player.getVolume());
      }
    } catch (e) {
      console.warn(TAG, "tick 오류", e);
    } finally {
      ticking = false;
    }
  }

  Spicetify.Player.addEventListener("songchange", () => {
    const item = cur();
    const key = keyOf(item);
    if (key === lastSongKey) return;
    const prev = plan;
    lastSongKey = key;
    if (mode === "connect" && item && !isLocalTrack(item)) spotifyPlayed++;
    // 스피커가 로컬파일을 건너뜀(다음 버튼 등): 전환 예정이던 로컬파일이 있었고, 대기열의 다음 곡으로 넘어간 경우
    // 대기열 다음 곡(주소가 바뀌어 올 수 있어 이름으로도 비교) 또는 재생목록에서 로컬파일 바로 다음 곡으로 왔는지
    let skipped = false;
    try {
      if (prev && prev.row && item && !isLocalTrack(item)) {
        if (prev.queueNextUri && sameTrack(item.uri, prev.queueNextUri)) skipped = true;
        if (!skipped && prev.queueNextName && norm(nameOf(item)) === norm(prev.queueNextName)) skipped = true;
        if (!skipped && plCache.uri && plCache.uri === prev.ctxUri) {
          const rows = plCache.rows;
          const ri = rows.findIndex((r) => (prev.row.uid && r.uid === prev.row.uid) || sameTrack(r.uri, prev.row.uri));
          let after = ri + 1;
          while (after < rows.length && rows[after].isLocal) after++;
          if (ri >= 0 && after < rows.length && scoreRow(rows[after], item) >= 50) skipped = true;
        }
      }
    } catch (e) { /* 무시 */ }
    if (enabled && !busy && mode === "connect" && prev && prev.row && item && !isLocalTrack(item) &&
        switchedFor !== prev.key && skipped) {
      switchedFor = prev.key;
      plan = null;
      enterCast({ row: prev.row, ctxUri: prev.ctxUri, reason: "스피커가 로컬파일을 건너뜀 → " + (prev.row.name || localTitle(prev.row.uri)) });
      return;
    }
    if (switchedFor && switchedFor !== key) switchedFor = null;
    setTimeout(tick, 30);
  });

  Spicetify.Player.addEventListener("onplaypause", () => {
    if (enabled && !busy && mode === "cast") syncCast(true);
  });

  setInterval(tick, TICK_MS);


  // ───────── 기기 목록에서 로컬파일 재생 중에도 스피커 선택 가능하게 ─────────
  // Spotify는 로컬파일일 때 스피커를 "이 트랙을 재생할 수 없음"으로 막는데, 이를 풀고 누르면 AirPlay로 이어서 재생
  const BLOCK_TEXTS = ["이 트랙을 재생할 수 없음", "Can't play this track", "Can’t play this track"];
  const PICK_LABEL = "AirPlay로 재생";
  function findSubtitleNodes(root) {
    const out = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      const t = (n.nodeValue || "").trim();
      if (BLOCK_TEXTS.some((b) => t === b)) out.push(n);
    }
    return out;
  }
  function closePicker(fromEl) {
    let el = fromEl;
    for (let i = 0; i < 12 && el; i++, el = el.parentElement) {
      const btn = el.querySelector && el.querySelector('button[aria-label="닫기"], button[aria-label="Close"]');
      if (btn) { btn.click(); return; }
    }
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  }
  async function pickSpeakerForLocal(rowEl) {
    const it = cur();
    if (!it || !isLocalTrack(it)) return;
    if (busy) return notify("전환 중이에요. 잠시 후 다시 시도하세요", true);
    closePicker(rowEl);
    const d = Spicetify.Player.data || {};
    log("기기 목록에서 스피커 선택 → 로컬파일을 AirPlay로");
    enterCast({ row: { uri: it.uri, uid: it.uid, name: nameOf(it) }, ctxUri: playlistOf(d.context && d.context.uri),
      manual: true, keepPlaying: true, reason: "기기 목록에서 스피커 선택" });
  }
  function patchPicker() {
    if (!enabled || !helperOk || mode === "cast" || remoteAirplay()) return;
    const it = cur();
    if (!it || !isLocalTrack(it)) return;
    const roots = Array.from(document.querySelectorAll('aside, [role="dialog"], [class*="devicePicker"], [class*="DevicePicker"], [data-testid*="device"]'));
    const now = Date.now();
    if (!roots.length || now - lastBodyScan > 2000) { roots.push(document.body); lastBodyScan = now; }
    const nodes = [];
    for (const r of roots) for (const n of findSubtitleNodes(r)) if (!nodes.includes(n)) nodes.push(n);
    for (const textNode of nodes) {
      // 스피커 이름이 들어 있는 줄(행)만
      let row = textNode.parentElement;
      for (let i = 0; i < 6 && row && !norm(row.textContent).includes(norm(cfg.speaker_name)); i++) row = row.parentElement;
      if (!row || !norm(row.textContent).includes(norm(cfg.speaker_name))) continue;
      const clickable = row.closest('button, [role="button"], li, [role="listitem"], [role="menuitem"], [role="option"]') || row;
      textNode.nodeValue = PICK_LABEL;
      for (let el = textNode.parentElement; el && el !== clickable.parentElement; el = el.parentElement) {
        el.removeAttribute("disabled");
        el.removeAttribute("aria-disabled");
        el.style.opacity = "1";
        el.style.pointerEvents = "auto";
        el.style.cursor = "pointer";
      }
      if (textNode.parentElement) textNode.parentElement.style.color = "#4fb3ff";
      if (!clickable.__localcastPick) {
        clickable.__localcastPick = true;
        clickable.addEventListener("click", (e) => {
          const nowIt = cur();
          if (!nowIt || !isLocalTrack(nowIt) || mode === "cast") return;
          e.preventDefault();
          e.stopPropagation();
          pickSpeakerForLocal(clickable);
        }, true);
      }
    }
  }
  // ───────── AirPlay 중: 기기 목록(Connect)에 스피커가 연결된 것처럼 표시, "이 컴퓨터"로 옮기기 ─────────
  const CARD_ID = "localcast-connect-card";
  const JAM_TEXTS = ["잼하기", "잼 시작하기", "Start a Jam", "Jam"];
  const PC_ICON = `<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true"><path d="M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-6v2h3v2H8v-2h3v-2H5a2 2 0 0 1-2-2V5zm2 0v10h14V5H5z"/></svg>`;
  const PCICON_KEY = "localcast:pcicon";
  let pcIconSrc = (() => { try { return localStorage.getItem(PCICON_KEY) || null; } catch (e) { return null; } })();
  const hiddenEls = new Set();
  function hideEl(el) {
    if (!el) return;
    if (!hiddenEls.has(el)) {
      el.dataset.localcastDisplay = el.style.display || "";
      hiddenEls.add(el);
    }
    // Spotify가 줄을 다시 그리면 숨김이 풀림 → 매번 다시 확인해서 숨김
    if (el.style.getPropertyValue("display") !== "none" || el.style.getPropertyPriority("display") !== "important") {
      el.style.setProperty("display", "none", "important");
    }
  }
  function fadeInHidden() {
    const els = Array.from(hiddenEls);
    hiddenEls.clear();
    for (const el of els) {
      try {
        el.style.opacity = "0";
        el.style.removeProperty("display");
        if (el.dataset.localcastDisplay) el.style.display = el.dataset.localcastDisplay;
        delete el.dataset.localcastDisplay;
        el.style.transition = "opacity .25s ease";
        requestAnimationFrame(() => requestAnimationFrame(() => { el.style.opacity = "1"; }));
        setTimeout(() => { el.style.transition = ""; el.style.opacity = ""; }, 400);
      } catch (e) { /* 무시 */ }
    }
  }
  function unhideAll() {
    for (const el of hiddenEls) { try { el.style.display = el.dataset.localcastDisplay || ""; delete el.dataset.localcastDisplay; } catch (e) { /* 무시 */ } }
    hiddenEls.clear();
  }
  function findSpeakerRowInPicker() {
    const roots = Array.from(document.querySelectorAll('aside, [role="dialog"], [class*="devicePicker"], [class*="DevicePicker"], [data-testid*="device"]'));
    if (!roots.length) roots.push(document.body);
    for (const r of roots) {
      for (const t of findSubtitleNodes(r).concat(findTextNodes(r, [PICK_LABEL]))) {
        let row = t.parentElement;
        for (let i = 0; i < 6 && row && !norm(row.textContent).includes(norm(cfg.speaker_name)); i++) row = row.parentElement;
        if (!row || !norm(row.textContent).includes(norm(cfg.speaker_name))) continue;
        if (row.closest(OURS)) continue;
        let el = row.closest('button, [role="button"], li, [role="listitem"], [role="menuitem"], [role="option"]') || row;
        // 아이콘까지 포함한 한 줄 전체로 넓힘 (위 칸이 이 줄만 감싸고 있는 동안)
        const len = norm(el.textContent).length;
        while (el.parentElement && !el.parentElement.closest(OURS) && norm(el.parentElement.textContent).length <= len + 2 &&
               el.parentElement.children.length <= 3 && !el.parentElement.matches('aside, [role="dialog"], [role="list"], ul, ol')) el = el.parentElement;
        return el;
      }
    }
    return null;
  }
  function findTextNodes(root, texts) {
    const out = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) { const t = (n.nodeValue || "").trim(); if (texts.includes(t)) out.push(n); }
    return out;
  }
  async function moveToPc() {
    if (busy) return notify("전환 중이에요. 잠시 후 다시 시도하세요", true);
    log("기기 목록에서 이 컴퓨터 선택 → PC 스피커로");
    await exitCast("이 컴퓨터로 옮김");
    notify("이 컴퓨터에서 재생해요");
  }
  function castPanel() {
    const remote = mode !== "cast" ? remoteAirplay() : null;
    const show = enabled && (mode === "cast" || !!remote);
    let card = document.getElementById(CARD_ID);
    if (!show) {
      if (card && !card.dataset.leaving) {
        // 부드럽게: LocalCast 칸이 흐려지며 사라진 뒤 Spotify 원래 칸이 서서히 나타남
        card.dataset.leaving = "1";
        card.style.transition = "opacity .2s ease";
        card.style.opacity = "0";
        setTimeout(() => { try { card.remove(); } catch (e) { /* 무시 */ } fadeInHidden(); }, 200);
      } else if (!card && hiddenEls.size) fadeInHidden();
      return;
    }
    if (card && card.dataset.leaving) { delete card.dataset.leaving; card.style.opacity = "1"; }
    const spkRow = findSpeakerRowInPicker();
    if (!spkRow) { if (card) card.remove(); return; }
    const rsvg = Array.from(spkRow.querySelectorAll("svg")).find((x) => !x.closest(OURS) && x.innerHTML.length > 20);
    if (rsvg && rsvg.outerHTML !== spkIconSrc) { spkIconSrc = rsvg.outerHTML; iconFromPicker = true; try { localStorage.setItem(ICON_KEY, spkIconSrc); } catch (e) { /* 무시 */ } }
    // 목록 안의 스피커 줄은 숨기고, 맨 위 "현재 기기" 칸(유선 연결 / 잼하기)도 숨김
    hideEl(spkRow);
    let top = null;
    const panel = spkRow.closest("aside") || spkRow.parentElement && spkRow.parentElement.parentElement;
    if (panel) {
      const jam = findTextNodes(panel, JAM_TEXTS)[0];
      if (jam) {
        top = jam.parentElement;
        while (top && top.parentElement && !top.parentElement.contains(spkRow)) top = top.parentElement;
        if (top && !top.contains(spkRow) && top !== card) hideEl(top); else top = null;
      }
    }
    if (!card) {
      card = document.createElement("div");
      card.id = CARD_ID;
      card.style.cssText = "display:flex;flex-direction:column;gap:4px;margin:8px 0 12px;opacity:0;transition:opacity .25s ease;";
      requestAnimationFrame(() => requestAnimationFrame(() => { if (card && !card.dataset.leaving) card.style.opacity = "1"; }));
      card.innerHTML =
        `<div style="display:flex;align-items:center;gap:14px;padding:14px 16px;border-radius:8px;background:rgba(255,255,255,.07);">` +
        `<span class="lc-icon" style="color:#1ed760;display:flex"></span>` +
        `<div style="min-width:0"><div class="lc-name" style="color:#1ed760;font-weight:700;font-size:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis"></div>` +
        `<div class="lc-sub" style="color:#4fb3ff;font-size:13px">AirPlay로 재생 중</div></div></div>` +
        `<div class="lc-pc" role="button" tabindex="0" style="display:flex;align-items:center;gap:14px;padding:12px 16px;border-radius:6px;cursor:pointer;color:#fff;">` +
        `<span class="lc-pcicon" style="color:#b3b3b3;display:flex"></span>` +
        `<div><div style="font-size:16px">이 컴퓨터</div><div style="color:#b3b3b3;font-size:13px">여기로 옮겨서 PC 스피커로 듣기</div></div></div>`;
      const pc = card.querySelector(".lc-pc");
      pc.addEventListener("mouseenter", () => { pc.style.background = "rgba(255,255,255,.1)"; });
      pc.addEventListener("mouseleave", () => { pc.style.background = ""; });
      pc.addEventListener("click", (e) => {
        e.preventDefault(); e.stopPropagation();
        if (mode === "cast") { moveToPc(); return; }
        // 다른 PC가 AirPlay 중 → 이 PC로 재생을 가져옴 (그 PC의 LocalCast는 알아서 AirPlay를 멈춤)
        devices().then((l) => { const id = localId(l); if (id) transferTo(id, true); }).catch(() => {});
      });
    }
    if (top) {
      const psvg = Array.from(top.querySelectorAll("svg")).find((x) => x.innerHTML.length > 20);
      if (psvg && psvg.outerHTML !== pcIconSrc) { pcIconSrc = psvg.outerHTML; try { localStorage.setItem(PCICON_KEY, pcIconSrc); } catch (e) { /* 무시 */ } }
    }
    const pci = card.querySelector(".lc-pcicon");
    const pcHtml = iconHtml(pcIconSrc || PC_ICON, 24);
    if (pci.dataset.html !== pcHtml) { pci.dataset.html = pcHtml; pci.innerHTML = pcHtml; }
    card.querySelectorAll("*").forEach((x) => { if (x.style && x.style.display === "none" && !x.classList.contains("lc-play")) x.style.display = ""; });
    const ic = card.querySelector(".lc-icon");
    const icHtml = speakerIcon(24);
    if (ic.dataset.html !== icHtml) { ic.dataset.html = icHtml; ic.innerHTML = icHtml; }
    const sub = card.querySelector(".lc-sub");
    const subText = remote ? `AirPlay로 재생 중 · ${remote.host}` : "AirPlay로 재생 중";
    if (sub && sub.textContent !== subText) sub.textContent = subText;
    const nm = card.querySelector(".lc-name");
    const name = (remote && remote.speaker) || lastSpeakerName || cfg.speaker_name;
    if (nm.textContent !== name) nm.textContent = name;
    const anchor = top || spkRow;
    if (card.nextElementSibling !== anchor || card.parentElement !== anchor.parentElement) anchor.insertAdjacentElement("beforebegin", card);
  }

  let lastBodyScan = 0;
  let pickTimer = null;
  // 모드가 바뀌면 기기 목록 칸을 바로 바꿈 (두 칸이 겹쳐 보이지 않게)
  let lastPanelMode = null;
  setInterval(() => {
    const k = mode + "|" + (remoteAirplay() ? "r" : "");
    if (k !== lastPanelMode) { lastPanelMode = k; try { castPanel(); } catch (e) { /* 무시 */ } }
  }, 50);
  try {
    // 화면이 바뀔 때마다 바로 돌지 않고 0.25초에 한 번만 확인 (Spotify가 느려지지 않게)
    let lastQ = 0, qTimer = null;
    const mo = new MutationObserver(() => {
      // 오른쪽 "재생목록" 패널이 그려지는 즉시 로컬파일 줄을 넣음 (화면에 보이기 전)
      if (mode === "connect") {
        const now = Date.now();
        if (now - lastQ > 120) { lastQ = now; try { patchQueue(); } catch (e) { /* 무시 */ } }
        else if (!qTimer) qTimer = setTimeout(() => { qTimer = null; lastQ = Date.now(); try { patchQueue(); } catch (e) { /* 무시 */ } }, 120);
      }
      if (pickTimer) return;
      pickTimer = setTimeout(() => { pickTimer = null; try { patchPicker(); } catch (e) { /* 무시 */ } try { castPanel(); } catch (e) { /* 무시 */ } }, 60);
    });
    mo.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["disabled", "aria-disabled"] });
  } catch (e) { console.warn(TAG, "기기 목록 감시 실패", e); }

  // ───────── "○○ AirPlay에서 재생 중" 하늘색 표시줄 ─────────
  const BAR_ID = "localcast-airplay-bar";
  // 아래 줄용: 여백을 잘라 조금 더 크게 보이게 (Spotify Connect 줄 아이콘과 비슷한 크기)
  const BAR_AIRPLAY_ICON = `<svg viewBox="3 3 18 18" width="17" height="17" fill="currentColor" aria-hidden="true" style="flex-shrink:0;display:block"><path d="M6.1 18.1A8.5 8.5 0 1 1 17.9 18.1l-1.2-1.3a6.7 6.7 0 1 0-9.4 0z"/><path d="M8.9 15.2a4.6 4.6 0 1 1 6.2 0l-1.2-1.3a2.8 2.8 0 1 0-3.8 0z"/><path d="M12 14.2l5.2 6.3H6.8z"/></svg>`;
  const AIRPLAY_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M6.1 18.1A8.5 8.5 0 1 1 17.9 18.1l-1.2-1.3a6.7 6.7 0 1 0-9.4 0z"/><path d="M8.9 15.2a4.6 4.6 0 1 1 6.2 0l-1.2-1.3a2.8 2.8 0 1 0-3.8 0z"/><path d="M12 14.2l5.2 6.3H6.8z"/></svg>`;
  // Spotify가 스피커에 쓰는 아이콘을 그대로 가져와 씀 (기기 목록의 스피커 줄에서 복사해 기억)
  const ICON_KEY = "localcast:spkicon2";
  const FALLBACK_SPK = `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M4 1.5A1.5 1.5 0 0 1 5.5 0h5A1.5 1.5 0 0 1 12 1.5v13a1.5 1.5 0 0 1-1.5 1.5h-5A1.5 1.5 0 0 1 4 14.5v-13zM5.5 1a.5.5 0 0 0-.5.5v13a.5.5 0 0 0 .5.5h5a.5.5 0 0 0 .5-.5v-13a.5.5 0 0 0-.5-.5h-5z"/><path d="M8 13a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zm0-1a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zM8 4a1 1 0 1 0 0-2 1 1 0 0 0 0 2z"/></svg>`;
  let spkIconSrc = (() => { try { return localStorage.getItem(ICON_KEY) || null; } catch (e) { return null; } })();
  let iconCapturedNow = false;
  let iconFromPicker = false;
  const OURS = "#localcast-connect-card, #localcast-airplay-bar";
  let lastIconScan = 0;
  function captureSpeakerIcon() {
    if (iconFromPicker || !cfg.speaker_name || Date.now() - lastIconScan < 3000) return;
    lastIconScan = Date.now();
    // 기기 목록(Connect)의 스피커 줄 아이콘이 가장 정확
    const prow = findSpeakerRowInPicker();
    const psvg = prow && Array.from(prow.querySelectorAll("svg")).find((x) => !x.closest(OURS) && x.innerHTML.length > 20);
    if (psvg) {
      if (psvg.outerHTML !== spkIconSrc) { spkIconSrc = psvg.outerHTML; try { localStorage.setItem(ICON_KEY, spkIconSrc); } catch (e) { /* 무시 */ } }
      iconFromPicker = true;
      return;
    }
    if (iconCapturedNow) return;
    const want = norm(cfg.speaker_name);
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      if (!norm(n.nodeValue).includes(want)) continue;
      const el = n.parentElement;
      if (!el || el.closest(OURS)) continue;
      // 이름 앞(같은 줄)의 기기 아이콘
      let row = el;
      for (let i = 0; i < 4 && row; i++, row = row.parentElement) {
        const svg = Array.from(row.querySelectorAll("svg")).find((x) =>
          !x.closest(OURS) && x.innerHTML.length > 20 && (x.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING));
        if (svg) {
          const html = svg.outerHTML;
          if (!spkIconSrc) spkIconSrc = html;   // 기기 목록에서 가져온 게 없을 때만 임시로 (저장 안 함)
          iconCapturedNow = true;
          return;
        }
      }
    }
  }
  function speakerIcon(size) { return iconHtml(spkIconSrc || FALLBACK_SPK, size); }
  function iconHtml(src, size) {
    const d = document.createElement("div");
    d.innerHTML = src;
    const svg = d.querySelector("svg");
    if (!svg) return "";
    svg.removeAttribute("id");
    svg.removeAttribute("class");   // Spotify 색(초록 등) 대신 여기서 정한 색으로
    svg.style.fill = "currentColor";
    svg.setAttribute("width", size); svg.setAttribute("height", size);
    svg.setAttribute("fill", "currentColor"); svg.setAttribute("aria-hidden", "true");
    svg.style.flexShrink = "0";
    return svg.outerHTML;
  }
  // 아래 재생바 오른쪽 "기기에 연결" 버튼도 스피커 아이콘(초록)으로
  function findConnectButton() {
    return document.querySelector('[data-restore-focus-key="device_picker"]') ||
      Array.from(document.querySelectorAll("button[aria-label]")).find((b) => /기기에 연결|Connect to a device/i.test(b.getAttribute("aria-label"))) || null;
  }
  function patchConnectButton() {
    const on = enabled && mode === "cast";
    const btn = findConnectButton();
    const svg = btn && btn.querySelector("svg");
    if (!svg) return;
    if (on) {
      const src = document.createElement("div");
      src.innerHTML = spkIconSrc || FALLBACK_SPK;
      const s2 = src.querySelector("svg");
      if (!s2) return;
      if (svg.dataset.lcOn === "1" && svg.dataset.lcSrc === s2.innerHTML) return;
      if (svg.dataset.lcOn !== "1") {
        svg.dataset.lcOrigHtml = svg.innerHTML;
        svg.dataset.lcOrigBox = svg.getAttribute("viewBox") || "";
        btn.dataset.lcOrigColor = btn.style.color || "";
      }
      svg.innerHTML = s2.innerHTML;
      if (s2.getAttribute("viewBox")) svg.setAttribute("viewBox", s2.getAttribute("viewBox"));
      svg.dataset.lcOn = "1";
      svg.dataset.lcSrc = s2.innerHTML;
      btn.style.color = "#1ed760";
    } else if (svg.dataset.lcOn === "1") {
      svg.innerHTML = svg.dataset.lcOrigHtml || svg.innerHTML;
      if (svg.dataset.lcOrigBox) svg.setAttribute("viewBox", svg.dataset.lcOrigBox);
      btn.style.color = btn.dataset.lcOrigColor || "";
      delete svg.dataset.lcOn; delete svg.dataset.lcSrc;
    }
  }
  function airplayName() {
    const n = String((speakerId && lastSpeakerName) || cfg.speaker_name || "스피커");
    return /wi-?fi/i.test(n) ? n.replace(/wi-?fi/i, "AirPlay") : n + " AirPlay";
  }
  let lastSpeakerName = null;
  // 아래 줄 하나로: Connect(초록) ↔ AirPlay(하늘색)를 같은 자리에서 색·글자가 서서히 바뀌게
  // (Spotify 원래 초록 줄은 숨기고 LocalCast 줄이 대신 보여줌 → 두 줄이 쌓이지 않음)
  let barState = "none";
  let natHiddenEl = null;
  let barHideTimer = null;
  let natInfo = { bg: "", color: "", text: "", icon: "" };
  let natCache = null, natSearchAt = 0;
  // Spotify 아래 줄: "○○에서 재생 중"(초록), "○○에 연결 중"(회색) 등
  const NATRX = /에서 재생 중|에 연결 중|연결하는 중|연결 중\.*|Playing on|Listening on|Connecting to/i;
  const NATSEL_KEY = "localcast:natsel";
  let natSels = (() => { try { const v = JSON.parse(localStorage.getItem(NATSEL_KEY) || "[]"); return Array.isArray(v) ? v : []; } catch (e) { return []; } })();
  // Spotify 초록 줄이 새로 그려지는 순간에도 바로 숨겨지게 CSS 규칙으로 (LocalCast 줄이 보일 때만)
  function setNativeHideCss(on) {
    let st = document.getElementById("localcast-hide-native");
    if (!st) { st = document.createElement("style"); st.id = "localcast-hide-native"; document.head.appendChild(st); }
    const css = on && natSels.length ? `${natSels.join(",")}{display:none !important}` : "";
    if (st.textContent !== css) st.textContent = css;
  }
  function nativeConnectBar(host, npb) {
    // 찾아둔 줄이 아직 화면에 있고 글자가 맞으면 그대로 (매번 전체를 뒤지지 않게)
    const want0 = norm(cfg.speaker_name);
    if (natCache && document.body.contains(natCache) && want0 && norm(natCache.textContent).includes(want0)) return natCache;
    if (barState === "none" && mode !== "cast" && !speakerActiveSync()) return null;   // 스피커를 안 쓸 땐 찾지 않음
    if (Date.now() - natSearchAt < 80) return null;
    natSearchAt = Date.now();
    natCache = findNativeConnectBar(host, npb);
    return natCache;
  }
  function findNativeConnectBar(host, npb, nameOverride) {
    const want = norm(nameOverride || cfg.speaker_name);
    if (!want) return null;
    // 아래 초록 줄만: 오른쪽 기기 창(Connect 목록)·LocalCast가 만든 칸은 절대 건드리지 않음
    // (아래 재생바 자체도 aside라서, 재생바가 들어 있지 않은 aside = 오른쪽 창만 제외)
    const NOT = `#${BAR_ID}, #${CARD_ID}, [role="dialog"], [data-localcast-q]`;
    const inSidePanel = (el) => { const a = el.closest("aside"); return !!a && !!npb && !a.contains(npb) && !npb.contains(a); };
    const bad = (el) => !!el.closest(NOT) || inSidePanel(el);
    const ok = (el) => el && !bad(el) && norm(el.textContent).includes(want) &&
      NATRX.test(el.textContent || "") && !/AirPlay로 재생/.test(el.textContent || "");
    // 1) 이름으로 바로
    for (const el of document.querySelectorAll('[class*="connectBar"], [class*="ConnectBar"], [data-testid*="connect-bar"], [data-testid*="connectBar"]')) {
      if (ok(el) && el.offsetHeight < 60) { let top = el; while (top.parentElement && ok(top.parentElement) && top.parentElement.offsetHeight < 60) top = top.parentElement; return top; }
    }
    // 2) 재생바 주변에서 "○○에서 재생 중" 글자를 찾아, 그 글자를 감싸는 한 줄(높이 60px 미만) 전체
    const scope = (host && host.parentElement) || document.body;
    const w = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = w.nextNode())) {
      const t = n.nodeValue || "";
      if (!NATRX.test(t) || !n.parentElement || bad(n.parentElement)) continue;
      let el = n.parentElement;
      if (!ok(el) && !(el.parentElement && ok(el.parentElement))) continue;
      while (el.parentElement && el.parentElement !== host && el.parentElement !== scope &&
             !el.parentElement.contains(npb) && el.parentElement.offsetHeight < 60) el = el.parentElement;
      if (npb && (el.contains(npb) || npb.contains(el) && el.offsetHeight > 60)) continue;
      return el;
    }
    return null;
  }
  // 다른 PC(데스크탑/노트북)의 LocalCast가 지금 오라스튜디오로 AirPlay 중인지 (보조 프로그램끼리 알려줌)
  let peers = [];
  setInterval(async () => {
    if (!enabled || !helperOk) { peers = []; return; }
    const before = peers.map((p) => p.host).join(",");
    try { const st = await helper("/status", undefined, 1500); peers = (st && Array.isArray(st.peers)) ? st.peers : []; } catch (e) { peers = []; }
    const after = peers.map((p) => p.host).join(",");
    if (after !== before) log(after ? `다른 PC가 AirPlay 중: ${after} → ${peers[0].speaker || "스피커"} AirPlay로 표시` : "다른 PC의 AirPlay 끝남");
  }, 2000);
  function remoteAirplay() {
    if (!peers.length || mode === "cast") return null;
    try {
      const a = Spicetify.Platform.ConnectAPI && Spicetify.Platform.ConnectAPI.state && Spicetify.Platform.ConnectAPI.state.activeDevice;
      if (!a || a.isLocal) return null;
      const it = cur();
      const an = norm(a.name || "");
      return peers.find((p) => (an && norm(p.host || "") === an) || (it && p.uri && sameTrack(it.uri, p.uri))) || null;
    } catch (e) { return null; }
  }
  function activeName() {
    try { const a = Spicetify.Platform.ConnectAPI.state.activeDevice; return a && !a.isLocal ? a.name : null; } catch (e) { return null; }
  }
  function airplayNameOf(n) {
    n = String(n || cfg.speaker_name || "스피커");
    return /wi-?fi/i.test(n) ? n.replace(/wi-?fi/i, "AirPlay") : n + " AirPlay";
  }

  function updateBar() {
    const npb = document.querySelector(".main-nowPlayingBar-container") || document.querySelector("[data-testid='now-playing-bar']");
    const host = npb && npb.parentElement;
    if (!host) return;
    const remote0 = enabled ? remoteAirplay() : null;
    let nat = nativeConnectBar(host, npb);
    if (!nat && remote0) {
      // 다른 PC가 AirPlay 중: "DESKTOP-…에서 재생 중" 원래 줄을 찾아 LocalCast 하늘색 줄로 대신함
      const an = activeName();
      if (an && Date.now() - natSearchAt >= 80) { natSearchAt = Date.now(); nat = findNativeConnectBar(host, npb, an); }
      else if (natHiddenEl && document.body.contains(natHiddenEl)) nat = natHiddenEl;
    }
    if (nat && nat.className && typeof nat.className === "string") {
      const sel = nat.className.trim().split(/\s+/).filter(Boolean).map((c) => "." + (window.CSS && CSS.escape ? CSS.escape(c) : c)).join("");
      // 다른 곳에도 쓰이는 흔한 모양이면 쓰지 않음 (엉뚱한 걸 숨기지 않게)
      let safe = false;
      try { const all = document.querySelectorAll(sel); safe = all.length >= 1 && all.length <= 2 && !Array.from(all).some((x) => x.contains(npb) || x.offsetHeight > 60 || x.closest("#" + CARD_ID)); } catch (e) { safe = false; }
      if (sel && safe && !natSels.includes(sel)) {
        natSels = [sel, ...natSels].slice(0, 4);
        try { localStorage.setItem(NATSEL_KEY, JSON.stringify(natSels)); } catch (e) { /* 무시 */ }
      }
    }
    if (nat) {
      // 초록 "재생 중" 줄에서만 아이콘을 가져옴 (회색 "연결 중" 줄의 색·글자는 따라 하지 않음)
      if (nat.style.display !== "none" && /에서 재생 중|Playing on|Listening on/i.test(nat.textContent || "")) {
        const ic = (nat.querySelector("svg") || {}).outerHTML || "";
        if (ic) natInfo.icon = ic;
      }
    }
    let want;
    const remote = remote0;
    if (!enabled) want = "none";
    else if (mode === "cast" || remote) want = "airplay";
    else if (busy && barState !== "none") want = barState;           // 전환 중엔 그대로 유지 (사라졌다 나타나지 않게)
    else if (nat || speakerActiveSync()) want = "connect";
    else want = "none";
    // Spotify 원래 줄: 쓰는 동안만 숨기고, 다른 줄로 바뀌었거나(예: 데스크탑에서 재생 중) 안 쓰면 반드시 되돌림
    if (natHiddenEl && (natHiddenEl !== nat || want === "none")) { natHiddenEl.style.display = ""; natHiddenEl = null; }
    if (nat) { nat.style.display = want === "none" ? "" : "none"; if (want !== "none") natHiddenEl = nat; }
    setNativeHideCss(want !== "none");
    let bar = document.getElementById(BAR_ID);
    if (want === "none") {
      if (bar && barState !== "none" && !barHideTimer) {
        bar.style.opacity = "0";
        barHideTimer = setTimeout(() => { barHideTimer = null; if (barState === "none") bar.style.display = "none"; }, 1550);
      }
      barState = "none";
      return;
    }
    if (barHideTimer) { clearTimeout(barHideTimer); barHideTimer = null; }
    if (!bar) {
      bar = document.createElement("div");
      bar.id = BAR_ID;
      bar.style.cssText = "display:flex;align-items:center;justify-content:flex-end;gap:8px;width:100%;box-sizing:border-box;" +
        "height:24px;padding:0 16px;background:#1ed760;color:#000;font-size:14px;font-weight:600;line-height:24px;" +
        "border-radius:0;flex-shrink:0;opacity:0;transition:background-color 2.6s ease, opacity 1.5s ease;";
      bar.innerHTML = `<span class="lc-bar-in" style="display:flex;align-items:center;gap:5px;transition:opacity 1s ease"></span>`;
    }
    if (bar.parentElement !== host || bar.previousElementSibling !== npb) npb.insertAdjacentElement("afterend", bar);
    const bg = want === "airplay" ? "#4fb3ff" : "#1ed760";
    const text = want === "airplay" ? `${remote && mode !== "cast" ? airplayNameOf(remote.speaker) : airplayName()}에서 재생 중` : `${activeName() || lastSpeakerName || cfg.speaker_name}에서 재생 중`;
    const icon = want === "airplay" ? BAR_AIRPLAY_ICON : (natInfo.icon ? iconHtml(natInfo.icon, 16) : speakerIcon(16));
    bar.style.backgroundColor = bg;
    const inner = bar.querySelector(".lc-bar-in");
    const html = icon + `<span>${text.replace(/</g, "&lt;")}</span>`;
    if (inner.dataset.html !== html) {
      inner.dataset.html = html;
      if (barState === "none" || !inner.innerHTML) inner.innerHTML = html;
      else {
        // 글자·아이콘은 살짝 흐려졌다가 바뀜
        inner.style.opacity = "0";
        setTimeout(() => { inner.innerHTML = inner.dataset.html; inner.style.opacity = "1"; }, 1000);
      }
    }
    if (bar.style.display === "none" || barState === "none") {
      bar.style.display = "flex";
      requestAnimationFrame(() => { bar.style.opacity = "1"; });
    } else bar.style.opacity = "1";
    barState = want;
  }
  setInterval(() => { try { updateBar(); } catch (e) { /* 무시 */ } }, 100);
  // Spotify가 아래 줄을 새로 그리는 즉시(화면에 그려지기 전) 처리 → 두 줄이 잠깐도 안 보이게
  let barObsTarget = null, barQueued = false;
  setInterval(() => {
    try {
      const npb = document.querySelector(".main-nowPlayingBar-container") || document.querySelector("[data-testid='now-playing-bar']");
      const root = npb && npb.parentElement && npb.parentElement.parentElement;
      if (!root || root === barObsTarget) return;
      barObsTarget = root;
      new MutationObserver(() => {
        if (barQueued) return;
        barQueued = true;
        queueMicrotask(() => { barQueued = false; try { natSearchAt = 0; updateBar(); } catch (e) { /* 무시 */ } });
      }).observe(root, { childList: true, subtree: true });
    } catch (e) { /* 무시 */ }
  }, 1000);

  setInterval(async () => {
    try {
      if (speakerId && !lastSpeakerName) {
        const d = (await devices()).find((x) => x.id === speakerId);
        if (d) lastSpeakerName = d.name;
      }
      try { captureSpeakerIcon(); } catch (e) { /* 무시 */ }
      updateBar();
      patchPicker();
      castPanel();
    } catch (e) { /* 무시 */ }
  }, 400);


  // ───────── 오른쪽 "재생목록"(다음 재생) 패널에 로컬파일 끼워 넣기 ─────────
  // Spotify Connect는 대기열에서 로컬파일을 빼버림 → 재생목록 순서대로 원래 자리에 로컬파일 줄을 표시
  // (누르면 바로 AirPlay로 재생)
  const QMARK = "data-localcast-q";
  const NOTE_IMG = "data:image/svg+xml;utf8," + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#333"/><path d="M40 16v22.5a6.5 6.5 0 1 1-3.5-5.8V24.5l-12 3v15a6.5 6.5 0 1 1-3.5-5.8V21z" fill="#b3b3b3"/></svg>`);
  const artCache = new Map();   // uri → blob URL | null
  function artFor(uri, img) {
    if (artCache.has(uri)) { const u = artCache.get(uri); if (u) img.src = u; return; }
    artCache.set(uri, null);
    fetch(HELPER + "/art?uri=" + encodeURIComponent(uri)).then((r) => (r.ok ? r.blob() : null)).then((b) => {
      if (!b) return;
      const u = URL.createObjectURL(b);
      artCache.set(uri, u);
      document.querySelectorAll(`[${QMARK}]`).forEach((el) => {
        if (el.getAttribute(QMARK) === uri) el.querySelectorAll("img").forEach((i) => { i.src = u; });
      });
    }).catch(() => {});
  }
  function textNodesIn(root) {
    const out = [];
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = w.nextNode())) if ((n.nodeValue || "").trim()) out.push(n);
    return out;
  }
  // 다음 재생(재생목록 쪽) 제목 줄
  function queueHeading() {
    let found = null;
    const roots = Array.from(document.querySelectorAll("aside"));
    const nodes = [];
    for (const r of (roots.length ? roots : [document.body])) nodes.push(...textNodesIn(r));
    for (const n of nodes) {
      const t = n.nodeValue.trim();
      if ((/^다음 재생/.test(t) || /^Next from/i.test(t)) && t.length < 80 && !n.parentElement.closest(`[${QMARK}]`)) found = n.parentElement;
    }
    if (found) {
      try {
        const full = (found.parentElement || found).textContent.trim();
        const d = Spicetify.Player.data;
        const ctx = playlistOf(d && d.context && d.context.uri);
        if (ctx && /^다음 재생|^Next from/i.test(full) && full.length < 80) ctxTitles.set(ctx, full);
      } catch (e) { /* 무시 */ }
    }
    return found;   // 마지막 것 = 재생목록(컨텍스트) 섹션
  }
  const ctxTitles = new Map();
  function ctxTitle(ctx) {
    if (ctxTitles.has(ctx)) return ctxTitles.get(ctx);
    const d = Spicetify.Player.data;
    const nm = d && d.context && d.context.metadata && (d.context.metadata.context_description || d.context.metadata.name);
    if (nm) return "다음 재생 " + nm;
    if (!ctxTitles.has("fetch:" + ctx)) {
      ctxTitles.set("fetch:" + ctx, "");
      try {
        Promise.resolve(Spicetify.Platform.PlaylistAPI.getMetadata(ctx)).then((m) => { if (m && m.name) ctxTitles.set(ctx, "다음 재생 " + m.name); }).catch(() => {});
      } catch (e) { /* 무시 */ }
    }
    return "다음 재생";
  }
  // 재생목록 끝부분에서 Spotify가 "다음 재생 ○○" 칸을 없앴을 때: 그 칸을 만들어 로컬파일을 넣음
  function buildCtxSection(nowRow, locals, afterEl) {
    const label = nowRow.label;
    if (!label) return 0;
    const d = Spicetify.Player.data;
    const ctx = playlistOf(d && d.context && d.context.uri);
    const title = ctxTitle(ctx);
    let S = label;
    while (S && !S.contains(nowRow.row)) S = S.parentElement;
    if (!S) return 0;
    const rows = locals.map((l) => makeLocalRow(nowRow, l));
    const flat = textNodesIn(S).some((n) => n.parentElement !== label && !n.parentElement.closest(`[${QMARK}]`) && /^(다음|Next)/i.test(n.nodeValue.trim()) && n.nodeValue.trim().length < 80);
    const setLabel = (root) => {
      const t = textNodesIn(root).find((n) => /^(지금 재생 중|Now playing)/i.test(n.nodeValue.trim()));
      if (t) t.nodeValue = title;
    };
    if (!flat) {
      // 칸(섹션) 통째로 복사해서 제목만 바꾸고 줄을 로컬파일로
      const S2 = S.cloneNode(true);
      S2.setAttribute(QMARK, "section");
      S2.querySelectorAll("[id]").forEach((e) => e.removeAttribute("id"));
      setLabel(S2);
      const path = [];
      for (let el = nowRow.row; el && el !== S; el = el.parentElement) path.unshift(Array.prototype.indexOf.call(el.parentElement.children, el));
      let target = S2;
      for (const i of path) target = target && target.children[i];
      if (!target) return 0;
      // 원래 있던 다른 줄들은 지움
      Array.from(S2.querySelectorAll('[role="row"], li')).forEach((r) => { if (r !== target && !r.contains(target)) r.remove(); });
      const frag = document.createDocumentFragment();
      rows.forEach((r) => frag.appendChild(r));
      target.replaceWith(frag);
      (afterEl && S.contains(afterEl) ? S : S).insertAdjacentElement("afterend", S2);
    } else {
      // 제목과 줄이 한 목록에 나란히 있는 구조: 제목 줄을 복사해서 지금 곡 뒤에 끼움
      let hb = label; while (hb.parentElement && hb.parentElement !== S) hb = hb.parentElement;
      let rb = afterEl || nowRow.row; while (rb.parentElement && rb.parentElement !== S) rb = rb.parentElement;
      const H2 = hb.cloneNode(true);
      H2.setAttribute(QMARK, "heading");
      setLabel(H2);
      rb.insertAdjacentElement("afterend", H2);
      let prev = H2;
      rows.forEach((r) => { prev.insertAdjacentElement("afterend", r); prev = r; });
    }
    return rows.length;
  }
  function rowOf(el, heading) {
    let r = el.closest('[role="row"], li, [role="listitem"], [draggable="true"]');
    if (r && !r.contains(heading)) return r;
    // 역할 표시가 없으면: 제목에서 위로 올라가며 이미지가 들어 있는 첫 덩어리
    r = el;
    for (let i = 0; i < 8 && r && r.parentElement; i++, r = r.parentElement) {
      if (r.querySelector("img") && !r.contains(heading) && r.parentElement.children.length > 1) return r;
    }
    return null;
  }
  // heading 뒤에서 제목이 name인 줄 (없으면 null)
  function findQueueRow(heading, name) {
    const want = norm(name);
    for (const n of textNodesIn(heading.closest("aside") || document.body)) {
      if (norm(n.nodeValue) !== want) continue;
      if (!(heading.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
      if (n.parentElement.closest(`[${QMARK}]`)) continue;
      const r = rowOf(n.parentElement, heading);
      if (r) return { row: r, titleEl: n.parentElement };
    }
    return null;
  }
  function firstRowAfter(heading, anyName) {
    // 다음 재생 목록의 첫 줄: 대기열 첫 곡 이름으로 찾음
    return anyName ? findQueueRow(heading, anyName) : null;
  }
  function makeLocalRow(tpl, local) {
    const c = tpl.row.cloneNode(true);
    c.setAttribute(QMARK, local.uri);
    c.removeAttribute("aria-selected"); c.removeAttribute("id"); c.setAttribute("draggable", "false");
    c.querySelectorAll("[id]").forEach((e) => e.removeAttribute("id"));
    // 제목
    const titleText = norm(tpl.titleEl.textContent);
    const texts = textNodesIn(c);
    const tNode = texts.find((n) => norm(n.nodeValue) === titleText);
    if (tNode) {
      tNode.nodeValue = local.name || localTitle(local.uri);
    }
    // 아티스트 줄: 제목 블록 바로 다음 요소를 아티스트로 (뮤직비디오 표시 등은 지움)
    if (tNode) {
      let t = tNode.parentElement;
      while (t && t !== c && !t.nextElementSibling && t.parentElement !== c) t = t.parentElement;
      const sub = t && t !== c ? t.nextElementSibling : null;
      if (sub) { sub.textContent = local.artist || "로컬 파일"; sub.classList.add("lc-sub"); }
      // "지금 재생 중" 줄을 본떠 만든 경우: 초록 제목 → 일반 흰색
      if (tpl.now) { for (let e = tNode.parentElement; e && e !== c && !(sub && e.contains(sub)); e = e.parentElement) e.style.color = "var(--text-base, #fff)"; }
      texts.forEach((n) => { if (n !== tNode && n.parentElement && !(sub && sub.contains(n))) n.nodeValue = ""; });
    }
    c.querySelectorAll("svg").forEach((e) => { if (!e.closest("img")) e.remove(); });
    c.querySelectorAll("button").forEach((e) => { e.style.visibility = "hidden"; });
    c.querySelectorAll("img").forEach((i) => { i.removeAttribute("srcset"); i.src = NOTE_IMG; });
    // 커서를 올리면 앨범 사진 위에 재생(▶) 표시 — Spotify와 같게
    const img0 = c.querySelector("img");
    if (img0 && img0.parentElement) {
      const box = img0.parentElement;
      if (getComputedStyle(box).position === "static") box.style.position = "relative";
      const ov = document.createElement("div");
      ov.className = "lc-play";
      ov.innerHTML = `<svg viewBox="0 0 24 24" width="24" height="24" fill="#fff" aria-hidden="true"><path d="M7.05 3.606l13.49 7.788a.7.7 0 0 1 0 1.212L7.05 20.394A.7.7 0 0 1 6 19.788V4.212a.7.7 0 0 1 1.05-.606z"/></svg>`;
      box.appendChild(ov);
    }
    ensureQueueCss();
    c.querySelectorAll("img").forEach((i) => artFor(local.uri, i));
    c.title = "로컬파일 — 누르면 AirPlay로 재생";
    c.style.cursor = "pointer";
    const go = (e) => {
      e.preventDefault(); e.stopPropagation(); if (e.stopImmediatePropagation) e.stopImmediatePropagation();
      if (e.type !== "dblclick" && e.type !== "click") return;
      if (busy) return notify("전환 중이에요. 잠시 후 다시 시도하세요", true);
      log("다음 재생 목록에서 로컬파일 선택: " + local.name);
      enterCast({ row: local, ctxUri: local.ctx, manual: true, reason: "다음 재생 목록에서 선택 → " + local.name });
    };
    ["click", "dblclick", "mousedown", "pointerdown", "contextmenu"].forEach((ev) => c.addEventListener(ev, go, true));
    return c;
  }
  function ensureQueueCss() {
    if (document.getElementById("localcast-queue-css")) return;
    const st = document.createElement("style");
    st.id = "localcast-queue-css";
    st.textContent = `
      li[${QMARK}], div[${QMARK}][role="row"] { border-radius: 6px; }
      [${QMARK}]:not([${QMARK}="section"]):not([${QMARK}="heading"]):hover { background-color: rgba(255,255,255,.1) !important; }
      [${QMARK}] .lc-play { position: absolute; inset: 0; display: none; align-items: center; justify-content: center;
        background: rgba(0,0,0,.5); border-radius: inherit; pointer-events: none; }
      [${QMARK}]:hover .lc-play { display: flex; }
      [${QMARK}]:hover .lc-sub, [${QMARK}]:hover .lc-sub * { color: var(--text-base, #fff) !important; }
    `;
    document.head.appendChild(st);
  }
  let lastQueueSig = "";
  let queueDiag = false;
  function removeQueueRows() { document.querySelectorAll(`[${QMARK}]`).forEach((e) => e.remove()); }
  // 제목 글자(예: "지금 재생 중") 다음에 나오는, 이름이 name인 줄
  function findRowAfterLabel(labelRe, name) {
    const roots = Array.from(document.querySelectorAll("aside"));
    const want = norm(name);
    for (const r of (roots.length ? roots : [document.body])) {
      let label = null;
      for (const n of textNodesIn(r)) {
        if (n.parentElement.closest(`[${QMARK}]`)) continue;
        if (!label) { if (labelRe.test(n.nodeValue.trim())) label = n.parentElement; continue; }
        if (norm(n.nodeValue) === want) { const row = rowOf(n.parentElement, label); if (row) return { row, titleEl: n.parentElement, now: true, label }; }
      }
    }
    return null;
  }
  function patchQueue() {
    const d = Spicetify.Player.data;
    const item = d && d.item;
    const ctx = playlistOf(d && d.context && d.context.uri);
    const cleanup = () => { if (lastQueueSig) { removeQueueRows(); lastQueueSig = ""; } };
    if (!enabled || !helperOk || mode !== "connect" || !item || !speakerActiveSync()) return cleanup();
    // 1) 사용자가 대기열에 넣은 로컬파일 → 지금 재생 중 바로 아래
    const entries = userLocalQueue.map((l) => ({ local: { ...l, ctx }, pos: "now" }));
    // 2) 재생목록 순서상 앞으로 나올 로컬파일
    let firstName = null;
    if (ctx && !isShuffle(d)) {
      if (plCache.uri !== ctx) playlistRows(ctx).catch(() => {});
      else {
        const rows = plCache.rows;
        const ci = findRow(rows, item);
        if (ci >= 0) {
          let prev = null;
          for (let j = ci + 1; j < rows.length && j <= ci + 80; j++) {
            const r = rows[j];
            if (r.isLocal) entries.push({ local: { ...r, ctx }, pos: prev ? "after" : "top", after: prev });
            else { if (!firstName) firstName = r.name; prev = r.name; }
          }
        }
      }
    }
    if (!entries.length) return cleanup();
    const sig = keyOf(item) + "|" + entries.map((e) => e.local.uri + "@" + e.pos + (e.after || "")).join(",");
    const existing = Array.from(document.querySelectorAll(`[${QMARK}]`));
    if (sig === lastQueueSig && existing.length && existing.every((e) => e.previousElementSibling || e.nextElementSibling)) return;
    const nowRow = findRowAfterLabel(/^(지금 재생 중|Now playing)/i, nameOf(item));
    const heading = queueHeading();
    if (!nowRow && !heading) return cleanup();
    removeQueueRows();
    let lastNow = null, lastTop = null, placed = 0;
    const orphans = [];
    const lastAfter = new Map();
    for (const e of entries) {
      let tpl = null, node = null, before = false;
      if (e.pos === "now") {
        if (!nowRow) continue;
        tpl = nowRow; node = lastNow || nowRow.row;
      } else if (e.pos === "top") {
        const f = heading && firstName ? findQueueRow(heading, firstName) : null;
        if (lastTop) { tpl = f || nowRow; node = lastTop; }
        else if (f) { tpl = f; node = f.row; before = true; }
        else if (nowRow && !heading) { orphans.push(e); continue; }   // 재생목록 끝부분: 따로 "다음 재생" 칸을 만들어 넣음
        else continue;
      } else {
        const a = heading ? findQueueRow(heading, e.after) : null;
        if (!a) continue;
        tpl = a; node = lastAfter.get(e.after) || a.row;
      }
      if (!tpl) continue;
      const pos = getComputedStyle(tpl.row).position;
      if (!queueDiag) {
        queueDiag = true;
        const r = tpl.row;
        log(`[진단] 다음 재생 목록 줄: <${r.tagName.toLowerCase()} role=${r.getAttribute("role")} class=${String(r.className).slice(0, 60)}> position=${pos} 형제 ${r.parentElement ? r.parentElement.children.length : 0}개`);
      }
      if (pos === "absolute" || pos === "fixed") continue;
      const el = makeLocalRow(tpl, e.local);
      if (before) node.insertAdjacentElement("beforebegin", el);
      else node.insertAdjacentElement("afterend", el);
      if (e.pos === "now") lastNow = el;
      else if (e.pos === "top") { lastTop = el; if (!before) lastNow = lastNow; }
      else lastAfter.set(e.after, el);
      placed++;
    }
    if (orphans.length && nowRow) placed += buildCtxSection(nowRow, orphans.map((e) => e.local), lastNow);
    lastQueueSig = sig;
    if (placed && !diagSeen.has("queue:" + sig)) { diagSeen.add("queue:" + sig); log(`다음 재생 목록에 로컬파일 ${placed}곡 표시`); }
  }
  setInterval(() => { try { patchQueue(); } catch (e) { console.warn(TAG, "다음 재생 목록 표시 오류", e); } }, 500);

  // ───────── 스피커 연결 중에도 재생목록에 로컬파일 보이게 ─────────
  // Spotify는 Connect 기기에서 재생할 수 없는 로컬파일을 "재생 불가"로 표시해 숨김.
  // LocalCast가 AirPlay로 보내므로, 재생목록 데이터를 받을 때 로컬파일을 "재생 가능"으로 바꿔 보여줌.
  function speakerActiveSync() {
    try {
      const a = Spicetify.Platform.ConnectAPI && Spicetify.Platform.ConnectAPI.state && Spicetify.Platform.ConnectAPI.state.activeDevice;
      return !!a && !a.isLocal && isSpeaker({ name: a.name });
    } catch (e) { return false; }
  }
  const diagSeen = new Set();
  // ── 스피커 연결 중 재생목록에 로컬파일 표시 ──
  // 원인이 두 가지일 수 있어서 자동으로 확인:
  //  (1) Spotify 화면용 요청 옵션이 로컬파일을 뺌 → 그 옵션을 빼고 요청 (plFix.keys)
  //  (2) 데이터에는 있는데 화면이 "로컬파일 + 스피커"라서 숨김 → 로컬파일을 일반 곡처럼 보이게 (plFix.mask)
  const PLFIX_KEY = "localcast:plfix3";
  let plFix = (() => { try { const v = JSON.parse(localStorage.getItem(PLFIX_KEY) || "null"); return v && typeof v === "object" ? v : null; } catch (e) { return null; } })();
  function savePlFix() { try { localStorage.setItem(PLFIX_KEY, JSON.stringify(plFix)); } catch (e) { /* 무시 */ } }
  const isLocalItem = (it) => !!it && (it.isLocal === true || String(it.uri || "").startsWith("spotify:local:"));
  function fixLocalItems(list, where) {
    if (!Array.isArray(list)) return list;
    const mask = !!(plFix && plFix.mask);
    let changed = 0;
    const out = list.map((it) => {
      if (!isLocalItem(it)) return it;
      if (mask) { changed++; return { ...it, isLocal: false, isPlayable: true, localcastLocal: true }; }
      if (it.isPlayable === false) { changed++; return { ...it, isPlayable: true }; }
      return it;
    });
    if (changed && !diagSeen.has(where + mask)) { diagSeen.add(where + mask); log(`[진단] 재생목록 로컬파일 ${changed}곡 표시 (${where}${mask ? ", 일반 곡처럼" : ""})`); }
    return changed ? out : list;
  }
  function fixResult(v, where) {
    try {
      if (!enabled || !v || typeof v !== "object" || !speakerActiveSync()) return v;
      let r = v;
      if (Array.isArray(v.items)) r = { ...r, items: fixLocalItems(v.items, where) };
      if (v.contents && Array.isArray(v.contents.items)) r = { ...r, contents: { ...v.contents, items: fixLocalItems(v.contents.items, where + ".contents") } };
      return r;
    } catch (e) { return v; }
  }
  let rawGetContents = null;
  let probing = false;
  let probedUris = new Set();
  async function allItems(uri, opts) {
    const out = [];
    for (let offset = 0; offset < 10000; offset += 100) {
      const r = await rawGetContents(uri, { ...opts, offset, limit: 100 });
      const items = (r && r.items) || [];
      out.push(...items);
      if (items.length < 100) break;
    }
    return out;
  }
  function uiOptions(opts, keys) {
    if (!keys) return opts;
    if (keys === "all") { const o = {}; if (opts.offset !== undefined) o.offset = opts.offset; if (opts.limit !== undefined) o.limit = opts.limit; return o; }
    const o = { ...opts };
    for (const k of keys) delete o[k];
    return o;
  }
  async function probeLocalFilter(uri, opts, manual) {
    if (probing || !rawGetContents || !playlistOf(uri)) return;
    if (!manual && (probedUris.has(uri) || (plFix && (plFix.mask || plFix.keys)))) return;
    probedUris.add(uri);
    probing = true;
    try {
      const nLocal = (arr) => arr.filter(isLocalItem).length;
      const base = { ...opts }; delete base.offset; delete base.limit;
      const fullL = nLocal(await allItems(uri, {}));
      if (!fullL) { if (manual) notify("이 재생목록에는 로컬파일이 없어요"); return; }
      const uiL = nLocal(await allItems(uri, base));
      log(`[진단] 로컬파일: 재생목록 ${fullL}곡 / Spotify 화면용 요청 ${uiL}곡 (옵션 키: ${Object.keys(base).join(",")})`);
      if (uiL >= fullL) {
        plFix = { keys: null, mask: true };
        log("[진단] 데이터에는 있는데 화면이 숨김 → 로컬파일을 일반 곡처럼 표시");
      } else {
        let keys = null;
        for (const k of Object.keys(base)) {
          const o = { ...base }; delete o[k];
          if (nLocal(await allItems(uri, o)) >= fullL) { keys = [k]; break; }
        }
        if (!keys) keys = "all";
        plFix = { keys, mask: false };
        log(`[진단] 로컬파일을 빼는 옵션: ${keys === "all" ? "(여러 개) → 기본 옵션만 사용" : keys.map((k) => k + "=" + JSON.stringify(base[k]).slice(0, 80)).join(", ")}`);
      }
      savePlFix();
      notify("재생목록에 로컬파일을 표시하도록 설정했어요");
      reopenPage();
    } catch (e) {
      log("[진단] 로컬파일 표시 확인 오류: " + errMsg(e));
    } finally {
      probing = false;
    }
  }
  // 재생목록 화면을 다시 열어서 바로 반영
  function reopenPage() {
    try {
      const H = Spicetify.Platform.History;
      const path = H.location.pathname;
      if (!/^\/playlist\//.test(path)) return;
      H.push("/");
      setTimeout(() => { try { H.push(path); } catch (e) { /* 무시 */ } }, 250);
    } catch (e) { /* 무시 */ }
  }
  // 이미 고쳤는데도 안 보일 때: 다음 방식으로 넘어감 (옵션 → 일반 곡처럼 → 옵션 전부 제거+일반 곡처럼)
  function nextPlFixStage() {
    if (!plFix) plFix = { keys: null, mask: false };
    if (!plFix.mask) plFix = { keys: plFix.keys, mask: true };
    else if (plFix.keys !== "all") plFix = { keys: "all", mask: true };
    else plFix = { keys: null, mask: false };
    savePlFix();
    log("[진단] 재생목록 표시 방식 변경: " + JSON.stringify(plFix));
    notify("표시 방식을 바꿨어요");
    reopenPage();
  }
  function patchPlaylistAPI() {
    const P = Spicetify.Platform.PlaylistAPI;
    if (!P || P.__localcastItems) return !!P;
    // 재생목록 곡 목록(getContents)만 건드림. 스피커(Connect) 연결 중이 아니면 Spotify가 준 그대로 돌려줌
    const wrapped = [];
    for (const n of ["getContents"]) {
      if (typeof P[n] !== "function") continue;
      const orig = P[n].bind(P);
      rawGetContents = orig;
      P[n] = function (...args) {
        const onSpk = enabled && speakerActiveSync();
        if (!onSpk) return orig(...args);
        const isPl = !!playlistOf(args[0]) && args[1] && typeof args[1] === "object";
        const fromUi = isPl && Object.keys(args[1]).length > 2;   // LocalCast 자신의 요청은 {offset, limit}뿐
        if (fromUi && plFix && plFix.keys) args = [args[0], uiOptions(args[1], plFix.keys), ...args.slice(2)];
        const res = orig(...args);
        if (fromUi && res && typeof res.then === "function") {
          const o = args[1];
          res.then(() => probeLocalFilter(args[0], o, false)).catch(() => {});
        }
        if (!diagSeen.has("call:" + n)) {
          diagSeen.add("call:" + n);
          try { log(`[진단] PlaylistAPI.${n} 호출 옵션: ${JSON.stringify(args[1] || {}).slice(0, 300)}`); } catch (e) { /* 무시 */ }
        }
        if (res && typeof res.then === "function") return res.then((v) => fixResult(v, "PlaylistAPI." + n));
        return fixResult(res, "PlaylistAPI." + n);
      };
      wrapped.push(n);
    }
    P.__localcastItems = true;
    console.log(TAG, "재생목록 로컬파일 표시 패치:", wrapped.join(","));
    return true;
  }
  (async () => {
    for (let i = 0; i < 100 && !patchPlaylistAPI(); i++) await sleep(300);
  })();

  // ───────── 로컬파일을 그냥 재생했을 때 가로채기 ─────────
  // 스피커(Connect)에 연결된 상태에서 로컬파일을 더블클릭/재생 버튼으로 틀면
  // Spotify가 "재생할 수 없습니다"를 띄우는 대신 LocalCast로 재생
  async function localTarget(context, options) {
    const skip = (options && options.skipTo) || null;
    const ctxUri = String((context && context.uri) || "");
    if (skip && skip.uri && String(skip.uri).startsWith("spotify:local:")) return { uri: skip.uri, uid: skip.uid, name: localTitle(skip.uri) };
    if (ctxUri.startsWith("spotify:local:")) return { uri: ctxUri, name: localTitle(ctxUri) };
    const pl = playlistOf(ctxUri);
    if (pl && Spicetify.Platform.PlaylistAPI) {
      const rows = await playlistRows(pl);
      let r = null;
      if (skip && skip.uid) r = rows.find((x) => x.uid === skip.uid) || null;
      else if (skip && skip.uri) r = rows.find((x) => sameTrack(x.uri, skip.uri)) || null;
      else if (!skip) r = rows[0] || null;
      if (r && r.isLocal) return r;
    }
    return null;
  }
  // 더블클릭/줄의 재생 버튼: Spotify가 스피커에서 재생 불가로 막아 play()를 부르지 않는 경우 대비
  function pagePlaylist() {
    try {
      const m = String(Spicetify.Platform.History.location.pathname || "").match(/^\/playlist\/([A-Za-z0-9]+)/);
      return m ? "spotify:playlist:" + m[1] : null;
    } catch (e) { return null; }
  }
  function rowFromDom(rowEl) {
    const pl = pagePlaylist();
    if (!pl) return null;
    if (plCache.uri !== pl) { playlistRows(pl).catch(() => {}); return null; }
    const rows = plCache.rows;
    const text = norm(rowEl.textContent);
    const idx = parseInt(rowEl.getAttribute("aria-rowindex"), 10) - 2;
    const r = rows[idx];
    if (r && r.name && text.includes(norm(r.name))) return r.isLocal ? { row: r, pl } : null;
    // 정렬/필터로 번호가 다를 때: 이름이 맞는 로컬파일이 하나뿐이면 그것
    const hits = rows.filter((x) => x.isLocal && x.name && text.includes(norm(x.name)));
    return hits.length === 1 ? { row: hits[0], pl } : null;
  }
  function domPlay(e, why) {
    try {
      if (!enabled || !helperOk || busy || !speakerActiveSync()) return;
      const rowEl = e.target && e.target.closest && e.target.closest('[role="row"]');
      if (!rowEl) return;
      const hit = rowFromDom(rowEl);
      if (!hit) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.stopImmediatePropagation) e.stopImmediatePropagation();
      log(`재생 가로채기(${why}): ${hit.row.name}`);
      enterCast({ row: hit.row, ctxUri: hit.pl, manual: true, reason: "로컬파일 " + why + " → 스피커로" });
    } catch (err) { console.warn(TAG, "재생 가로채기 오류", err); }
  }
  document.addEventListener("dblclick", (e) => domPlay(e, "더블클릭"), true);
  document.addEventListener("click", (e) => {
    const b = e.target && e.target.closest && e.target.closest("button");
    if (!b || !b.closest('[role="row"]')) return;
    const cell = b.closest('[role="gridcell"]');
    if (!cell || cell.getAttribute("aria-colindex") !== "1") return;   // 줄 맨 앞 재생 버튼만
    domPlay(e, "재생 버튼");
  }, true);
  // 스피커 연결 중 재생목록을 열면 미리 읽어둠 (더블클릭 때 바로 판단)
  setInterval(() => {
    try {
      const pl = pagePlaylist();
      if (pl && enabled && speakerActiveSync() && (plCache.uri !== pl || Date.now() - plCache.t > 55000)) playlistRows(pl).catch(() => {});
    } catch (e) { /* 무시 */ }
  }, 2000);

  function hookPlay(obj, label) {
    if (!obj || typeof obj.play !== "function" || obj.__localcastHooked) return false;
    const orig = obj.play.bind(obj);
    obj.play = async function (context, logging, options) {
      try {
        if (enabled && helperOk && !internalPlay && !busy) {
          const act = (await devices()).find((d) => d.active);
          if (act && isSpeaker(act)) {
            const target = await localTarget(context, options);
            if (target) {
              log(`재생 가로채기(${label}): ${target.name || target.uri}`);
              enterCast({ row: target, ctxUri: playlistOf(context && context.uri), manual: true, reason: "로컬파일 재생 → 스피커로" });
              return;
            }
          }
        }
      } catch (e) { console.warn(TAG, "재생 가로채기 오류", e); }
      return orig(context, logging, options);
    };
    obj.__localcastHooked = true;
    return true;
  }
  // 다음/이전 곡 버튼: 스피커가 로컬파일을 건너뛰기 전에 바로 로컬파일로
  async function speakerActive() {
    const act = (await devices()).find((d) => d.active);
    return !!act && isSpeaker(act);
  }
  async function onNext() {
    if (!(enabled && helperOk && !internalPlay && !busy)) return false;
    if (!(await speakerActive())) return false;
    const data = Spicetify.Player.data;
    const item = data && data.item;
    if (!item || isLocalTrack(item)) return false;
    const p = await makePlan(data, item);
    if (!p || !p.row) return false;
    switchedFor = p.key;
    enterCast({ row: p.row, ctxUri: p.ctxUri, manual: true, reason: "다음 곡 버튼 → 로컬파일 " + (p.row.name || localTitle(p.row.uri)) });
    return true;
  }
  async function onPrev() {
    if (!(enabled && helperOk && !internalPlay && !busy)) return false;
    if (Spicetify.Player.getProgress() > 3000) return false;   // 3초 넘으면 원래대로 곡 처음으로
    if (mode === "cast") {
      // 로컬파일(AirPlay) 재생 중 이전 곡: 재생목록에서 바로 앞 곡을 정확히 틀기
      const d0 = Spicetify.Player.data;
      const it0 = d0 && d0.item;
      const ctx0 = playlistOf(d0 && d0.context && d0.context.uri) || plCache.uri;
      if (!it0 || !isLocalTrack(it0) || !ctx0 || isShuffle(d0)) return false;
      const rows0 = await playlistRows(ctx0);
      const i0 = findRow(rows0, it0);
      if (i0 <= 0) return false;
      const pr = rows0[i0 - 1];
      log("이전 곡 버튼(로컬파일 재생 중) → " + pr.name);
      internalPlay++;
      try { await Spicetify.Player.playUri(ctx0, {}, { skipTo: { uid: pr.uid, uri: pr.uri } }); }
      catch (e) { log("이전 곡 재생 오류: " + errMsg(e)); internalPlay--; return false; }
      internalPlay--;
      return true;
    }
    if (!(await speakerActive())) return false;
    const data = Spicetify.Player.data;
    const item = data && data.item;
    const ctxUri = playlistOf(data && data.context && data.context.uri);
    if (!item || !ctxUri || isShuffle(data) || !Spicetify.Platform.PlaylistAPI) return false;
    const rows = await playlistRows(ctxUri);
    const ci = findRow(rows, item);
    if (ci > 0 && rows[ci - 1].isLocal) {
      enterCast({ row: rows[ci - 1], ctxUri, manual: true, reason: "이전 곡 버튼 → 로컬파일 " + rows[ci - 1].name });
      return true;
    }
    return false;
  }
  function hookMethod(obj, name, handler) {
    const flag = "__localcast_" + name;
    if (!obj || typeof obj[name] !== "function" || obj[flag]) return;
    const orig = obj[name].bind(obj);
    obj[name] = async function (...args) {
      try { if (await handler()) return; } catch (e) { console.warn(TAG, name + " 가로채기 오류", e); }
      return orig(...args);
    };
    obj[flag] = true;
  }
  // 대기열에 추가 / 다음에 재생: 스피커 연결 중이면 로컬파일은 LocalCast가 기억했다가 AirPlay로
  const uriOfQ = (x) => (typeof x === "string" ? x : (x && (x.uri || (x.contextTrack && x.contextTrack.uri))) || "");
  function hookQueue(obj, name) {
    const flag = "__localcastq_" + name;
    if (!obj || typeof obj[name] !== "function" || obj[flag]) return;
    const orig = obj[name].bind(obj);
    const front = !/^addToQueue$/i.test(name);   // addToQueue = 맨 뒤, 그 외(insert/playNext) = 맨 앞
    obj[name] = async function (items, ...rest) {
      try {
        if (!diagSeen.has("q:" + name)) { diagSeen.add("q:" + name); log(`[진단] PlayerAPI.${name} 호출: ${JSON.stringify(items).slice(0, 200)} ${JSON.stringify(rest).slice(0, 120)}`); }
        if (/clear/i.test(name) && userLocalQueue.length) { userLocalQueue = []; plan = null; lastQueueSig = ""; }
        const list = Array.isArray(items) ? items : items ? [items] : [];
        if (enabled && helperOk && !internalPlay && speakerActiveSync() && /add|insert|next/i.test(name)) {
          const locals = list.filter((x) => uriOfQ(x).startsWith("spotify:local:"));
          if (locals.length) {
            const add = locals.map((x) => { const u = uriOfQ(x); return { uri: u, uid: null, name: localPart(u, 4), artist: localPart(u, 2), album: localPart(u, 3), isLocal: true, queued: true }; });
            if (front) userLocalQueue.unshift(...add); else userLocalQueue.push(...add);
            plan = null; lastQueueSig = "";
            log(`로컬파일 대기열 추가(${name}): ${add.map((a) => a.name).join(", ")}`);
            notify(`${add.map((a) => a.name).join(", ")} → 다음 재생에 추가 (AirPlay로 재생)`);
            const others = list.filter((x) => !locals.includes(x));
            if (!others.length) return;
            return orig(Array.isArray(items) ? others : others[0], ...rest);
          }
        }
      } catch (e) { console.warn(TAG, name + " 가로채기 오류", e); }
      return orig(items, ...rest);
    };
    obj[flag] = true;
  }
  (async () => {
    for (let i = 0; i < 100; i++) {
      const PAq = Spicetify.Platform.PlayerAPI;
      if (PAq) {
        const names = new Set([...Object.keys(PAq), ...Object.getOwnPropertyNames(Object.getPrototypeOf(PAq) || {})]);
        for (const n of names) if (/^(addToQueue|insertIntoQueue|playNext|queueNext|addNext|clearQueue)$/i.test(n)) hookQueue(PAq, n);
      }
      const targets = [[Spicetify.Platform.PlayerAPI, "PlayerAPI"]];
      if (Spicetify.Player.origin && Spicetify.Player.origin !== Spicetify.Platform.PlayerAPI) targets.push([Spicetify.Player.origin, "origin"]);
      for (const [obj, label] of targets) {
        hookPlay(obj, label);
        hookMethod(obj, "skipToNext", onNext);
        hookMethod(obj, "skipToPrevious", onPrev);
      }
      if (Spicetify.Platform.PlayerAPI && Spicetify.Platform.PlayerAPI.__localcastHooked) { console.log(TAG, "재생/다음/이전 가로채기 설치됨"); break; }
      await sleep(300);
    }
  })();

  // ───────── 버튼 & 메뉴 ─────────
  const ICON = `<svg role="img" height="20" width="20" viewBox="0 0 24 24" fill="currentColor"><path d="M6.1 18.1A8.5 8.5 0 1 1 17.9 18.1l-1.2-1.3a6.7 6.7 0 1 0-9.4 0z"/><path d="M8.9 15.2a4.6 4.6 0 1 1 6.2 0l-1.2-1.3a2.8 2.8 0 1 0-3.8 0z"/><path d="M12 14.2l5.2 6.3H6.8z"/></svg>`;
  let button = null;

  async function setEnabled(v) {
    enabled = v;
    saveEnabled(v);
    updateButton();
    if (!v && mode === "cast") await exitCast("사용자가 끔");
    notify(v ? "켜짐 — 로컬파일을 스피커로 자동 전송해요" : "꺼짐 — 평소처럼 재생해요");
  }

  // ── 상단 버튼: 오른쪽 위(전체화면 버튼 오른쪽)에, 켜짐/꺼짐 말풍선 표시 ──
  let tipEl = null;
  function tipHtml() {
    return enabled
      ? `<div style="display:flex;align-items:center;gap:8px"><span style="width:8px;height:8px;border-radius:50%;background:#1ed760;display:inline-block"></span><b>LocalCast 켜짐</b></div>` +
        `<div style="margin-top:3px;color:#b3b3b3;font-size:12px;font-weight:400">로컬파일을 오라스튜디오로 자동 전송 · 누르면 끔</div>`
      : `<div style="display:flex;align-items:center;gap:8px"><span style="width:8px;height:8px;border-radius:50%;background:#727272;display:inline-block"></span><b>LocalCast 꺼짐</b></div>` +
        `<div style="margin-top:3px;color:#b3b3b3;font-size:12px;font-weight:400">평소처럼 재생 · 누르면 켬</div>`;
  }
  function showTip() {
    if (!button || !button.button) return;
    if (!tipEl) {
      tipEl = document.createElement("div");
      tipEl.id = "localcast-tip";
      tipEl.style.cssText = "position:fixed;z-index:100000;display:none;pointer-events:none;background:#282828;color:#fff;" +
        "padding:8px 12px;border-radius:8px;font-size:13px;line-height:1.3;white-space:nowrap;box-shadow:0 8px 24px rgba(0,0,0,.6);";
      tipEl.innerHTML = `<div class="lc-tip-body"></div><div class="lc-tip-arrow" style="position:absolute;top:-5px;width:10px;height:10px;background:#282828;transform:rotate(45deg)"></div>`;
      document.body.appendChild(tipEl);
    }
    tipEl.querySelector(".lc-tip-body").innerHTML = tipHtml();
    tipEl.style.display = "block";
    const r = button.button.getBoundingClientRect();
    const w = tipEl.offsetWidth;
    let left = r.left + r.width / 2 - w / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    tipEl.style.left = left + "px";
    tipEl.style.top = (r.bottom + 10) + "px";
    tipEl.querySelector(".lc-tip-arrow").style.left = (r.left + r.width / 2 - left - 5) + "px";
  }
  function hideTip() { if (tipEl) tipEl.style.display = "none"; }
  let btnHover = false;
  function siblingColor() {
    try {
      const right = document.querySelector(".main-actionButtons");
      const sib = right && Array.from(right.querySelectorAll("button")).find((x) => x !== (button && button.button));
      return sib ? getComputedStyle(sib).color : "";
    } catch (e) { return ""; }
  }
  function updateButton() {
    if (!button || !button.button) return;
    try {
      const b = button.button;
      b.setAttribute("aria-label", enabled ? "LocalCast 켜짐" : "LocalCast 꺼짐");
      b.removeAttribute("title");
      // 옆 버튼들과 같게: 배경 없음, 회색 (켜짐/꺼짐은 말풍선으로 확인)
      b.style.setProperty("background", "transparent", "important");
      b.style.setProperty("background-color", "transparent", "important");
      b.style.setProperty("box-shadow", "none", "important");
      b.style.setProperty("outline", "none", "important");
      // 옆 버튼들과 세로 가운데 맞춤
      b.style.display = "inline-flex"; b.style.alignItems = "center"; b.style.justifyContent = "center";
      b.style.verticalAlign = "middle"; b.style.padding = b.style.padding || "";
      const sv = b.querySelector("svg"); if (sv) { sv.style.display = "block"; sv.style.margin = "0"; }
      if (button.element) { button.element.style.display = "flex"; button.element.style.alignItems = "center"; button.element.style.alignSelf = "center"; }
      b.style.setProperty("border", "none", "important");
      b.style.color = btnHover ? "var(--text-base, #fff)" : (siblingColor() || "#b3b3b3");
      const dot = b.querySelector(".lc-dot");
      if (dot) dot.remove();
      if (tipEl && tipEl.style.display === "block") showTip();
    } catch (e) { /* 무시 */ }
  }
  let placeObs = null, obsTarget = null;
  function placeButton() {
    if (!button || !button.element) return;
    const right = document.querySelector(".main-actionButtons");
    if (!right) return;
    // 오른쪽 버튼 묶음이 바뀌는 즉시 제자리로 (왔다갔다 하지 않게)
    if (obsTarget !== right) {
      try { if (placeObs) placeObs.disconnect(); } catch (e) { /* 무시 */ }
      placeObs = new MutationObserver(() => { try { placeButton(); } catch (e) { /* 무시 */ } });
      placeObs.observe(right, { childList: true });
      obsTarget = right;
    }
    const el = button.element;
    const kids = Array.from(right.children).filter((k) => k !== el);
    if (!kids.length) return;
    // 프로필(사진) 버튼 바로 왼쪽
    const prof = kids.find((k) => k.matches('[data-testid^="user-widget"], .main-userWidget-box') ||
      k.querySelector('[data-testid^="user-widget"], .main-userWidget-box, figure, img'));
    if (prof) { if (el.parentElement !== right || el.nextElementSibling !== prof) prof.insertAdjacentElement("beforebegin", el); }
    else if (el.parentElement !== right || el.nextElementSibling) right.appendChild(el);
  }
  try {
    if (Spicetify.Topbar && Spicetify.Topbar.Button) {
      button = new Spicetify.Topbar.Button("LocalCast", ICON, () => { setEnabled(!enabled); }, false, true);
      try { if (button.tippy) button.tippy.destroy(); } catch (e) { /* 무시 */ }
      button.tippy = null;
      button.button.addEventListener("mouseenter", () => { btnHover = true; updateButton(); showTip(); });
      button.button.addEventListener("mouseleave", () => { btnHover = false; updateButton(); hideTip(); });
      button.button.addEventListener("click", () => setTimeout(() => { try { button.button.blur(); } catch (e) { /* 무시 */ } updateButton(); showTip(); }, 50));
      button.button.addEventListener("focus", () => { button.button.style.setProperty("outline", "none", "important"); });
      updateButton();
      setInterval(() => { try { placeButton(); updateButton(); } catch (e) { /* 무시 */ } }, 1000);
      setTimeout(placeButton, 300);
    }
  } catch (e) { console.warn(TAG, "상단 버튼 추가 실패", e); }

  try {
    if (Spicetify.ContextMenu && Spicetify.ContextMenu.Item) {
      new Spicetify.ContextMenu.Item(
        "스피커로 재생 (LocalCast)",
        (uris, uids, contextUri) => {
          log(`오른쪽 클릭: ${uris[0]} / 컨텍스트 ${contextUri}`);
          if (busy) return notify("전환 중이에요. 잠시 후 다시 시도하세요", true);
          const row = { uri: uris[0], uid: uids && uids[0], name: localTitle(uris[0]) };
          enterCast({ row, ctxUri: playlistOf(contextUri), manual: true, reason: "오른쪽 클릭 메뉴" });
        },
        (uris) => enabled && Array.isArray(uris) && uris.length === 1 && String(uris[0]).startsWith("spotify:local:"),
      ).register();
    }
  } catch (e) { console.warn(TAG, "오른쪽 클릭 메뉴 추가 실패", e); }

  // ───────── 프로필 메뉴 "LocalCast 설정" 창 (켜기/끄기는 상단 아이콘으로) ─────────
  async function statusLines() {
    await checkHelper();
    let st = null;
    try { st = await helper("/status", undefined, 3000); } catch (e) { /* 무시 */ }
    const list = await devices();
    const active = list.find((d) => d.active);
    const d = Spicetify.Player.data || {};
    log("상태: " + JSON.stringify({ enabled, mode, helperOk, speaker: st && st.speaker, files: st && st.files }) + " · 기기 " + JSON.stringify(list));
    return [
      ["버전", VERSION],
      ["기능", `${enabled ? "켜짐" : "꺼짐"} · 모드 ${mode}`],
      ["보조 프로그램", helperOk ? "연결됨" : "꺼짐"],
      ["AirPlay 스피커", st && st.speaker ? st.speaker : "못 찾음"],
      ["음악 파일", st ? `${st.files}곡` : "?"],
      ["재생 기기", active ? active.name : "없음"],
      ["셔플", isShuffle(d) ? "켜짐" : "꺼짐"],
    ];
  }

  function openSettings() {
    const mk = (tag, css, text) => { const n = document.createElement(tag); if (css) n.style.cssText = css; if (text != null) n.textContent = text; return n; };
    const box = mk("div", "display:flex;flex-direction:column;gap:18px;font-size:14px;");

    const stTitle = mk("div", "font-weight:700;font-size:15px;", "상태");
    const stBox = mk("div", "display:grid;grid-template-columns:auto 1fr;gap:6px 16px;padding:12px 14px;border-radius:8px;background:rgba(255,255,255,.07);");
    const fill = async () => {
      stBox.textContent = "";
      stBox.append(mk("div", "opacity:.7;grid-column:1/3;", "확인 중…"));
      const rows = await statusLines().catch(() => [["상태", "확인 실패"]]);
      stBox.textContent = "";
      for (const [k, v] of rows) stBox.append(mk("div", "opacity:.7;", k), mk("div", "font-weight:600;", v));
    };

    const action = (title, desc, label, run) => {
      const row = mk("div", "display:flex;align-items:center;gap:14px;padding:12px 14px;border-radius:8px;background:rgba(255,255,255,.07);");
      const txt = mk("div", "flex:1;min-width:0;");
      txt.append(mk("div", "font-weight:600;", title), mk("div", "opacity:.7;font-size:12px;margin-top:2px;", desc));
      const b = mk("button", "flex:none;border:0;border-radius:999px;padding:8px 18px;font-weight:700;font-size:13px;cursor:pointer;background:#1ed760;color:#000;", label);
      b.type = "button";
      b.addEventListener("click", async () => {
        b.disabled = true; b.style.opacity = ".5";
        try { await run(); } finally { b.disabled = false; b.style.opacity = ""; fill(); }
      });
      row.append(txt, b);
      return row;
    };

    const toolsTitle = mk("div", "font-weight:700;font-size:15px;", "도구");
    const tools = mk("div", "display:flex;flex-direction:column;gap:8px;");
    tools.append(
      action("재생목록 로컬파일 안 보일 때", "누를 때마다 다음 방법으로 고쳐 봐요", "고치기", async () => { nextPlFixStage(); }),
      action("음악 폴더 다시 읽기", "새로 넣은 곡이 안 잡힐 때", "다시 읽기", async () => {
        try { const r = await helper("/rescan", {}, 120000); notify(`음악 폴더 다시 읽음: ${r.files}곡`); }
        catch (e) { notify("보조 프로그램이 꺼져 있어요", true); }
      }),
    );

    const refresh = mk("button", "align-self:flex-start;border:1px solid rgba(255,255,255,.3);border-radius:999px;padding:6px 14px;font-size:12px;cursor:pointer;background:transparent;color:inherit;", "상태 새로고침");
    refresh.type = "button";
    refresh.addEventListener("click", fill);

    box.append(stTitle, stBox, refresh, toolsTitle, tools, mk("div", "opacity:.6;font-size:12px;", "LocalCast 켜기/끄기는 상단의 LocalCast 아이콘으로 해요."));
    Spicetify.PopupModal.display({ title: "LocalCast 설정", content: box, isLarge: true });
    fill();
  }

  try {
    if (Spicetify.Menu && Spicetify.Menu.Item) {
      new Spicetify.Menu.Item("LocalCast 설정", false, () => { openSettings(); }).register();
    }
  } catch (e) { console.warn(TAG, "메뉴 추가 실패", e); }

  // ───────── 다른 확장(ivLyrics 기기 연결 패널)에서 LocalCast 상태 읽기/조작 ─────────
  window.LocalCastAPI = {
    version: VERSION,
    getState() {
      const it = cur();
      const remote = enabled && mode !== "cast" ? remoteAirplay() : null;
      return {
        enabled, helperOk, mode, busy,
        casting: enabled && mode === "cast",
        remote: remote ? { host: remote.host || "", speaker: remote.speaker || "" } : null,
        speakerName: (remote && remote.speaker) || lastSpeakerName || cfg.speaker_name,
        configSpeakerName: cfg.speaker_name,
        localTrack: isLocalTrack(it),
        canPickSpeaker: enabled && helperOk && mode !== "cast" && !remote && isLocalTrack(it),
      };
    },
    // "이 컴퓨터" 선택: AirPlay를 끝내고 PC 스피커로 (다른 PC가 AirPlay 중이면 이 PC로 가져옴)
    moveToPc() {
      if (mode === "cast") { moveToPc(); return true; }
      devices().then((l) => { const id = localId(l); if (id) transferTo(id, true); }).catch(() => {});
      return true;
    },
    // 로컬파일 재생 중 스피커 선택: AirPlay로 이어서 재생
    pickSpeaker() {
      const it = cur();
      if (!it || !isLocalTrack(it) || mode === "cast") return false;
      if (busy) { notify("전환 중이에요. 잠시 후 다시 시도하세요", true); return false; }
      const d = Spicetify.Player.data || {};
      log("기기 연결 패널에서 스피커 선택 → 로컬파일을 AirPlay로");
      enterCast({ row: { uri: it.uri, uid: it.uid, name: nameOf(it) }, ctxUri: playlistOf(d.context && d.context.uri),
        manual: true, keepPlaying: true, reason: "기기 연결 패널에서 스피커 선택" });
      return true;
    },
  };

  // Spotify를 껐다 켜도 이어서: 보조 프로그램이 아직 AirPlay로 로컬파일을 틀고 있으면 그 곡·위치로 화면을 맞추고 계속 연동
  async function resumeCastSession() {
    let st = null;
    try { st = await helper("/status", undefined, 3000); } catch (e) { /* 무시 */ }
    const c = st && st.cast;
    if (!enabled || !c || !c.uri || !c.alive || !/^(PLAYING|PAUSED|STARTING)$/.test(c.state || "")) return false;
    const list = await devices();
    const lid = localId(list);
    const act = list.find((d) => d.active);
    if (act && act.id !== lid) return false;          // 다른 기기(스피커 Connect 등)가 재생 중이면 건드리지 않음
    log(`Spotify 다시 켜짐 → AirPlay로 재생 중이던 곡 이어받기: ${c.file} (${Math.round(c.position)}초)`);
    await helper("/mute", { mute: true }).catch(() => {});
    busy = true;
    internalPlay++;
    try {
      const same = () => { const x = cur(); return !!x && (sameTrack(x.uri, c.uri) || (isLocalTrack(x) && localTitle(x.uri) === localTitle(c.uri))); };
      if (!same()) {
        try {
          if (c.ctx) await Spicetify.Player.playUri(c.ctx, {}, { skipTo: { uri: c.uri } });
          else await Spicetify.Player.playUri(c.uri);
        } catch (e) { try { await Spicetify.Player.playUri(c.uri); } catch (e2) { /* 무시 */ } }
        await waitFor(same, 5000);
      }
      if (!same()) { log("이어받기 실패: 곡을 찾지 못함"); return false; }
      castCtx = c.ctx || castCtx;
      castedUri = cur().uri;
      castFailUri = null;
      fromKey = null;
      mode = "cast";
      const sp = list.find(isSpeaker);
      if (sp) { speakerId = sp.id; lastSpeakerName = sp.name; }
      // 볼륨: 슬라이더 = 스피커(AirPlay) 볼륨
      const v = typeof c.volume === "number" ? c.volume / 100 : null;
      if (v !== null) {
        if (typeof pcVolBefore !== "number" && typeof lastPcVol === "number") savePcVol(lastPcVol);
        if (isPcActiveNow()) { try { Spicetify.Player.setVolume(v); } catch (e) { /* 무시 */ } }
        lastVol = v;
        volHoldUntil = Date.now() + 3000;
      }
      // 위치·재생 상태 맞춤
      try { Spicetify.Player.seek(Math.max(0, Math.round(c.position * 1000 - audioDelay() + 300))); } catch (e) { /* 무시 */ }
      const d = Spicetify.Player.data;
      if (c.state === "PAUSED") { if (d && !d.isPaused) Spicetify.Player.pause(); }
      else if (d && d.isPaused) Spicetify.Player.play();
      seekWatch = null;
      lastSync = Date.now();
      notify("AirPlay로 재생 중이던 곡을 이어서 연동했어요");
      return true;
    } catch (e) {
      log("이어받기 오류: " + errMsg(e));
      return false;
    } finally {
      internalPlay--;
      busy = false;
    }
  }

  if (await checkHelper()) {
    let resumed = false;
    try { resumed = await resumeCastSession(); } catch (e) { /* 무시 */ }
    if (!resumed) helper("/mute", { mute: false }).catch(() => {});
  } else {
    // PC를 막 켰을 땐 보조 프로그램이 조금 늦게 켜짐 → 1분 동안 기다려 보고 그래도 없을 때만 알림
    (async () => {
      for (let i = 0; i < 12; i++) { await sleep(5000); if (await checkHelper()) { helper("/mute", { mute: false }).catch(() => {}); return; } }
      notify("보조 프로그램이 실행 중이 아니에요 → C:\\LocalCast\\2_restart_helper.bat 을 실행하세요", true);
    })();
  }
})();
