// NAME: ivLyrics Fullscreen Bridge
// AUTHOR: 지훈
// DESCRIPTION: Fullscreen(daksh2k) / Full App Display 전체화면에 lyrics-plus 대신 ivLyrics 가사를 표시하고, ivLyrics 전체화면과 오가는 전환과 ivLyrics 스타일 대기열 사이드바를 제공
// VERSION: 1.7.0
//
// 기능
//  1. 전체화면 확장의 가사 칸에 ivLyrics 가사 표시 (lyrics-plus 대신)
//  2. ivLyrics 전체화면 ↔ Fullscreen 단축키 전환 시 충돌 해결
//     - ivLyrics 전체화면이 켜진 채 Fullscreen이 열리면 ivLyrics 전체화면을 먼저 깔끔히 닫음
//       (브라우저 전체화면 유지, ivLyrics의 "이전 페이지로 이동"은 Fullscreen 종료 후로 미룸,
//        같은 키(t)로 잘못 바뀐 ivLyrics TV 모드 설정은 되돌림)
//     - Fullscreen이 켜진 상태에서 ivLyrics 전체화면 키(기본 F12)를 누르면
//       Fullscreen을 닫은 뒤 ivLyrics 전체화면을 엶
//  3. Fullscreen의 대기열 사이드바(q 키 / 대기열 버튼)를 ivLyrics 전체화면의 대기열 패널로 교체
//     - 오른쪽 가장자리에 마우스를 대면 열림, q 키나 대기열 버튼으로 고정/해제
//     - 대기열 패널 코드와 스타일은 ivLyrics(LGPL-2.1, ivLis STUDIO)에서 가져옴
//  4. Fullscreen 안의 ivLyrics 메뉴(번역, 제공자, 설정 등)를 ivLyrics 전체화면과 같은
//     ☰ 버튼으로 펴고 닫는 사이드바로 표시
//
// ivLyrics, 전체화면 확장 파일은 수정하지 않습니다.

(function ivLyricsFullscreenBridge() {
    if (!window.Spicetify?.Platform?.History || !Spicetify.React || !Spicetify.ReactDOM || !document.body) {
        setTimeout(ivLyricsFullscreenBridge, 300);
        return;
    }
    if (window.__ivlFullscreenBridgeLoaded) return;
    window.__ivlFullscreenBridgeLoaded = true;

    const LOG_PREFIX = "[ivLyrics Fullscreen Bridge]";
    const LYRICS_PLUS_PATH = "/lyrics-plus";
    const IVLYRICS_PATH = "/ivLyrics";
    const FAD_CONTAINER_SELECTOR = "#fad-lyrics-plus-container";
    const IVLYRICS_MARK = "data-fad-lyrics";
    const TV_MODE_KEY = "ivLyrics:visual:fullscreen-tv-mode";
    const FULLSCREEN_KEY_SETTING = "ivLyrics:visual:fullscreen-key";
    const DEFAULT_IVLYRICS_FULLSCREEN_KEY = "f12";

    const History = Spicetify.Platform.History;
    const react = Spicetify.React;
    const ReactDOM = Spicetify.ReactDOM;

    // ---------- 공통 유틸 ----------
    const storage = {
        get(key) {
            try {
                return window.ivLyricsStoragePersistence
                    ? window.ivLyricsStoragePersistence.getItem(key)
                    : Spicetify.LocalStorage.get(key);
            } catch (e) { return null; }
        },
        set(key, value) {
            try {
                return window.ivLyricsStoragePersistence
                    ? window.ivLyricsStoragePersistence.setItem(key, value)
                    : Spicetify.LocalStorage.set(key, value);
            } catch (e) { return null; }
        },
    };

    const getFadContainer = () => document.querySelector(FAD_CONTAINER_SELECTOR);
    const isDakshFullscreenActive = () => document.body.classList.contains("fsd-activated")
        || !!document.getElementById("full-screen-display");
    const isFullAppDisplayActive = () => document.body.classList.contains("fad-activated")
        || !!document.getElementById("full-app-display");
    const isAnyExternalFullscreenActive = () => isDakshFullscreenActive() || isFullAppDisplayActive();
    const isIvLyricsFullscreen = () => !!window.lyricContainer?.state?.isFullscreen
        || !!document.getElementById("lyrics-fullscreen-container");

    const isEditable = (el) => {
        const tag = el?.tagName?.toLowerCase();
        const role = el?.getAttribute?.("role");
        return tag === "input" || tag === "textarea" || tag === "select"
            || !!el?.isContentEditable || role === "textbox" || role === "combobox";
    };
    const isTypingTarget = (e) => isEditable(e.target) || isEditable(document.activeElement);

    function refreshIvLyrics() {
        [0, 150, 600, 1500].forEach((delay) => {
            setTimeout(() => {
                try { window.lyricContainer?.forceUpdate?.(); } catch (e) { /* ignore */ }
            }, delay);
        });
    }

    function markContainer() {
        const el = getFadContainer();
        if (el && !el.hasAttribute(IVLYRICS_MARK)) {
            el.setAttribute(IVLYRICS_MARK, "ivLyrics");
            refreshIvLyrics();
        }
    }

    // Mousetrap 형식 키("f12", "ctrl+shift+f")가 이 키 입력과 같은지
    function matchesKeyCombo(e, combo) {
        if (!combo) return false;
        const parts = String(combo).toLowerCase().split("+").map((p) => p.trim()).filter(Boolean);
        const key = parts.pop();
        if (!key) return false;
        const isMac = /mac/i.test(navigator.platform || "");
        const want = {
            ctrl: parts.includes("ctrl") || parts.includes("control") || (!isMac && parts.includes("mod")),
            shift: parts.includes("shift"),
            alt: parts.includes("alt") || parts.includes("option"),
            meta: parts.includes("meta") || parts.includes("cmd") || parts.includes("command") || (isMac && parts.includes("mod")),
        };
        if (e.ctrlKey !== want.ctrl || e.shiftKey !== want.shift || e.altKey !== want.alt || e.metaKey !== want.meta) {
            return false;
        }
        const aliases = { esc: "escape", space: " ", return: "enter", del: "delete", ins: "insert", plus: "+" };
        const wantKey = aliases[key] || key;
        const k = String(e.key || "").toLowerCase();
        const code = String(e.code || "").toLowerCase();
        return k === wantKey || code === wantKey || code === `key${wantKey}` || code === `digit${wantKey}`;
    }

    // ---------- 1) 전체화면 가사 칸 → ivLyrics ----------
    // ---------- 2) ivLyrics 전체화면 → Fullscreen 전환 ----------
    let suppressClosedNavigation = false; // ivLyrics의 "이전 페이지로" 이동을 잠시 막음
    let deferredClosedNavigation = false; // Fullscreen이 닫히면 그때 이동
    let pathBeforeExternal = null;        // Fullscreen을 열기 전 페이지
    let returnPathAfterIvFullscreen = null; // 바로 전환한 ivLyrics 전체화면을 닫으면 돌아갈 페이지
    let reverseSwitchPending = false;
    let tvSnapshot = null;                // { value, time } - 키 입력 직전 ivLyrics TV 모드 값

    function exitIvLyricsFullscreenQuietly() {
        const lc = window.lyricContainer;
        if (!lc?.state?.isFullscreen || typeof lc.toggleFullscreen !== "function") return false;

        suppressClosedNavigation = true;
        // ivLyrics가 닫히면서 브라우저 전체화면까지 꺼 버리지 않게 잠시 막음
        const hadOwnExit = Object.prototype.hasOwnProperty.call(document, "exitFullscreen");
        const ownExit = document.exitFullscreen;
        document.exitFullscreen = () => Promise.resolve();
        try {
            lc.toggleFullscreen();
        } catch (e) {
            console.warn(`${LOG_PREFIX} ivLyrics 전체화면 종료 실패:`, e);
        } finally {
            if (hadOwnExit) document.exitFullscreen = ownExit;
            else delete document.exitFullscreen;
            // 이벤트가 동기적으로 오지 않은 경우를 대비해 조금 뒤 해제
            setTimeout(() => { suppressClosedNavigation = false; }, 1000);
        }
        return true;
    }

    // 같은 키(t)가 ivLyrics TV 모드까지 바꿨다면 되돌림
    function restoreTvModeIfToggled() {
        const snap = tvSnapshot;
        if (!snap || Date.now() - snap.time > 1500) return;
        const current = storage.get(TV_MODE_KEY);
        if ((current === "true") === (snap.value === "true")) return;
        const restored = snap.value === "true";
        storage.set(TV_MODE_KEY, String(restored));
        if (window.CONFIG?.visual) window.CONFIG.visual["fullscreen-tv-mode"] = restored;
        window.dispatchEvent(new CustomEvent("ivLyrics", { detail: { name: "fullscreen-tv-mode", value: restored } }));
        tvSnapshot = null;
    }

    let handledContainer = null;
    function onExternalFullscreenOpened() {
        const container = getFadContainer();
        if (container && handledContainer === container) return;
        handledContainer = container;
        markContainer();
        if (exitIvLyricsFullscreenQuietly()) {
            refreshIvLyrics();
        }
        [60, 300, 800].forEach((d) => setTimeout(restoreTvModeIfToggled, d));
    }

    function onExternalFullscreenClosed() {
        handledContainer = null;
        refreshIvLyrics();
        if (deferredClosedNavigation) {
            deferredClosedNavigation = false;
            // Fullscreen이 원래 페이지로 되돌린 뒤, ivLyrics 전체화면에 들어오기 전 페이지로 이동
            setTimeout(() => {
                window.dispatchEvent(new CustomEvent("ivLyrics:fullscreen-closed"));
            }, 350);
        }
    }

    // ivLyrics 전체화면 종료 이벤트 가로채기 (capture 단계라 GlobalShortcuts보다 먼저 실행)
    window.addEventListener("ivLyrics:fullscreen-closed", (e) => {
        if (suppressClosedNavigation) {
            suppressClosedNavigation = false;
            deferredClosedNavigation = true;
            e.stopImmediatePropagation();
        }
    }, true);

    // "/lyrics-plus" 이동을 "/ivLyrics"로 교체
    if (!History.push.__ivlFullscreenBridge) {
        const originalPush = History.push;
        const patchedPush = function (location, ...rest) {
            const path = typeof location === "string" ? location : location?.pathname;
            if (path === LYRICS_PLUS_PATH && getFadContainer()) {
                pathBeforeExternal = History.location?.pathname || null;
                onExternalFullscreenOpened();
                location = typeof location === "string"
                    ? IVLYRICS_PATH
                    : { ...location, pathname: IVLYRICS_PATH };
                const result = originalPush.call(this, location, ...rest);
                refreshIvLyrics();
                return result;
            }
            // Fullscreen → ivLyrics 전체화면 전환 중: Fullscreen이 닫히며 원래 페이지(홈 등)로
            // 되돌아가는 이동을 ivLyrics 페이지로 바꿔서, 홈을 거치지 않고 바로 넘어가게 함
            if (reverseSwitchPending && path && path !== IVLYRICS_PATH && !getFadContainer()) {
                location = typeof location === "string"
                    ? IVLYRICS_PATH
                    : { ...location, pathname: IVLYRICS_PATH };
            }
            return originalPush.call(this, location, ...rest);
        };
        patchedPush.__ivlFullscreenBridge = true;
        History.push = patchedPush;
    }

    // ---------- 3) Fullscreen → ivLyrics 전체화면 전환 ----------
    function closeExternalFullscreen() {
        if (isDakshFullscreenActive()) {
            Spicetify.Mousetrap?.trigger?.("esc");
        } else if (isFullAppDisplayActive()) {
            Spicetify.Mousetrap?.trigger?.("f11");
        }
    }
    // 전환용 덮개: Fullscreen 배경(흐린 앨범 이미지)을 그대로 복사해 화면을 덮고,
    // ivLyrics 전체화면이 그려진 뒤 부드럽게 사라짐
    function showSwitchCover() {
        document.getElementById("ivl-switch-cover")?.remove();
        const cover = document.createElement("div");
        cover.id = "ivl-switch-cover";
        cover.style.cssText = "position:fixed;inset:0;z-index:2147483647;background:#000;opacity:1;"
            + "pointer-events:none;transition:opacity 220ms ease;";
        try {
            const source = document.getElementById("fsd-background")
                || document.querySelector("#full-app-display canvas, #full-screen-display canvas");
            if (source && source.width && source.height) {
                const copy = document.createElement("canvas");
                copy.width = source.width;
                copy.height = source.height;
                copy.getContext("2d").drawImage(source, 0, 0);
                copy.style.cssText = "position:absolute;inset:0;width:100%;height:100%;object-fit:cover;";
                cover.appendChild(copy);
            }
        } catch (e) { /* 배경 복사가 안 되면 검은 화면으로 덮음 */ }
        document.body.appendChild(cover);
        return cover;
    }
    function hideSwitchCoverWhenReady(cover) {
        if (!cover) return;
        const started = Date.now();
        const fade = () => {
            cover.style.opacity = "0";
            setTimeout(() => cover.remove(), 260);
        };
        const check = () => {
            const lc = window.lyricContainer;
            const fsContainer = document.getElementById("lyrics-fullscreen-container");
            const ready = lc?.state?.isFullscreen && (!fsContainer || fsContainer.childElementCount > 0);
            if (ready) {
                // 두 프레임 기다려 ivLyrics 전체화면이 실제로 그려진 뒤 걷어냄
                requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(fade, 80)));
            } else if (Date.now() - started < 3000) {
                setTimeout(check, 30);
            } else {
                fade();
            }
        };
        check();
    }

    function switchToIvLyricsFullscreen(afterOpen = null) {
        if (reverseSwitchPending) return;
        reverseSwitchPending = true;

        // ivLyrics 전체화면에서 넘어왔던 경우엔 ivLyrics가 돌아갈 페이지를 이미 기억하고 있음.
        // 아니면 Fullscreen을 열기 전 페이지를 기억해 두었다가 ivLyrics 전체화면을 닫을 때 돌아감.
        const ivLyricsRemembersReturn = deferredClosedNavigation;
        deferredClosedNavigation = false;
        returnPathAfterIvFullscreen = ivLyricsRemembersReturn || !pathBeforeExternal || pathBeforeExternal === IVLYRICS_PATH
            ? null
            : pathBeforeExternal;

        // Fullscreen이 닫히면서 브라우저 전체화면까지 끄지 않도록 잠시 막음 → 풀렸다 다시 켜지지 않음
        let restoreExitFullscreen = null;
        if (document.fullscreenElement) {
            const hadOwn = Object.prototype.hasOwnProperty.call(document, "exitFullscreen");
            const ownExit = document.exitFullscreen;
            document.exitFullscreen = () => Promise.resolve();
            restoreExitFullscreen = () => {
                if (hadOwn) document.exitFullscreen = ownExit;
                else delete document.exitFullscreen;
            };
        }

        // 전환하는 동안 원래 Spotify 화면이 비치지 않도록 화면을 덮어 둠
        const cover = showSwitchCover();

        closeExternalFullscreen();
        const started = Date.now();
        const openIvLyrics = () => {
            reverseSwitchPending = false;
            if (restoreExitFullscreen) restoreExitFullscreen();
            const lc = window.lyricContainer;
            const onLyricsPage = (History.location?.pathname || "").includes(IVLYRICS_PATH);
            if (onLyricsPage && lc && typeof lc.toggleFullscreen === "function") {
                if (!lc.state?.isFullscreen) lc.toggleFullscreen();
            } else {
                // 예외 상황: ivLyrics 자체 처리(GlobalShortcuts)에 맡김
                window.dispatchEvent(new CustomEvent("ivLyrics", { detail: { type: "fullscreen-toggle" } }));
            }
            hideSwitchCoverWhenReady(cover);
            if (typeof afterOpen === "function") afterOpen();
        };
        const waitClosed = () => {
            if (isAnyExternalFullscreenActive() && Date.now() - started < 2500) {
                setTimeout(waitClosed, 30);
                return;
            }
            setTimeout(openIvLyrics, 30);
        };
        waitClosed();
    }

    // 바로 전환한 ivLyrics 전체화면을 닫으면 Fullscreen을 열기 전 페이지로 돌아감
    window.addEventListener("ivLyrics:fullscreen-closed", () => {
        const target = returnPathAfterIvFullscreen;
        if (!target) return;
        returnPathAfterIvFullscreen = null;
        setTimeout(() => {
            if ((History.location?.pathname || "") === IVLYRICS_PATH && !getFadContainer()) {
                History.push(target);
            }
        }, 0);
    });

    window.addEventListener("keydown", (e) => {
        if (e.repeat || isTypingTarget(e)) return;

        // ivLyrics 전체화면 중: TV 모드 값 기억 (t 키 충돌 대비)
        if (isIvLyricsFullscreen()) {
            tvSnapshot = { value: storage.get(TV_MODE_KEY), time: Date.now() };
            return;
        }

        if (!isAnyExternalFullscreenActive()) return;

        // Fullscreen 중 ivLyrics 전체화면 키 → Fullscreen 닫고 ivLyrics 전체화면으로
        const ivKey = storage.get(FULLSCREEN_KEY_SETTING) || DEFAULT_IVLYRICS_FULLSCREEN_KEY;
        if (matchesKeyCombo(e, ivKey)) {
            e.preventDefault();
            e.stopImmediatePropagation();
            switchToIvLyricsFullscreen();
            return;
        }

        // Fullscreen 중 q → ivLyrics 스타일 대기열 고정/해제
        if (isDakshFullscreenActive() && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey
            && (e.code === "KeyQ" || String(e.key).toLowerCase() === "q")) {
            e.preventDefault();
            e.stopImmediatePropagation();
            QueueStore.togglePinned();
        }
    }, true);

    // Fullscreen의 대기열 버튼 클릭 → 우리 패널로
    window.addEventListener("click", (e) => {
        const btn = e.target?.closest?.("#full-screen-display #fsd-queue");
        if (!btn) return;
        e.preventDefault();
        e.stopPropagation();
        QueueStore.togglePinned();
    }, true);

    // ---------- 대기열 사이드바 (ivLyrics QueuePanel 이식) ----------
    const QueueStore = {
        pinned: false,
        listeners: new Set(),
        setPinned(v) {
            this.pinned = !!v;
            const btn = document.querySelector("#full-screen-display #fsd-queue");
            if (btn) btn.classList.toggle("button-active", this.pinned);
            if (btn) btn.classList.toggle("dot-after", this.pinned);
            this.listeners.forEach((fn) => fn(this.pinned));
        },
        togglePinned() { this.setPinned(!this.pinned); },
    };

    const t = (key, fallback) => {
        try {
            const v = window.I18n?.t?.(key);
            return v && v !== key ? v : fallback;
        } catch (e) { return fallback; }
    };

    const QUEUE_EMPTY_GRACE_MS = 1500;
    const getNonEmptyString = (...values) => {
        for (const value of values) {
            if (typeof value === "string" && value.trim()) return value.trim();
        }
        return "";
    };
    const isUnknownTrackMetadata = (meta) => {
        if (!meta) return true;
        const title = meta.title || "";
        const artist = meta.artist_name || "";
        return (title.toLowerCase() === "unknown" && artist.toLowerCase() === "unknown") || (!title && !artist);
    };
    const createQueueTrackInfo = (meta, track, options = {}) => {
        const uri = getNonEmptyString(track?.uri, meta?.uri);
        const uid = getNonEmptyString(track?.uid, meta?.uid);
        const explicitContextUri = getNonEmptyString(meta?.context_uri, track?.contextUri, track?.context_uri, track?.context?.uri);
        const contextUri = explicitContextUri || (options.allowFallbackContext ? options.fallbackContextUri : "");
        const queueSource = options.source || "";
        const canPlayInContext = Boolean(uri && contextUri && contextUri !== uri && options.allowContextPlayback !== false);
        return {
            title: meta?.title || "Unknown",
            artist: meta?.artist_name || "Unknown",
            image: meta?.image_url || "",
            uri, uid, contextUri, queueSource, canPlayInContext,
            index: options.index || 0,
            key: `${queueSource}:${uid || uri || "unknown"}:${options.index || 0}`,
        };
    };
    const isRecommendedQueueTrack = (track) => Boolean(track && track.queueSource !== "queued" && !track.canPlayInContext);
    const areTrackInfoEqual = (a, b) => {
        if (a === b) return true;
        if (!a || !b) return false;
        return a.title === b.title && a.artist === b.artist && a.image === b.image && a.uri === b.uri
            && a.uid === b.uid && a.contextUri === b.contextUri && a.queueSource === b.queueSource
            && a.canPlayInContext === b.canPlayInContext && a.index === b.index;
    };
    const areTrackListsEqual = (a, b) => {
        if (a === b) return true;
        if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) if (!areTrackInfoEqual(a[i], b[i])) return false;
        return true;
    };
    const readContextTrack = (track) => {
        const contextTrack = track?.contextTrack || track || {};
        const meta = contextTrack.metadata || track?.metadata || {};
        const ref = {
            uri: contextTrack.uri || track?.uri || "",
            uid: contextTrack.uid || track?.uid || "",
            contextUri: contextTrack.contextUri || contextTrack.context_uri || contextTrack.context?.uri
                || track?.contextUri || track?.context_uri || track?.context?.uri || "",
        };
        return { meta, ref };
    };

    const h = react.createElement;
    const { useState, useEffect, useCallback, useMemo, useRef } = react;

    const renderQueueItem = (track, key, onTrackClick) => h("div", {
        key, className: "fullscreen-queue-item", onClick: () => onTrackClick(track),
    },
        track.image && h("img", { src: track.image, className: "fullscreen-queue-item-image" }),
        h("div", { className: "fullscreen-queue-item-info" },
            h("div", { className: "fullscreen-queue-item-title" }, track.title),
            h("div", { className: "fullscreen-queue-item-artist" }, track.artist)
        )
    );

    const QueuePanel = () => {
        const [isHovered, setIsHovered] = useState(false);
        const [pinned, setPinned] = useState(QueueStore.pinned);
        const [currentTrack, setCurrentTrack] = useState(null);
        const [nextTracks, setNextTracks] = useState([]);
        const [recentTracks, setRecentTracks] = useState([]);
        const [activeTab, setActiveTab] = useState("queue");
        const nextTracksRef = useRef([]);
        const emptyQueueTimerRef = useRef(null);
        const playSeqRef = useRef(0);

        useEffect(() => {
            QueueStore.listeners.add(setPinned);
            return () => QueueStore.listeners.delete(setPinned);
        }, []);

        const commitNextTracks = useCallback((tracks, { deferEmpty = false } = {}) => {
            const next = Array.isArray(tracks) ? tracks : [];
            if (deferEmpty && next.length === 0 && nextTracksRef.current.length > 0) {
                if (emptyQueueTimerRef.current) clearTimeout(emptyQueueTimerRef.current);
                emptyQueueTimerRef.current = setTimeout(() => {
                    emptyQueueTimerRef.current = null;
                    nextTracksRef.current = [];
                    setNextTracks((prev) => (prev.length === 0 ? prev : []));
                }, QUEUE_EMPTY_GRACE_MS);
                return;
            }
            if (emptyQueueTimerRef.current) {
                clearTimeout(emptyQueueTimerRef.current);
                emptyQueueTimerRef.current = null;
            }
            nextTracksRef.current = next;
            setNextTracks((prev) => (areTrackListsEqual(prev, next) ? prev : next));
        }, []);

        useEffect(() => {
            const updateQueue = (queueData = null) => {
                try {
                    const playerData = Spicetify.Player.data;
                    const currentContextUri = playerData?.context?.uri || playerData?.item?.metadata?.context_uri || "";
                    const queueState = queueData?.data || Spicetify.Queue || {};
                    const prevSource = queueState.prevTracks || Spicetify.Queue?.prevTracks || [];

                    if (playerData?.item) {
                        const meta = playerData.item.metadata;
                        const cur = {
                            title: meta?.title || "Unknown",
                            artist: meta?.artist_name || "Unknown",
                            image: meta?.image_url || "",
                            uri: playerData.item.uri,
                        };
                        setCurrentTrack((prev) => (areTrackInfoEqual(prev, cur) ? prev : cur));
                    }

                    const next = [];
                    const appendNextTracks = (items, source, allowContextPlayback = true) => {
                        if (!Array.isArray(items) || next.length >= 15) return false;
                        for (const track of items) {
                            const { meta, ref } = readContextTrack(track);
                            if (isUnknownTrackMetadata(meta)) return true;
                            next.push(createQueueTrackInfo(meta, ref, {
                                source, fallbackContextUri: currentContextUri, allowFallbackContext: false,
                                allowContextPlayback, index: next.length + 1,
                            }));
                            if (next.length >= 15) return true;
                        }
                        return false;
                    };
                    if (Array.isArray(queueState?.queued) || Array.isArray(queueState?.nextUp)) {
                        const stopped = appendNextTracks(queueState.queued || [], "queued", false);
                        if (!stopped) appendNextTracks(queueState.nextUp || [], "nextUp", true);
                    } else {
                        appendNextTracks(queueState.nextTracks || [], "nextTracks", true);
                    }
                    commitNextTracks(next, { deferEmpty: true });

                    if (prevSource.length > 0) {
                        const prev = [];
                        for (let i = prevSource.length - 1; i >= 0 && prev.length < 10; i--) {
                            const { meta, ref } = readContextTrack(prevSource[i]);
                            prev.push(createQueueTrackInfo(meta, ref, {
                                source: "recent", fallbackContextUri: currentContextUri, allowFallbackContext: false,
                                allowContextPlayback: false, index: prev.length + 1,
                            }));
                        }
                        setRecentTracks((c) => (areTrackListsEqual(c, prev) ? c : prev));
                    } else {
                        setRecentTracks((c) => (c.length === 0 ? c : []));
                    }
                } catch (e) {
                    console.warn(`${LOG_PREFIX} 대기열 갱신 실패:`, e);
                }
            };

            updateQueue();
            const interval = setInterval(updateQueue, 5000);
            const songChangeHandler = () => updateQueue();
            Spicetify.Player.addEventListener("songchange", songChangeHandler);
            const queueUpdateHandler = (payload) => updateQueue(payload);
            Spicetify.Player.origin?._events?.addListener?.("queue_update", queueUpdateHandler);
            return () => {
                clearInterval(interval);
                if (emptyQueueTimerRef.current) clearTimeout(emptyQueueTimerRef.current);
                Spicetify.Player.removeEventListener("songchange", songChangeHandler);
                Spicetify.Player.origin?._events?.removeListener?.("queue_update", queueUpdateHandler);
            };
        }, [commitNextTracks]);

        const handleTrackClick = useCallback((track) => {
            if (!track?.uri) return;
            try {
                const idx = nextTracks.findIndex((x) =>
                    (track.key && x.key === track.key) || (track.uid && x.uid === track.uid) || x.uri === track.uri);
                if (idx >= 0) {
                    const s = nextTracks[idx];
                    const cur = { title: s.title || "Unknown", artist: s.artist || "Unknown", image: s.image || "", uri: s.uri };
                    setCurrentTrack((prev) => (areTrackInfoEqual(prev, cur) ? prev : cur));
                    commitNextTracks(nextTracks.slice(idx + 1));
                }
                const contextUri = track.canPlayInContext ? track.contextUri : "";
                const playDirectly = () => Spicetify.Player.playUri(track.uri);
                const seq = ++playSeqRef.current;
                if (contextUri) {
                    const options = { skipTo: { uri: track.uri } };
                    if (track.uid) options.skipTo.uid = track.uid;
                    Spicetify.Player.playUri(contextUri, {}, options);
                    setTimeout(() => {
                        if (playSeqRef.current !== seq) return;
                        if ((Spicetify.Player.data?.item?.uri || "") !== track.uri) playDirectly();
                    }, 900);
                    return;
                }
                playDirectly();
            } catch (e) {
                console.warn(`${LOG_PREFIX} 곡 재생 실패:`, e);
            }
        }, [nextTracks, commitNextTracks]);

        const upNextTracks = useMemo(() => nextTracks.filter((x) => !isRecommendedQueueTrack(x)), [nextTracks]);
        const recommendedTracks = useMemo(() => nextTracks.filter(isRecommendedQueueTrack), [nextTracks]);
        const visible = isHovered || pinned;

        return h("div", { className: "fullscreen-queue-wrapper", onMouseLeave: () => setIsHovered(false) },
            h("div", { className: "fullscreen-queue-trigger-area", onMouseEnter: () => setIsHovered(true) }),
            h("div", {
                className: `fullscreen-queue-panel ${visible ? "visible" : ""}`,
                onMouseEnter: () => setIsHovered(true),
            },
                h("div", { className: "fullscreen-queue-content" },
                    activeTab === "queue"
                        ? h(react.Fragment, null,
                            currentTrack && h("div", { className: "fullscreen-queue-section" },
                                h("div", { className: "fullscreen-queue-section-title" }, t("fullscreen.queue.nowPlaying", "지금 재생 중")),
                                h("div", { className: "fullscreen-queue-list" },
                                    h("div", { className: "fullscreen-queue-item current" },
                                        currentTrack.image && h("img", { src: currentTrack.image, className: "fullscreen-queue-item-image" }),
                                        h("div", { className: "fullscreen-queue-item-info" },
                                            h("div", { className: "fullscreen-queue-item-title" }, currentTrack.title),
                                            h("div", { className: "fullscreen-queue-item-artist" }, currentTrack.artist)
                                        ),
                                        h("div", { className: "fullscreen-queue-item-playing" },
                                            h("span", { className: "fullscreen-queue-playing-icon" }, "♪"))
                                    )
                                )
                            ),
                            upNextTracks.length > 0 && h("div", { className: "fullscreen-queue-section" },
                                h("div", { className: "fullscreen-queue-section-title" }, t("fullscreen.queue.upNext", "다음 재생 목록")),
                                h("div", { className: "fullscreen-queue-list" },
                                    upNextTracks.map((x, i) => renderQueueItem(x, x.key || `next-${x.uid || x.uri || i}`, handleTrackClick)))
                            ),
                            recommendedTracks.length > 0 && h("div", { className: "fullscreen-queue-section" },
                                h("div", { className: "fullscreen-queue-section-title" }, t("fullscreen.queue.recommended", "추천곡")),
                                h("div", { className: "fullscreen-queue-list" },
                                    recommendedTracks.map((x, i) => renderQueueItem(x, x.key || `recommended-${x.uid || x.uri || i}`, handleTrackClick)))
                            ),
                            nextTracks.length === 0 && h("div", { className: "fullscreen-queue-empty" },
                                t("fullscreen.queue.empty", "대기열이 비어 있습니다"))
                        )
                        : (recentTracks.length > 0
                            ? h("div", { className: "fullscreen-queue-list" },
                                recentTracks.map((x, i) => renderQueueItem(x, `recent-${i}`, handleTrackClick)))
                            : h("div", { className: "fullscreen-queue-empty" },
                                t("fullscreen.queue.noRecent", "최근 재생 기록이 없습니다")))
                ),
                h("div", { className: "fullscreen-queue-footer" },
                    h("button", {
                        className: `fullscreen-queue-tab ${activeTab === "queue" ? "active" : ""}`,
                        type: "button", "aria-pressed": activeTab === "queue", onClick: () => setActiveTab("queue"),
                    }, t("fullscreen.queue.title", "재생목록")),
                    h("button", {
                        className: `fullscreen-queue-tab ${activeTab === "recent" ? "active" : ""}`,
                        type: "button", "aria-pressed": activeTab === "recent", onClick: () => setActiveTab("recent"),
                    }, t("fullscreen.queue.recentlyPlayed", "최근 재생한 항목"))
                )
            )
        );
    };

    // 스타일: ivLyrics 대기열 패널 스타일을 이 확장의 영역 안에서만 적용 (ivLyrics 본체에는 영향 없음)
    const QUEUE_ROOT_CLASS = "ivl-bridge-queue-root";
    const style = document.createElement("style");
    style.id = "ivl-fullscreen-bridge-style";
    style.textContent = `
.${QUEUE_ROOT_CLASS} {
  --iv-motion-ease-standard: cubic-bezier(0.22, 1, 0.36, 1);
  --iv-motion-ease-emphasis: cubic-bezier(0.2, 0.9, 0.2, 1);
  --iv-motion-duration-fast: 260ms;
  --iv-motion-duration-medium: 420ms;
  position: fixed; top: 0; right: 0; width: 0; height: 0; z-index: 1000;
}
/* Fullscreen이 띄우던 Spotify 기본 대기열 패널은 숨김 (ivLyrics 스타일 패널로 대체) */
body.fsd-activated .fsd-queue-panel { display: none !important; }

/* ivLyrics 가사 칸의 contain(layout paint) 때문에 사이드바·싱크 바가 화면이 아닌
   가사 칸(오른쪽 절반) 기준으로 배치되고 잘림 → Fullscreen 안에서만 해제 */
#fad-lyrics-plus-container .lyrics-lyricsContainer-LyricsContainer.fad-enabled {
  contain: none;
}

/* ===== ivLyrics 7.x 사이드바 (.ivl-tb): ivLyrics 전체화면처럼 "메뉴" 버튼으로 접고 펴기 ===== */
/* 위치: 화면 오른쪽 16px, 아래 24px (ivLyrics 전체화면과 동일). 기준점이 화면이 아니면 --ivl-cb-* 로 보정 */
#fad-lyrics-plus-container .lyrics-lyricsContainer-LyricsContainer.fad-enabled .lyrics-config-button-container.ivl-tb.ivl-fad-menu {
  right: calc(16px - var(--ivl-cb-right-gap, 0px)) !important;
  bottom: calc(24px - var(--ivl-cb-bottom-gap, 0px)) !important;
  left: auto !important;
  top: auto !important;
  max-height: calc(100vh - 44px);
  opacity: 1;
  transform: none;
  pointer-events: auto;
  transition: opacity var(--ivl-tb-t, 200ms) ease, transform var(--ivl-tb-t, 200ms) ease;
}
/* 마우스를 3초 움직이지 않으면 숨김 (ivLyrics 전체화면과 같은 조건) */
#fad-lyrics-plus-container .lyrics-lyricsContainer-LyricsContainer.fad-enabled.controls-hidden .lyrics-config-button-container.ivl-tb.ivl-fad-menu:not(.is-engaged):not(:hover):not(:has(:focus-visible)) {
  opacity: 0;
  transform: translateX(6px);
  pointer-events: none;
}
/* 접혀 있을 때는 "메뉴" 버튼만 */
.ivl-tb.ivl-fad-menu:not(.is-menu-open):not(.is-menu-closing) > .ivl-tb-col > .ivl-tb-content {
  display: none !important;
}
.ivl-fad-toggle-wrap,
.ivl-fs-icon { display: contents; }
/* 전체화면 버튼: ivLyrics 전체화면과 같은 "전체화면 종료" 아이콘 */
.ivl-tb.ivl-fad-menu .ivl-tb-item[data-entry="fullscreen"] .ivl-tb-ico:has(.ivl-fs-icon) > svg:not(.ivl-fs-svg) { display: none; }
/* Fullscreen 확장이 가사 칸 버튼에 주던 여백 제거 */
#full-screen-display #fad-lyrics-plus-container .ivl-tb .lyrics-config-button,
#fad-lyrics-plus-container .ivl-tb .lyrics-config-button { margin-right: 0 !important; }

/* ===== 하단 싱크 바 (7.x: .lyrics-quick-sync-stack) =====
   가사 칸 아래에 떠 있지 않고 ivLyrics 전체화면처럼 화면 바닥, 오른쪽 절반 시작점에 */
#fad-lyrics-plus-container .lyrics-lyricsContainer-LyricsContainer.fad-enabled .lyrics-quick-sync-stack {
  position: fixed;
  left: calc(50vw + var(--iv-track-sync-pill-edge, 16px) - var(--ivl-cb-left, 0px));
  right: auto;
  bottom: calc(16px - var(--ivl-cb-bottom-gap, 0px));
  width: calc(50vw - 104px);
  opacity: 1;
  transform: translateY(0) scale(1);
}
#fad-lyrics-plus-container .lyrics-lyricsContainer-LyricsContainer.fad-enabled .lyrics-quick-sync-stack .lyrics-track-sync-pill {
  opacity: 1;
  transform: none;
  pointer-events: auto;
}
#fad-lyrics-plus-container .lyrics-lyricsContainer-LyricsContainer.fad-enabled.controls-hidden .lyrics-quick-sync-stack:not(:focus-within) {
  opacity: 0;
  transform: translateY(var(--iv-motion-distance-md, 12px)) scale(0.98);
}
#fad-lyrics-plus-container .lyrics-lyricsContainer-LyricsContainer.fad-enabled.controls-hidden .lyrics-quick-sync-stack:not(:focus-within) .lyrics-track-sync-pill {
  pointer-events: none;
}
/* (예전 ivLyrics: 싱크 바가 묶음 없이 바로 있을 때) */
#fad-lyrics-plus-container .lyrics-lyricsContainer-LyricsContainer.fad-enabled > .lyrics-track-sync-pill {
  position: fixed;
  left: calc(50vw + var(--iv-track-sync-pill-edge, 16px) - var(--ivl-cb-left, 0px));
  right: auto;
  bottom: calc(16px - var(--ivl-cb-bottom-gap, 0px));
  max-width: calc(50vw - 32px);
  opacity: 1;
  transform: translateY(0) scale(1);
  pointer-events: auto;
}
#fad-lyrics-plus-container .lyrics-lyricsContainer-LyricsContainer.fad-enabled.controls-hidden > .lyrics-track-sync-pill:not(:focus-within) {
  opacity: 0;
  transform: translateY(var(--iv-motion-distance-md, 12px)) scale(0.98);
  pointer-events: none;
}

/* 가사 칸을 기준점으로 만드는 transform은 Fullscreen의 가사 숨김 애니메이션이 아닐 때만 끔 */
#full-screen-display:not(.lyrics-hide-force):not(.lyrics-unavailable) .ivl-no-transform,
#full-app-display .ivl-no-transform {
  transform: none !important;
}

/* 번역 진행 표시: 왼쪽 위(Fullscreen 재생 목록 표시)·가운데 위(시계)와 겹치지 않게 오른쪽 위로 */
#fad-lyrics-plus-container .lyrics-lyricsContainer-LyricsContainer.fad-enabled .lyrics-generation-status-stack {
  left: auto;
  right: calc(20px - var(--ivl-cb-right-gap, 0px));
  top: calc(20px - var(--ivl-cb-top, 0px));
  justify-content: flex-end;
  max-width: calc(50vw - 40px);
}
` + `
/* ========================================
   Queue Panel - Compact Floating Glass
   ======================================== */

.ivl-bridge-queue-root .fullscreen-queue-wrapper {
  --iv-queue-panel-edge: max(12px, env(safe-area-inset-right, 0px));
  --iv-queue-panel-top: max(12px, env(safe-area-inset-top, 0px));
  --iv-queue-panel-bottom: max(12px, env(safe-area-inset-bottom, 0px));
  --iv-queue-panel-width: min(340px, calc(100vw - 24px));
  --iv-queue-panel-radius: 22px;
  position: fixed;
  top: 0;
  right: 0;
  width: 0;
  height: 100vh;
  height: 100dvh;
  z-index: 1000;
  pointer-events: none;
}

/* Keep the edge gesture available while leaving the compact toolbar clear. */
.ivl-bridge-queue-root .fullscreen-queue-trigger-area {
  position: fixed;
  top: 0;
  right: 0;
  width: 16px;
  height: 100vh;
  height: 100dvh;
  background: transparent;
  pointer-events: auto;
  z-index: 1000;
}

.ivl-bridge-queue-root .fullscreen-queue-trigger-area::before {
  content: "";
  position: absolute;
  top: 50%;
  right: 4px;
  width: 3px;
  height: 42px;
  border-radius: 999px;
  background: rgba(var(--spice-rgb-text), 0.16);
  opacity: 0;
  transform: translateY(-50%) scaleY(0.78);
  transition:
    opacity var(--iv-motion-duration-fast) ease,
    transform var(--iv-motion-duration-fast) var(--iv-motion-ease-standard);
}

.ivl-bridge-queue-root .fullscreen-queue-trigger-area:hover::before {
  opacity: 1;
  transform: translateY(-50%) scaleY(1);
}

.ivl-bridge-queue-root .fullscreen-queue-panel {
  position: fixed;
  top: var(--iv-queue-panel-top);
  right: var(--iv-queue-panel-edge);
  bottom: var(--iv-queue-panel-bottom);
  width: var(--iv-queue-panel-width);
  height: auto;
  min-height: 0;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  color: var(--spice-text, #fff);
  background: rgba(var(--spice-rgb-card), 0.56);
  border: 1px solid rgba(var(--spice-rgb-text), 0.1);
  border-radius: var(--iv-queue-panel-radius);
  box-shadow: 0 14px 38px rgba(0, 0, 0, 0.28);
  backdrop-filter: blur(18px) saturate(135%);
  -webkit-backdrop-filter: blur(18px) saturate(135%);
  z-index: 1001;
  pointer-events: none;
  visibility: hidden;
  font-family: var(--font-family, 'Pretendard Variable', -apple-system, BlinkMacSystemFont, sans-serif);
  opacity: 0;
  transform: translate3d(calc(100% + 28px), 0, 0) scale(0.985);
  transform-origin: right center;
  transition:
    transform var(--iv-motion-duration-medium) var(--iv-motion-ease-emphasis),
    opacity var(--iv-motion-duration-fast) var(--iv-motion-ease-standard),
    visibility 0s linear var(--iv-motion-duration-medium);
}

.ivl-bridge-queue-root .fullscreen-queue-panel.visible {
  pointer-events: auto;
  visibility: visible;
  opacity: 1;
  transform: translate3d(0, 0, 0) scale(1);
  transition-delay: 0s;
}

/* Page-only fullscreen forces these elements absolute and full-height earlier. */
.ivl-bridge-queue-root .lyrics-lyricsContainer-LyricsContainer.fullscreen-active.fullscreen-page-ui .fullscreen-queue-panel {
  height: auto;
}

/* Footer tabs share one capsule instead of separate cards. */
.ivl-bridge-queue-root .fullscreen-queue-footer {
  position: relative;
  flex: 0 0 auto;
  display: flex;
  gap: 0;
  margin: 4px 8px 8px;
  padding: 3px;
  background: rgba(var(--spice-rgb-text), 0.045);
  border: 1px solid rgba(var(--spice-rgb-text), 0.08);
  border-radius: 999px;
}

.ivl-bridge-queue-root .fullscreen-queue-footer::after {
  content: "";
  position: absolute;
  z-index: 2;
  top: 9px;
  bottom: 9px;
  left: 50%;
  width: 1px;
  background: rgba(var(--spice-rgb-text), 0.12);
  transform: translateX(-0.5px);
  pointer-events: none;
}

.ivl-bridge-queue-root .fullscreen-queue-tab {
  position: relative;
  z-index: 1;
  flex: 1;
  height: 32px;
  padding: 0 10px;
  color: rgba(var(--spice-rgb-text), 0.62);
  background: transparent;
  border: 0;
  border-radius: 999px;
  font: inherit;
  font-size: 12px;
  font-weight: 650;
  line-height: 1;
  letter-spacing: -0.01em;
  text-align: center;
  cursor: pointer;
  transition:
    background var(--iv-motion-duration-fast) ease,
    color var(--iv-motion-duration-fast) ease,
    box-shadow var(--iv-motion-duration-fast) ease;
}

.ivl-bridge-queue-root .fullscreen-queue-tab:hover {
  color: var(--spice-text, #fff);
  background: rgba(var(--spice-rgb-text), 0.07);
}

.ivl-bridge-queue-root .fullscreen-queue-tab.active {
  color: var(--spice-text, #fff);
  background: rgba(var(--spice-rgb-accent, 30, 215, 96), 0.16);
  box-shadow: inset 0 0 0 1px rgba(var(--spice-rgb-accent, 30, 215, 96), 0.2);
}

.ivl-bridge-queue-root .fullscreen-queue-tab:focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 2px rgba(var(--spice-rgb-accent, 30, 215, 96), 0.72);
}

.ivl-bridge-queue-root .fullscreen-queue-content {
  flex: 1 1 auto;
  min-height: 0;
  padding: 6px 5px 4px;
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
  touch-action: pan-y;
  scrollbar-width: thin;
  scrollbar-color: rgba(var(--spice-rgb-text), 0.16) transparent;
}

/* A translated-away panel must not retain an invisible scroll surface. */
.ivl-bridge-queue-root .fullscreen-queue-panel:not(.visible) .fullscreen-queue-content {
  overflow: hidden;
  scrollbar-width: none;
}

.ivl-bridge-queue-root .fullscreen-queue-content::-webkit-scrollbar {
  width: 4px;
}

.ivl-bridge-queue-root .fullscreen-queue-panel:not(.visible) .fullscreen-queue-content::-webkit-scrollbar {
  display: none;
}

.ivl-bridge-queue-root .fullscreen-queue-content::-webkit-scrollbar-track {
  background: transparent;
  margin: 14px 0;
}

.ivl-bridge-queue-root .fullscreen-queue-content::-webkit-scrollbar-thumb {
  background: rgba(var(--spice-rgb-text), 0.16);
  border-radius: 999px;
  transition: background var(--iv-motion-duration-fast) ease;
}

.ivl-bridge-queue-root .fullscreen-queue-content::-webkit-scrollbar-thumb:hover {
  background: rgba(var(--spice-rgb-text), 0.26);
}

.ivl-bridge-queue-root .fullscreen-queue-section {
  padding: 9px 6px 4px;
}

.ivl-bridge-queue-root .fullscreen-queue-section-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 6px 7px;
  padding: 0;
  color: rgba(var(--spice-rgb-text), 0.44);
  font-size: 10px;
  font-weight: 720;
  line-height: 1.2;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

.ivl-bridge-queue-root .fullscreen-queue-section-title::after {
  content: "";
  flex: 1;
  height: 1px;
  background: rgba(var(--spice-rgb-text), 0.1);
}

.ivl-bridge-queue-root .fullscreen-queue-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 0;
}

.ivl-bridge-queue-root .fullscreen-queue-content > .fullscreen-queue-list {
  padding: 8px 6px;
}

.ivl-bridge-queue-root .fullscreen-queue-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 50px;
  margin: 0;
  padding: 5px 7px;
  overflow: hidden;
  color: inherit;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 13px;
  cursor: pointer;
  transition:
    background var(--iv-motion-duration-fast) ease,
    border-color var(--iv-motion-duration-fast) ease,
    transform var(--iv-motion-duration-fast) var(--iv-motion-ease-standard);
}

.ivl-bridge-queue-root .fullscreen-queue-item:hover {
  background: rgba(var(--spice-rgb-text), 0.07);
  border-color: rgba(var(--spice-rgb-text), 0.06);
}

.ivl-bridge-queue-root .fullscreen-queue-item:active {
  background: rgba(var(--spice-rgb-text), 0.1);
  transform: scale(0.985);
}

.ivl-bridge-queue-root .fullscreen-queue-item.current {
  cursor: default;
  background: rgba(var(--spice-rgb-accent, 30, 215, 96), 0.13);
  border-color: rgba(var(--spice-rgb-accent, 30, 215, 96), 0.22);
}

.ivl-bridge-queue-root .fullscreen-queue-item.current:hover {
  background: rgba(var(--spice-rgb-accent, 30, 215, 96), 0.16);
}

.ivl-bridge-queue-root .fullscreen-queue-item-image {
  flex: 0 0 40px;
  width: 40px;
  height: 40px;
  object-fit: cover;
  border: 1px solid rgba(var(--spice-rgb-text), 0.08);
  border-radius: 10px;
  box-shadow: none;
}

.ivl-bridge-queue-root .fullscreen-queue-item.current .fullscreen-queue-item-image {
  border-color: rgba(var(--spice-rgb-accent, 30, 215, 96), 0.32);
}

.ivl-bridge-queue-root .fullscreen-queue-item-info {
  flex: 1;
  min-width: 0;
  overflow: hidden;
}

.ivl-bridge-queue-root .fullscreen-queue-item-title {
  overflow: hidden;
  color: rgba(var(--spice-rgb-text), 0.9);
  font-size: 13px;
  font-weight: 560;
  line-height: 1.3;
  letter-spacing: -0.01em;
  text-overflow: ellipsis;
  white-space: nowrap;
  transition: color var(--iv-motion-duration-fast) ease;
}

.ivl-bridge-queue-root .fullscreen-queue-item.current .fullscreen-queue-item-title {
  color: var(--spice-text, #fff);
  font-weight: 680;
}

.ivl-bridge-queue-root .fullscreen-queue-item-artist {
  overflow: hidden;
  margin-top: 2px;
  color: rgba(var(--spice-rgb-text), 0.44);
  font-size: 11.5px;
  line-height: 1.3;
  text-overflow: ellipsis;
  white-space: nowrap;
  transition: color var(--iv-motion-duration-fast) ease;
}

.ivl-bridge-queue-root .fullscreen-queue-item-playing {
  flex: 0 0 26px;
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  color: var(--spice-accent, #1ed760);
  background: rgba(var(--spice-rgb-accent, 30, 215, 96), 0.14);
  border: 1px solid rgba(var(--spice-rgb-accent, 30, 215, 96), 0.22);
  border-radius: 999px;
}

.ivl-bridge-queue-root .fullscreen-queue-playing-icon {
  color: inherit;
  font-size: 13px;
  line-height: 1;
  transform: translateY(-0.5px);
}

.ivl-bridge-queue-root .fullscreen-queue-empty {
  display: flex;
  min-height: 180px;
  padding: 36px 20px;
  align-items: center;
  justify-content: center;
  color: rgba(var(--spice-rgb-text), 0.44);
  font-size: 13px;
  font-weight: 520;
  line-height: 1.5;
  text-align: center;
}

@media (max-width: 600px) {
  .ivl-bridge-queue-root .fullscreen-queue-wrapper {
    --iv-queue-panel-edge: max(8px, env(safe-area-inset-right, 0px));
    --iv-queue-panel-top: max(8px, env(safe-area-inset-top, 0px));
    --iv-queue-panel-bottom: max(8px, env(safe-area-inset-bottom, 0px));
    --iv-queue-panel-width: min(330px, calc(100vw - 16px));
    --iv-queue-panel-radius: 18px;
  }

  .ivl-bridge-queue-root .fullscreen-queue-trigger-area {
    width: 18px;
  }

  .ivl-bridge-queue-root .fullscreen-queue-content {
    padding-inline: 4px;
  }

  .ivl-bridge-queue-root .fullscreen-queue-section {
    padding-inline: 4px;
  }

  .ivl-bridge-queue-root .fullscreen-queue-item {
    min-height: 48px;
    padding: 4px 6px;
    border-radius: 12px;
  }

  .ivl-bridge-queue-root .fullscreen-queue-item-image {
    flex-basis: 38px;
    width: 38px;
    height: 38px;
    border-radius: 9px;
  }

  .ivl-bridge-queue-root .fullscreen-queue-footer {
    margin: 3px 6px 6px;
  }

  .ivl-bridge-queue-root .fullscreen-queue-tab {
    height: 30px;
    font-size: 11px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .ivl-bridge-queue-root .fullscreen-queue-trigger-area::before,
  .ivl-bridge-queue-root .fullscreen-queue-panel,
  .ivl-bridge-queue-root .fullscreen-queue-item,
  .ivl-bridge-queue-root .fullscreen-queue-tab {
    transition: none;
  }
}


@media (prefers-reduced-motion: reduce) {
  .ivl-bridge-queue-root { --iv-motion-duration-fast: 1ms; --iv-motion-duration-medium: 1ms; }
}
`;
    document.head.appendChild(style);

    let queueRoot = null;
    function mountQueue() {
        if (queueRoot) return;
        queueRoot = document.createElement("div");
        queueRoot.className = QUEUE_ROOT_CLASS;
        document.body.appendChild(queueRoot);
        ReactDOM.render(h(QueuePanel), queueRoot);
    }
    function unmountQueue() {
        if (!queueRoot) return;
        try { ReactDOM.unmountComponentAtNode(queueRoot); } catch (e) { /* ignore */ }
        queueRoot.remove();
        queueRoot = null;
        QueueStore.setPinned(false);
    }

    // ---------- 4) ivLyrics 사이드바를 ivLyrics 전체화면처럼 "메뉴" 버튼으로 ----------
    // ivLyrics 7.x 사이드바(.ivl-tb)는 ivLyrics 전체화면일 때만 "메뉴" 버튼으로 접힙니다.
    // Fullscreen 안에서는 항상 펼쳐져 가사를 가리므로, 같은 모양의 "메뉴" 버튼을 붙이고
    // ivLyrics 전체화면 모드 클래스(is-fullscreen / is-menu-open)를 줘서 똑같이 접고 폅니다.
    const MENU_MOTION_MS = 220;
    // ivLyrics와 같은 기준: 이 창들 안을 누른 건 "바깥 클릭"이 아님
    const MENU_SURFACES = [
        ".ivlyrics-fluent-overlay", ".ivlyrics-cache-edit-overlay", ".community-video-overlay",
        ".confirm-dialog-overlay", "#ivLyrics-settings-overlay", "#ivLyrics-sync-creator-overlay",
        ".optionsMenu-dropdown-list", ".ivlyrics-toast-container",
        "#ivLyrics-share-image-overlay", ".lyrics-creator-profile-overlay",
    ].join(", ");

    const FadMenu = {
        open: false,
        closing: false,
        closeTimer: null,
        wrap: null,
        getToolbar() {
            return document.querySelector(`${FAD_CONTAINER_SELECTOR} .ivl-tb`);
        },
        renderButton() {
            if (!this.wrap) return;
            const Icon = window.IvLyricsToolbarIcon;
            const label = this.open ? t("buttons.close", "닫기") : t("fullscreen.menuToggleShort", "메뉴");
            const aria = this.open ? t("buttons.close", "닫기") : t("fullscreen.menuToggle", "ivLyrics");
            ReactDOM.render(h("button", {
                type: "button",
                className: "ivl-tb-item ivl-tb-toggle" + (this.open ? " is-open" : ""),
                "data-entry": "menu",
                "aria-label": aria,
                "aria-expanded": this.open,
                onClick: (e) => { e.stopPropagation(); this.toggle(); },
            },
                h("span", { className: "ivl-tb-ico" },
                    Icon ? h(Icon, { name: this.open ? "close" : "menu", size: 20 })
                        : h("span", { "aria-hidden": "true" }, this.open ? "✕" : "☰")),
                h("span", { className: "ivl-tb-label" }, label)
            ), this.wrap);
        },
        applyState(toolbar) {
            // 이미 같은 상태면 건드리지 않음 (classList.add는 값이 같아도 변경 이벤트를 만들어 감시가 무한 반복됨)
            const want = {
                "ivl-fad-menu": true,
                "is-fullscreen": true,
                "is-menu-open": this.open,
                "is-menu-closing": this.closing,
            };
            for (const [cls, on] of Object.entries(want)) {
                if (toolbar.classList.contains(cls) !== on) toolbar.classList.toggle(cls, on);
            }
        },
        ensure() {
            const toolbar = this.getToolbar();
            if (!toolbar) return;
            this.applyState(toolbar);
            const column = toolbar.querySelector(":scope > .ivl-tb-col");
            if (column && (!this.wrap || this.wrap.parentNode !== column)) {
                if (this.wrap) this.destroyButton();
                this.wrap = document.createElement("span");
                this.wrap.className = "ivl-fad-toggle-wrap";
                column.appendChild(this.wrap); // ivLyrics 전체화면처럼 맨 아래
                this.renderButton();
            }
            this.ensureFullscreenEntry(toolbar);
        },
        // 사이드바의 "전체화면" 항목: ivLyrics 전체화면과 같은 "전체화면 종료" 아이콘 + 눌린 상태
        ensureFullscreenEntry(toolbar) {
            const Icon = window.IvLyricsToolbarIcon;
            const btn = toolbar.querySelector('.ivl-tb-item[data-entry="fullscreen"]');
            if (!btn || !Icon) return;
            if (btn.getAttribute("aria-pressed") !== "true") btn.setAttribute("aria-pressed", "true");
            const ico = btn.querySelector(".ivl-tb-ico");
            if (ico && !ico.querySelector(".ivl-fs-icon")) {
                const span = document.createElement("span");
                span.className = "ivl-fs-icon";
                ico.appendChild(span);
                ReactDOM.render(h(Icon, { name: "fullscreenExit", size: 20, className: "ivl-fs-svg" }), span);
            }
        },
        refresh() {
            const toolbar = this.getToolbar();
            if (toolbar) this.applyState(toolbar);
            this.renderButton();
        },
        openMenu() {
            clearTimeout(this.closeTimer);
            this.open = true;
            this.closing = false;
            this.refresh();
            const content = this.getToolbar()?.querySelector(".ivl-tb-content");
            if (content) content.scrollTop = 0;
        },
        closeMenu() {
            if (!this.open && !this.closing) return;
            // 열려 있던 하위 패널(현재 곡, 더보기 등)도 같이 닫기
            this.getToolbar()?.querySelector(".ivl-tb-content .ivl-tb-item.is-open")?.click();
            clearTimeout(this.closeTimer);
            this.open = false;
            this.closing = true;
            this.refresh();
            this.closeTimer = setTimeout(() => {
                this.closing = false;
                this.refresh();
            }, MENU_MOTION_MS);
        },
        toggle() { this.open ? this.closeMenu() : this.openMenu(); },
        destroyButton() {
            if (!this.wrap) return;
            try { ReactDOM.unmountComponentAtNode(this.wrap); } catch (e) { /* ignore */ }
            this.wrap.remove();
            this.wrap = null;
        },
        reset() {
            clearTimeout(this.closeTimer);
            this.open = false;
            this.closing = false;
            this.destroyButton();
        },
    };

    // 메뉴 바깥 클릭 시 접기 (ivLyrics 전체화면과 같은 기준)
    document.addEventListener("click", (e) => {
        if (!FadMenu.open) return;
        const toolbar = FadMenu.getToolbar();
        const path = typeof e.composedPath === "function" ? e.composedPath() : [];
        const inside = (toolbar && toolbar.contains(e.target))
            || !!e.target?.closest?.(MENU_SURFACES)
            || path.some((node) => node === toolbar || node?.matches?.(MENU_SURFACES));
        if (!inside) FadMenu.closeMenu();
    });

    // 화면 어디서든 마우스를 움직이면 사이드바·싱크 바가 나타나게 (ivLyrics 전체화면과 동일).
    // ivLyrics는 가사 칸 위의 움직임만 감지하는데, Fullscreen에서는 가사 칸이 오른쪽 절반뿐이라 보완.
    document.addEventListener("mousemove", () => {
        if (!getFadContainer()) return;
        try { window.lyricContainer?._handleMouseMove?.(); } catch (e) { /* ignore */ }
    }, { passive: true });

    // 메뉴 안의 "전체화면 종료" 버튼 → Fullscreen을 닫고 전체화면 하기 전 화면으로
    // (ivLyrics 전체화면에서 넘어왔다면 그 전에 있던 페이지로. ivLyrics 전체화면으로 가려면 F12)
    window.addEventListener("click", (e) => {
        const btn = e.target?.closest?.(`${FAD_CONTAINER_SELECTOR} .ivl-tb-item[data-entry="fullscreen"], ${FAD_CONTAINER_SELECTOR} .lyrics-fullscreen-toggle-button`);
        if (!btn) return;
        e.preventDefault();
        e.stopPropagation();
        FadMenu.closeMenu();
        closeExternalFullscreen();
    }, true);

    // ---------- 5) 사이드바·싱크 바가 화면 기준으로 붙게 보정 ----------
    // CSS에서 transform / filter / contain / will-change 등이 걸린 조상 요소가 있으면
    // position: fixed 요소가 화면이 아니라 그 요소(가사 칸) 기준으로 배치되고 잘림.
    // 실제 앱에서 어느 요소가 그런지 직접 찾아서 해당 속성만 끄고, 못 끄면 위치를 보정함.
    const CB_NEUTRAL = {
        contain: "none",
        "will-change": "auto",
        filter: "none",
        "backdrop-filter": "none",
        "-webkit-backdrop-filter": "none",
        perspective: "none",
        "container-type": "normal",
        "content-visibility": "visible",
    };
    function containingBlockReasons(cs) {
        const r = [];
        if (cs.transform && cs.transform !== "none") r.push("transform");
        if (cs.translate && cs.translate !== "none") r.push("translate");
        if (cs.scale && cs.scale !== "none") r.push("scale");
        if (cs.rotate && cs.rotate !== "none") r.push("rotate");
        if (cs.perspective && cs.perspective !== "none") r.push("perspective");
        if (cs.filter && cs.filter !== "none") r.push("filter");
        const bf = cs.backdropFilter || cs.webkitBackdropFilter;
        if (bf && bf !== "none") r.push("backdrop-filter");
        if (/(layout|paint|strict|content)/.test(cs.contain || "")) r.push("contain");
        if (/(transform|translate|scale|rotate|perspective|filter)/.test(cs.willChange || "")) r.push("will-change");
        if (cs.containerType && cs.containerType !== "normal") r.push("container-type");
        if (cs.contentVisibility === "auto") r.push("content-visibility");
        return r;
    }
    function getOverlayRoot() {
        return document.getElementById("full-screen-display") || document.getElementById("full-app-display");
    }
    // 대상 요소에서 전체화면 화면 루트 전까지, 기준점이 되는 조상 목록
    function containingBlockChain(target) {
        const root = getOverlayRoot();
        const out = [];
        for (let p = target?.parentElement; p && p !== root && p !== document.body; p = p.parentElement) {
            const reasons = containingBlockReasons(getComputedStyle(p));
            if (reasons.length) out.push({ el: p, reasons });
        }
        return out;
    }
    const describeEl = (el) => `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}${el.classList.length ? "." + Array.from(el.classList).slice(0, 4).join(".") : ""}`;

    function fixFadLayout() {
        const fad = getFadContainer();
        if (!fad) return;
        const target = fad.querySelector(".ivl-tb") || fad.querySelector(".lyrics-quick-sync-stack")
            || fad.querySelector(".lyrics-fluent-floating-toolbar") || fad.querySelector(".lyrics-track-sync-pill");
        if (!target) return;

        // 1단계: 원인 속성 끄기
        for (const { el, reasons } of containingBlockChain(target)) {
            for (const reason of reasons) {
                if (["transform", "translate", "scale", "rotate"].includes(reason)) {
                    if (!el.classList.contains("ivl-no-transform")) el.classList.add("ivl-no-transform");
                    if (reason !== "transform" && el.style.getPropertyValue(reason) !== "none") {
                        el.style.setProperty(reason, "none", "important");
                    }
                    continue;
                }
                const props = reason === "backdrop-filter" ? ["backdrop-filter", "-webkit-backdrop-filter"] : [reason];
                for (const prop of props) {
                    if (el.style.getPropertyValue(prop) !== CB_NEUTRAL[prop] || el.style.getPropertyPriority(prop) !== "important") {
                        el.style.setProperty(prop, CB_NEUTRAL[prop], "important");
                    }
                }
            }
        }

        // 2단계: 그래도 남은 기준점(예: 가사 숨김 애니메이션 중)이 있으면 그만큼 위치 보정
        const remaining = containingBlockChain(target)[0];
        const vars = { "--ivl-cb-left": 0, "--ivl-cb-top": 0, "--ivl-cb-right-gap": 0, "--ivl-cb-bottom-gap": 0 };
        if (remaining) {
            const rect = remaining.el.getBoundingClientRect();
            const left = rect.left + remaining.el.clientLeft;
            const top = rect.top + remaining.el.clientTop;
            vars["--ivl-cb-left"] = left;
            vars["--ivl-cb-top"] = top;
            vars["--ivl-cb-right-gap"] = window.innerWidth - (left + remaining.el.clientWidth);
            vars["--ivl-cb-bottom-gap"] = window.innerHeight - (top + remaining.el.clientHeight);
        }
        for (const [name, value] of Object.entries(vars)) {
            const next = `${Math.round(value)}px`;
            if (fad.style.getPropertyValue(name) !== next) fad.style.setProperty(name, next);
        }
    }

    // 문제가 계속되면 개발자 도구 Console에서 ivlFullscreenBridgeDebug() 실행 → 결과를 보내주세요
    window.ivlFullscreenBridgeDebug = () => {
        const fad = getFadContainer();
        const target = fad?.querySelector(".ivl-tb") || fad?.querySelector(".lyrics-quick-sync-stack") || fad?.querySelector(".lyrics-track-sync-pill");
        const rect = (el) => { const r = el?.getBoundingClientRect(); return r ? `${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}` : null; };
        const chain = [];
        for (let p = target?.parentElement; p && p !== document.documentElement; p = p.parentElement) {
            const cs = getComputedStyle(p);
            chain.push({
                el: describeEl(p),
                rect: rect(p),
                reasons: containingBlockReasons(cs).join(",") || "-",
                transform: cs.transform, contain: cs.contain, willChange: cs.willChange, filter: cs.filter,
                inline: p.getAttribute("style") || "",
            });
        }
        const info = {
            viewport: `${window.innerWidth}x${window.innerHeight}`,
            toolbar: rect(fad?.querySelector(".ivl-tb")),
            pill: rect(fad?.querySelector(".lyrics-quick-sync-stack") || fad?.querySelector(".lyrics-track-sync-pill")),
            vars: fad ? ["--ivl-cb-left", "--ivl-cb-top", "--ivl-cb-right-gap", "--ivl-cb-bottom-gap"].map((n) => `${n}=${fad.style.getPropertyValue(n)}`).join(" ") : null,
        };
        console.log(LOG_PREFIX, "debug", info);
        console.table(chain);
        return JSON.stringify({ info, chain }, null, 1);
    };

    window.addEventListener("resize", () => { if (getFadContainer()) fixFadLayout(); });
    setInterval(() => { if (getFadContainer()) fixFadLayout(); }, 1000);

    // ---------- 상태 감시 ----------
    let wasActive = false;
    const sync = () => {
        const active = isAnyExternalFullscreenActive();
        if (getFadContainer()) {
            markContainer();
            onExternalFullscreenOpened();
            FadMenu.ensure();
            fixFadLayout();
        }
        if (active && !wasActive) mountQueue();
        if (!active && wasActive) {
            unmountQueue();
            FadMenu.reset();
            onExternalFullscreenClosed();
        }
        wasActive = active;
    };
    const observer = new MutationObserver(sync);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
    sync();

    // Spicetify 기본 Full App Display는 lyrics-plus가 설치돼 있어야만 가사 칸을 씀 → 확인만 통과시킴
    function ensureFullAppDisplayCheck() {
        const cfg = Spicetify.Config;
        if (!cfg) return;
        const usesFullAppDisplay = (cfg.extensions || []).some((name) => /fullAppDisplay/i.test(name));
        const hasLyricsPlus = (cfg.custom_apps || []).includes("lyrics-plus");
        if (usesFullAppDisplay && !hasLyricsPlus && !document.querySelector(`a[href='${LYRICS_PLUS_PATH}']`)) {
            const link = document.createElement("a");
            link.href = LYRICS_PLUS_PATH;
            link.hidden = true;
            link.setAttribute("aria-hidden", "true");
            link.tabIndex = -1;
            document.body.appendChild(link);
        }
    }
    ensureFullAppDisplayCheck();
    setTimeout(ensureFullAppDisplayCheck, 3000);

    console.log(`${LOG_PREFIX} 적용 완료 (v1.7.0)`);
})();
