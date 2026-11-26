// NAME: ivLyrics Furigana AI
// AUTHOR: 지훈
// DESCRIPTION: ivLyrics 후리가나를 문맥을 이해하는 AI 읽기로 덮어써서 음독/훈독이 뒤바뀌는 문제를 줄임
// VERSION: 1.1.0
//
// 원리
//  - ivLyrics는 kuromoji(IPADIC 사전)로 단어를 나누고 사전에 적힌 읽기 하나를 그대로 붙입니다.
//    문맥을 보지 않아서 心(こころ/しん), 風(かぜ/ふう), 人(ひと/じん) 같은 읽기가 자주 틀립니다.
//  - 이 확장은 화면에 나오는 가사 줄을 모아 곡 제목·가수와 함께 AI에게 보내고,
//    "이 노래 이 줄에서 실제로 어떻게 읽는지"를 한자 덩어리 단위로 받아 후리가나를 덮어씁니다.
//  - AI 응답이 오기 전(1~몇 초)과 AI가 실패한 줄은 원래 ivLyrics 후리가나가 그대로 보입니다.
//  - 결과는 이 컴퓨터에 저장해서 같은 곡은 다시 요청하지 않습니다.
//  - 二人(ふたり)처럼 ivLyrics 사전이 늘 틀리는 단어는 AI 없이 고정 읽기 사전으로 바로 고치고,
//    AI 결과보다도 우선합니다. (AI 보정을 꺼도 적용)
//
// API 키: 따로 넣지 않습니다. ivLyrics 설정에 이미 등록된 AI(Gemini, ChatGPT, Claude, Groq,
//         OpenRouter, Perplexity, Pollinations, NVIDIA 등)를 그대로 씁니다.
//         Google 번역/DeepL/Bing/로컬 AI만 쓰고 있다면 위 AI 중 하나를 ivLyrics에 추가해야 합니다.
// 켜고 끄기: 오른쪽 위 프로필 메뉴 → "후리가나 AI 보정" (끄면 고정 읽기 사전만 적용)

(function ivLyricsFuriganaAI() {
    if (!window.Spicetify?.LocalStorage || !document.head) {
        setTimeout(ivLyricsFuriganaAI, 300);
        return;
    }
    if (window.__ivlFuriganaAILoaded) return;
    window.__ivlFuriganaAILoaded = true;

    const LOG = "[ivLyrics Furigana AI]";
    const PATCH_FLAG = "__ivlFuriganaAIPatched";
    const ENABLED_KEY = "ivl-furigana-ai:enabled";
    const CACHE_KEY = "ivl-furigana-ai:cache:v1";
    const MAX_CACHE_LINES = 6000;
    const BATCH_DELAY_MS = 350;
    const MAX_LINES_PER_REQUEST = 50;
    const RETRY_COOLDOWN_MS = 5 * 60 * 1000;

    const KANJI = /[一-鿿㐀-䶿豈-﫿々〻]/;
    const KANJI_RUN = /^[一-鿿㐀-䶿豈-﫿々〻ゝゞヽヾ]+$/;

    // ---------- 설정 ----------
    const store = {
        get(k) { try { return Spicetify.LocalStorage.get(k); } catch (e) { return null; } },
        set(k, v) { try { Spicetify.LocalStorage.set(k, v); } catch (e) { /* 용량 초과 등 */ } },
    };
    let enabled = store.get(ENABLED_KEY) !== "false";

    // ---------- 캐시 (줄 텍스트 → [[덩어리, 읽기], ...]) ----------
    let cache = new Map();
    try {
        const raw = store.get(CACHE_KEY);
        if (raw) cache = new Map(JSON.parse(raw));
    } catch (e) { cache = new Map(); }
    let saveTimer = null;
    function saveCacheSoon() {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
            while (cache.size > MAX_CACHE_LINES) cache.delete(cache.keys().next().value);
            store.set(CACHE_KEY, JSON.stringify(Array.from(cache.entries())));
        }, 1500);
    }

    // ---------- 후리가나 HTML 만들기 (ivLyrics와 같은 <ruby> 형식) ----------
    const toHiragana = (s) => String(s || "").replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
    function buildRuby(segments) {
        let html = "";
        for (const [surface, reading] of segments) {
            if (reading && KANJI.test(surface)) html += `<ruby>${surface}<rt>${reading}</rt></ruby>`;
            else html += surface;
        }
        return html;
    }

    // AI가 준 한 줄이 원문과 정확히 맞는지 검사
    function validateLine(line, segments) {
        if (!Array.isArray(segments) || segments.length === 0) return null;
        const clean = [];
        let joined = "";
        for (const seg of segments) {
            if (!Array.isArray(seg) || typeof seg[0] !== "string") return null;
            const surface = seg[0];
            let reading = toHiragana(typeof seg[1] === "string" ? seg[1].trim() : "");
            joined += surface;
            if (!surface) continue;
            if (KANJI.test(surface)) {
                // 한자 덩어리에는 히라가나 읽기만 허용
                if (!KANJI_RUN.test(surface) || !/^[ぁ-ゟー]+$/.test(reading)) return null;
            } else {
                reading = "";
            }
            clean.push([surface, reading]);
        }
        return joined === line ? clean : null;
    }

    // ---------- AI 요청 ----------
    function getProviders() {
        const mgr = window.AIAddonManager;
        if (!mgr?.getEnabledProvidersFor) return [];
        try {
            return mgr.getEnabledProvidersFor("characterPronunciation")
                .filter((a) => typeof a.generateCharacterPronunciation === "function");
        } catch (e) { return []; }
    }

    function buildPrompt(lines, title, artist) {
        const numbered = lines.map((l, i) => `${i}\t${l}`).join("\n");
        return `You are an expert in Japanese kanji readings (furigana) for song lyrics.
Song: "${title}" by ${artist}

For each lyric line, give the reading of every kanji exactly as it is read/sung in THIS line's context.
Choose on'yomi vs kun'yomi correctly from context (e.g. 心→こころ in "心が", 風→かぜ alone, 人→ひと alone),
use jukujikun as whole units (今日→きょう, 明日→あした, 大人→おとな, 一人→ひとり),
and use the reading commonly used when this song is sung if you know it.

Output compact JSON only, no explanations: {"l":[ line0, line1, ... ]}
- One entry per input line, same order, exactly ${lines.length} entries.
- Each line is an array of [segment, reading] pairs.
- Segments, concatenated in order, must reproduce the input line EXACTLY (every character, space and symbol).
- A segment is either a run of consecutive kanji (including 々) or a run of non-kanji text.
- Kanji segment: reading = hiragana reading of only those kanji (no okurigana). Non-kanji segment: reading = "".
- Keep a kanji run together as one segment when it is read as one word.

Example input line: 心が震えた今日
Example output line: [["心","こころ"],["が",""],["震","ふる"],["えた",""],["今日","きょう"]]

Lines (index<TAB>text):
${numbered}`;
    }

    async function requestReadings(lines) {
        const providers = getProviders();
        if (providers.length === 0) throw new Error("ivLyrics에 후리가나를 만들 수 있는 AI가 설정되어 있지 않아요");
        const meta = Spicetify.Player?.data?.item?.metadata || {};
        const prompt = buildPrompt(lines, meta.title || "", meta.artist_name || "");
        const mgr = window.AIAddonManager;
        let lastError = null;
        for (const addon of providers) {
            try {
                const params = { lines, characterPronunciationPrompt: prompt, lang: "ja", sourceLang: "ja" };
                const result = typeof mgr._callProvider === "function"
                    ? await mgr._callProvider(addon, "generateCharacterPronunciation", params)
                    : await addon.generateCharacterPronunciation(params);
                const out = Array.isArray(result?.l) ? result.l : (Array.isArray(result?.lines) ? result.lines : null);
                if (!out) throw new Error("응답 형식이 맞지 않아요");
                return { out, provider: addon.id };
            } catch (e) {
                lastError = e;
                console.warn(LOG, `${addon.id} 실패:`, e?.message || e);
            }
        }
        throw lastError || new Error("모든 AI 요청 실패");
    }

    // ---------- 요청 모으기 ----------
    const pending = new Set();
    const inflight = new Set();
    const failedAt = new Map();
    let batchTimer = null;
    let running = false;

    function queue(line) {
        if (cache.has(line) || inflight.has(line) || pending.has(line)) return;
        const failed = failedAt.get(line);
        if (failed && Date.now() - failed < RETRY_COOLDOWN_MS) return;
        pending.add(line);
        clearTimeout(batchTimer);
        batchTimer = setTimeout(runBatches, BATCH_DELAY_MS);
    }

    async function runBatches() {
        if (running) return;
        running = true;
        try {
            while (pending.size > 0) {
                const lines = Array.from(pending).slice(0, MAX_LINES_PER_REQUEST);
                lines.forEach((l) => { pending.delete(l); inflight.add(l); });
                let changed = 0;
                try {
                    const { out, provider } = await requestReadings(lines);
                    lines.forEach((line, i) => {
                        const ok = validateLine(line, out[i]);
                        if (ok) { cache.set(line, ok); changed++; }
                        else failedAt.set(line, Date.now());
                    });
                    console.log(LOG, `${provider}: ${changed}/${lines.length}줄 보정`);
                } catch (e) {
                    lines.forEach((l) => failedAt.set(l, Date.now()));
                    console.warn(LOG, "AI 후리가나 요청 실패, ivLyrics 기본 후리가나 유지:", e?.message || e);
                } finally {
                    lines.forEach((l) => inflight.delete(l));
                }
                if (changed > 0) {
                    saveCacheSoon();
                    refreshLyrics();
                }
            }
        } finally {
            running = false;
        }
    }

    // 가사 화면 다시 그리기 (ivLyrics가 설정 변경 때 쓰는 방식과 같음)
    function refreshLyrics() {
        const lc = window.lyricContainer;
        if (!lc) return;
        try {
            lc.reRenderLyricsPage = !lc.reRenderLyricsPage;
            lc.forceUpdate?.();
        } catch (e) { /* ignore */ }
    }

    // ---------- 고정 읽기 사전 (AI 없이도 항상 적용, AI보다 우선) ----------
    // ivLyrics의 사전(kuromoji IPADIC)이 틀리는 것을 실제로 돌려서 확인한 단어들.
    // 예: 二人 → 二(に)+人(にん)으로 쪼개져 "ににん"이 됨.
    // seg: [한자 덩어리, 읽기] 목록 (오쿠리가나는 읽기 없이 그대로)
    // notBefore / notAfter: 앞뒤에 이 글자가 오면 적용 안 함 (十二人, 一人称, 一人前 등)
    // needAfter: 뒤에 이 글자가 와야 적용 (彷徨う처럼 동사일 때만)
    const NUM = "〇一二三四五六七八九十百千万何数第幾";
    const FIXED = [
        { w: "一人一人", seg: [["一人", "ひとり"], ["一人", "ひとり"]], notBefore: NUM },
        { w: "一人", seg: [["一人", "ひとり"]], notBefore: NUM, notAfter: "称前者" },
        { w: "二人", seg: [["二人", "ふたり"]], notBefore: NUM, notAfter: "三称" },
        { w: "二十歳", seg: [["二十歳", "はたち"]], notBefore: NUM },
        { w: "二十日", seg: [["二十日", "はつか"]], notBefore: NUM },
        { w: "二日", seg: [["二日", "ふつか"]], notBefore: NUM },
        { w: "一日中", seg: [["一日中", "いちにちじゅう"]], notBefore: NUM },
        { w: "一昨年", seg: [["一昨年", "おととし"]] },
        { w: "明後日", seg: [["明後日", "あさって"]] },
        { w: "貴女", seg: [["貴女", "あなた"]] },
        { w: "其処", seg: [["其処", "そこ"]] },
        { w: "所為", seg: [["所為", "せい"]] },
        { w: "僕等", seg: [["僕等", "ぼくら"]] },
        { w: "君等", seg: [["君等", "きみら"]] },
        { w: "一途", seg: [["一途", "いちず"]] },
        { w: "雨音", seg: [["雨音", "あまおと"]] },
        { w: "愛おし", seg: [["愛", "いと"], ["おし", ""]] },
        { w: "彷徨", seg: [["彷徨", "さまよ"]], needAfter: "うわいっえお" },
        { w: "蒲公英", seg: [["蒲公英", "たんぽぽ"]] },
    ].sort((a, b) => b.w.length - a.w.length);

    function findFixed(line) {
        const matches = [];
        let i = 0;
        while (i < line.length) {
            let hit = null;
            for (const entry of FIXED) {
                if (!line.startsWith(entry.w, i)) continue;
                const before = line[i - 1] || "";
                const after = line[i + entry.w.length] || "";
                if (entry.notBefore && before && entry.notBefore.includes(before)) continue;
                if (entry.notAfter && after && entry.notAfter.includes(after)) continue;
                if (entry.needAfter && !(after && entry.needAfter.includes(after))) continue;
                hit = entry;
                break;
            }
            if (hit) {
                matches.push({ s: i, e: i + hit.w.length, seg: hit.seg });
                i += hit.w.length;
            } else {
                i += 1;
            }
        }
        return matches;
    }

    // AI 결과 위에 고정 읽기를 덮어씀 (글자 위치 기준)
    function mergeFixed(line, aiSegments, matches) {
        const items = [];
        let pos = 0;
        for (const [surface, reading] of aiSegments) {
            items.push({ s: pos, e: pos + surface.length, surface, reading });
            pos += surface.length;
        }
        let out = items;
        for (const m of matches) {
            const next = [];
            for (const it of out) {
                if (it.e <= m.s || it.s >= m.e) { next.push(it); continue; }
                // 겹치는 부분은 버리고, 바깥으로 삐져나온 글자는 읽기 없이 남김
                if (it.s < m.s) next.push({ s: it.s, e: m.s, surface: line.slice(it.s, m.s), reading: "" });
                if (it.e > m.e) next.push({ s: m.e, e: it.e, surface: line.slice(m.e, it.e), reading: "" });
            }
            let p = m.s;
            for (const [surface, reading] of m.seg) {
                next.push({ s: p, e: p + surface.length, surface, reading });
                p += surface.length;
            }
            out = next.sort((a, b) => a.s - b.s);
        }
        const result = out.map((it) => [it.surface, it.reading]);
        return result.map((x) => x[0]).join("") === line ? result : null;
    }

    // 고정 읽기 부분은 사전대로, 나머지는 ivLyrics 기존 방식으로
    function renderWithFixed(line, matches, original, self) {
        let html = "";
        let pos = 0;
        for (const m of matches) {
            if (m.s > pos) html += original.call(self, line.slice(pos, m.s));
            html += buildRuby(m.seg);
            pos = m.e;
        }
        if (pos < line.length) html += original.call(self, line.slice(pos));
        return html;
    }

    // ---------- ivLyrics 후리가나 변환기 덮어쓰기 ----------
    function patchConverter() {
        const fc = window.FuriganaConverter;
        if (!fc || typeof fc.convertToFurigana !== "function" || fc.convertToFurigana[PATCH_FLAG]) return;
        const original = fc.convertToFurigana;
        const patched = function (text) {
            if (typeof text !== "string" || !KANJI.test(text)) return original.call(this, text);
            const matches = findFixed(text);
            if (enabled) {
                const ai = cache.get(text);
                if (ai) {
                    const merged = matches.length ? mergeFixed(text, ai, matches) : ai;
                    if (merged) return buildRuby(merged);
                } else {
                    queue(text);
                }
            }
            // AI 결과가 없을 때(응답 대기 중, AI 꺼짐, 실패): 고정 읽기 + ivLyrics 기본 후리가나
            return matches.length ? renderWithFixed(text, matches, original, this) : original.call(this, text);
        };
        patched[PATCH_FLAG] = true;
        fc.convertToFurigana = patched;
        console.log(LOG, "적용 완료");
    }
    try {
        let current = window.FuriganaConverter;
        const desc = Object.getOwnPropertyDescriptor(window, "FuriganaConverter");
        if (!desc || desc.configurable) {
            Object.defineProperty(window, "FuriganaConverter", {
                configurable: true,
                enumerable: true,
                get() { return current; },
                set(v) { current = v; try { patchConverter(); } catch (e) { /* ignore */ } },
            });
        }
    } catch (e) { /* 주기 확인으로 처리 */ }
    patchConverter();
    setInterval(patchConverter, 1000);

    // ---------- 프로필 메뉴 토글 ----------
    let tries = 0;
    function registerMenu() {
        tries += 1;
        const ready = Spicetify.Menu?.Item && Spicetify.ReactJSX?.jsx && Spicetify.ContextMenuV2?.Item && Spicetify.ReactComponent?.MenuItem;
        if (!ready) { if (tries < 240) setTimeout(registerMenu, 500); return; }
        try {
            new Spicetify.Menu.Item("후리가나 AI 보정", enabled, (self) => {
                enabled = !enabled;
                self.setState(enabled);
                store.set(ENABLED_KEY, String(enabled));
                refreshLyrics();
            }).register();
        } catch (e) {
            if (tries < 240) setTimeout(registerMenu, 500);
        }
    }
    registerMenu();

    // 개발자 도구에서 확인/초기화용
    window.ivlFuriganaAI = {
        cacheSize: () => cache.size,
        clearCache: () => { cache.clear(); store.set(CACHE_KEY, "[]"); refreshLyrics(); },
        providers: () => getProviders().map((a) => a.id),
    };
})();
