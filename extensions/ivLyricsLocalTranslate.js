// NAME: ivLyrics Local Translate
// AUTHOR: 지훈
// DESCRIPTION: ivLyrics 로컬 파일 보완 - LRC 싱크 파서, 로컬 곡 YouTube 안내 팝업 숨김
// VERSION: 1.3.0
//
// ivLyrics 7.0 이상은 로컬 곡 번역·발음·번역 재생성을 자체 지원하므로, 그 보완 기능은 뺐습니다
// (같이 두면 번역 캐시가 두 군데로 나뉠 수 있음). 남은 기능은 ivLyrics에 아직 없는 두 가지입니다.
//
// 1. LRC 싱크 파서 교체 (로컬 가사 → 파일 가져오기)
//    ivLyrics의 기존 파서는 파일 "첫 줄"에 시간 표시가 없으면 파일 전체를 싱크 없는 가사로 처리하고,
//    [ti:] 같은 빈 태그, 한 줄에 여러 시간 표시([00:12.00][01:30.00]), [mm:ss:xx] 형식,
//    [offset:] 태그를 처리하지 못합니다. 이것들을 처리하는 파서로 바꿔서 불러옵니다.
// 2. 로컬 곡에서 뜨는 "YouTube URL을 직접 지정하세요" 알림만 숨깁니다. (다른 알림은 그대로)
//
// ivLyrics 파일은 수정하지 않으므로 ivLyrics를 업데이트해도 그대로 동작합니다.
(function ivLyricsLocalTranslate() {
    const PATCH_FLAG = "__ivlLocalTranslatePatched";
    const LOG_PREFIX = "[ivLyrics Local Translate]";

    // ---------- 공통 ----------
    const t = (key, fallback) => {
        try {
            const v = window.I18n?.t?.(key);
            return v && v !== key ? v : fallback;
        } catch (e) { return fallback; }
    };

    // ---------- 1) LRC 파서 ----------
    const TIME_TAG = /\[(\d{1,3}):(\d{1,2})(?:[:.,](\d{1,3}))?\]/y; // 줄 앞의 [mm:ss(.xx)] 하나
    const WORD_TAG = /<(\d{1,3}):(\d{1,2})(?:[:.,](\d{1,3}))?>/g;    // 단어 단위 <mm:ss.xx>
    const META_LINE = /^\s*\[([a-zA-Z#][a-zA-Z0-9#_ -]*)\s*:([^\]]*)\]\s*$/;

    function toMs(min, sec, frac) {
        let ms = Number(min) * 60000 + Number(sec) * 1000;
        if (frac !== undefined && frac !== "") {
            // .5 → 500ms, .50 → 500ms, .500 → 500ms
            ms += Number(frac.padEnd(3, "0").slice(0, 3));
        }
        return ms;
    }

    function parseLrc(raw) {
        const text = String(raw || "").replace(/^﻿/, "").replace(/\r\n?/g, "\n");
        let offset = 0;
        const timed = [];   // { startTime, text, order }
        const plain = [];   // 시간 표시 없는 줄
        let order = 0;

        for (const line of text.split("\n")) {
            if (!line.trim()) continue;

            const meta = line.match(META_LINE);
            if (meta && !/^\d+$/.test(meta[1])) {
                if (meta[1].trim().toLowerCase() === "offset") {
                    const v = Number(String(meta[2]).trim());
                    if (Number.isFinite(v)) offset = v;
                }
                continue; // [ti:], [ar:], [by:], [length:] 같은 정보 줄은 가사가 아님
            }

            // 줄 앞의 시간 표시를 모두 읽음 ([00:12.00][01:30.00]가사)
            const times = [];
            let pos = 0;
            const s = line.replace(/^\s+/, "");
            TIME_TAG.lastIndex = 0;
            let m;
            while ((m = TIME_TAG.exec(s))) {
                times.push(toMs(m[1], m[2], m[3]));
                pos = TIME_TAG.lastIndex;
                while (s[pos] === " " || s[pos] === "\t") pos++;
                TIME_TAG.lastIndex = pos;
            }
            const body = s.slice(pos).trim();

            if (!times.length) {
                plain.push(body);
                continue;
            }
            for (const time of times) {
                timed.push({ startTime: time, raw: body, order: order++ });
            }
        }

        // [offset:+500] = 가사를 0.5초 일찍 표시 (LRC 규칙)
        for (const item of timed) item.startTime = Math.max(0, item.startTime - offset);
        timed.sort((a, b) => a.startTime - b.startTime || a.order - b.order);

        const hasWordTiming = timed.some((x) => { WORD_TAG.lastIndex = 0; return WORD_TAG.test(x.raw); });
        const stripWords = (str) => str.replace(WORD_TAG, "").replace(/\s{2,}/g, " ").trim();

        let synced = null;
        let karaoke = null;
        let unsynced;

        if (timed.length) {
            synced = timed.map((x) => ({ text: stripWords(x.raw) || "♪", startTime: x.startTime }));
            unsynced = synced.map((x) => ({ text: x.text }));

            if (hasWordTiming) {
                karaoke = [];
                timed.forEach((x, i) => {
                    const next = timed[i + 1];
                    const lineEnd = next ? next.startTime : x.startTime + 5000;
                    const words = parseWords(x.raw, x.startTime, lineEnd, offset);
                    if (words.length) karaoke.push({ text: words, startTime: x.startTime });
                    else karaoke.push({ text: [{ word: stripWords(x.raw) || "♪", time: Math.max(0, lineEnd - x.startTime) }], startTime: x.startTime });
                });
            }
        } else {
            unsynced = plain.filter(Boolean).map((line) => ({ text: line }));
        }

        return { synced, unsynced, karaoke };
    }

    // 단어 단위 시간 표시: "<시작>단어 <시작>단어" (A2 방식)와 "단어 <끝> 단어 <끝>" 방식 모두 지원
    // 결과 형식은 ivLyrics와 같음: [{ word, time: 단어 길이(ms) }]
    function parseWords(raw, lineStart, lineEnd, offset) {
        const parts = [];
        let last = 0;
        WORD_TAG.lastIndex = 0;
        let m;
        while ((m = WORD_TAG.exec(raw))) {
            parts.push({ text: raw.slice(last, m.index), time: Math.max(0, toMs(m[1], m[2], m[3]) - offset) });
            last = WORD_TAG.lastIndex;
        }
        const tail = raw.slice(last);
        if (!parts.length) return [];

        const words = [];
        const timeFirst = parts[0].text.trim() === ""; // 첫 태그가 단어보다 앞 → A2 방식
        if (timeFirst) {
            // <t0>w0 <t1>w1 ... <tn>wn  (마지막 단어는 줄 끝까지)
            const seq = parts.map((p, i) => ({ time: p.time, word: i + 1 < parts.length ? parts[i + 1].text : tail }));
            seq.forEach((p, i) => {
                const end = i + 1 < seq.length ? seq[i + 1].time : lineEnd;
                if (p.word) words.push({ word: p.word, time: Math.max(0, end - p.time) });
            });
        } else {
            // w0 <e0> w1 <e1> ...  (각 태그가 그 단어의 끝)
            let prev = lineStart;
            parts.forEach((p) => {
                if (p.text) words.push({ word: p.text, time: Math.max(0, p.time - prev) });
                prev = p.time;
            });
            if (tail.trim()) words.push({ word: tail, time: Math.max(0, lineEnd - prev) });
        }
        return words;
    }

    window.ivLyricsLocalLrcParser = parseLrc; // 확인용

    // ---------- ivLyrics 화면 연결 (1) ----------
    function patchLyricContainer() {
        const lc = window.lyricContainer;
        if (!lc || lc[PATCH_FLAG]) return;
        lc[PATCH_FLAG] = true;

        // "파일 가져오기"에서 새 파서 사용
        lc.processLyricsFromFile = function (event) {
            const files = event?.target?.files;
            if (!files || !files.length) return;
            const Toast = window.Toast;
            if (files[0].size > 1024 * 1024) {
                Toast?.error?.(t("notifications.fileTooLarge", "파일이 너무 큽니다: 최대 크기는 1MB입니다"));
                return;
            }
            const reader = new FileReader();
            reader.onload = async (e) => {
                try {
                    const parsed = parseLrc(e.target.result);
                    await this.applyLocalLyrics(parsed, { sourceLabel: "file" });
                } catch (err) {
                    console.warn(`${LOG_PREFIX} LRC 불러오기 실패:`, err);
                    Toast?.error?.(t("notifications.lyricsLoadFailed", "가사 로드 실패: 잘못된 파일 형식"));
                }
            };
            reader.onerror = () => Toast?.error?.(t("notifications.fileReadFailed", "파일 읽기 실패"));
            reader.readAsText(files[0]);
            event.target.value = "";
        };

        console.log(`${LOG_PREFIX} ivLyrics 화면 보완 적용`);
    }

    // ---------- 2) 로컬 곡 YouTube 안내 알림 숨김 ----------
    const YOUTUBE_NOTICE_FALLBACKS = [
        "로컬 곡은 영상 버튼에서 YouTube URL을 직접 지정하세요.",
        "For local tracks, set a YouTube URL manually from the video button.",
    ];
    function isYoutubeLocalNotice(message) {
        if (typeof message !== "string") return false;
        const text = message.trim();
        const exact = [t("videoBackground.localTrackNeedsVideo", ""), ...YOUTUBE_NOTICE_FALLBACKS].filter(Boolean);
        if (exact.includes(text)) return true;
        // 문구가 조금 달라져도: "YouTube" + "로컬/local" + "URL"이 모두 들어간 안내
        return /youtube/i.test(text) && /(로컬|local|ローカル|本地|本機)/i.test(text) && /url/i.test(text);
    }
    function patchToast() {
        const Toast = window.Toast;
        if (!Toast || typeof Toast.show !== "function" || Toast.show[PATCH_FLAG]) return;
        const originalShow = Toast.show;
        const patchedShow = function (message, ...rest) {
            if (isYoutubeLocalNotice(message)) return 0; // 이 알림만 표시하지 않음
            return originalShow.call(this, message, ...rest);
        };
        patchedShow[PATCH_FLAG] = true;
        Toast.show = patchedShow;
    }

    // ivLyrics 화면이 열리자마자 이 알림이 떠서, 1초 주기 확인보다 먼저 나올 수 있음.
    // ivLyrics가 알림 기능(window.Toast)을 만드는 바로 그 순간에 막도록 함.
    try {
        let currentToast = window.Toast;
        const desc = Object.getOwnPropertyDescriptor(window, "Toast");
        if (!desc || desc.configurable) {
            Object.defineProperty(window, "Toast", {
                configurable: true,
                enumerable: true,
                get() { return currentToast; },
                set(value) {
                    currentToast = value;
                    try { patchToast(); } catch (e) { /* ignore */ }
                },
            });
        }
    } catch (e) { /* 실패하면 아래 주기 확인과 화면 감시로 처리 */ }

    // 그래도 화면에 나타난 경우 즉시 지움
    const removeNoticeToasts = (root) => {
        const nodes = root.matches?.(".ivlyrics-toast") ? [root] : Array.from(root.querySelectorAll?.(".ivlyrics-toast") || []);
        for (const node of nodes) {
            const msg = node.querySelector(".ivlyrics-toast-message")?.textContent || "";
            if (isYoutubeLocalNotice(msg)) node.remove();
        }
    };
    // 가사 화면은 DOM이 매우 자주 바뀌므로 화면 전체가 아니라 알림 상자만 감시
    const watchedContainers = new WeakSet();
    const watchToastContainer = () => {
        const container = document.querySelector(".ivlyrics-toast-container");
        if (!container || watchedContainers.has(container)) return;
        watchedContainers.add(container);
        removeNoticeToasts(container);
        new MutationObserver((records) => {
            for (const r of records) for (const n of r.addedNodes) if (n.nodeType === 1) removeNoticeToasts(n);
        }).observe(container, { childList: true });
    };
    const startToastWatcher = () => {
        if (!document.body) { setTimeout(startToastWatcher, 300); return; }
        watchToastContainer();
        new MutationObserver(watchToastContainer).observe(document.body, { childList: true });
    };
    startToastWatcher();

    // ivLyrics가 나중에 로드되거나 화면이 다시 만들어질 수 있으므로 주기적으로 확인
    function tick() {
        try { patchToast(); } catch (e) { console.warn(LOG_PREFIX, e); }
        try { patchLyricContainer(); } catch (e) { console.warn(LOG_PREFIX, e); }
    }
    tick();
    setInterval(tick, 1000);
})();
