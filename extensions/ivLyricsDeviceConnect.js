// NAME: ivLyrics Device Connect
// AUTHOR: 지훈
// DESCRIPTION: ivLyrics 전체화면 재생 버튼 줄의 "재생목록에 추가" 버튼을 "기기에 연결하기" 버튼으로 바꾸고, ivLyrics 패널 모양의 기기 목록을 띄움
// VERSION: 1.0.0
//
// - ivLyrics 전체화면의 재생 버튼 줄 맨 오른쪽 버튼(재생목록에 추가)을 숨기고 그 자리에 기기 연결 버튼을 둡니다.
// - 누르면 ivLyrics "현재 곡" 패널과 같은 모양으로 Spotify Connect 기기 목록이 뜹니다.
//   지금 재생 중인 기기는 맨 위에 초록색으로, 나머지 기기는 아래에 나오고 누르면 그 기기로 넘어갑니다.
//   (Spotify 기본 창에 있는 "주변 사람들을 잼에 초대하기"·"잼하기"는 넣지 않았습니다)
// - 다른 기기에서 재생 중이면 버튼이 Spotify처럼 초록색이 됩니다.
// - LocalCast로 로컬파일을 AirPlay 재생 중이면 Spotify Connect 창처럼 "AirPlay로 재생 중"으로 보여주고, 이 컴퓨터로 옮길 수 있습니다.
// - ivLyrics, Spotify 파일은 수정하지 않습니다.
// 문제가 있으면 개발자 도구 Console에서 ivlDeviceConnectDebug() 결과를 보내주세요.

(function ivLyricsDeviceConnect() {
    if (!window.Spicetify?.React || !Spicetify.ReactDOM || !document.body) {
        setTimeout(ivLyricsDeviceConnect, 300);
        return;
    }
    if (window.__ivlDeviceConnectLoaded) return;
    window.__ivlDeviceConnectLoaded = true;

    const LOG = "[ivLyrics Device Connect]";
    const react = Spicetify.React;
    const ReactDOM = Spicetify.ReactDOM;
    const h = react.createElement;
    const { useState, useEffect, useCallback } = react;

    const t = (key, fallback) => {
        try {
            const v = window.I18n?.t?.(key);
            return v && v !== key ? v : fallback;
        } catch (e) { return fallback; }
    };

    // ---------- 아이콘 ----------
    // 버튼: Spotify 재생바의 "기기에 연결하기"와 같은 스피커 아이콘 (16px 채움, 옆 버튼들과 같은 형식)
    const BUTTON_ICON = Spicetify.SVGIcons?.speaker
        || '<path d="M3.5 1.5a1 1 0 0 1 1-1h7a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-13zm1 0v13h7v-13h-7z"/><path d="M8 7a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm-3 2a3 3 0 1 1 6 0 3 3 0 0 1-6 0z"/><circle cx="8" cy="4" r=".9"/>';
    // 패널 안: ivLyrics 패널 아이콘과 같은 선 아이콘 (24 기준, 굵기 1.8)
    const ROW_ICONS = {
        speaker: '<rect x="6" y="2.5" width="12" height="19" rx="2.5"/><circle cx="12" cy="14" r="3.2"/><circle cx="12" cy="6.6" r=".6" fill="currentColor"/>',
        computer: '<rect x="3.5" y="4.5" width="17" height="11" rx="1.6"/><path d="M2 19h20"/>',
        tablet: '<rect x="5" y="2.5" width="14" height="19" rx="2.2"/><path d="M11 18.2h2"/>',
        smartphone: '<rect x="7" y="2.5" width="10" height="19" rx="2.2"/><path d="M11 18.2h2"/>',
        tv: '<rect x="2.5" y="4.5" width="19" height="12.5" rx="1.6"/><path d="M8 20.5h8"/>',
        car: '<path d="M5 16.5V12l1.8-4.5h10.4L19 12v4.5"/><path d="M4 16.5h16"/><circle cx="7.5" cy="16.8" r="1.3"/><circle cx="16.5" cy="16.8" r="1.3"/>',
        cast: '<path d="M3 17.5a3.5 3.5 0 0 1 3.5 3.5"/><path d="M3 13.8A7.2 7.2 0 0 1 10.2 21"/><path d="M3 6V5.5A1.5 1.5 0 0 1 4.5 4h15A1.5 1.5 0 0 1 21 5.5v13a1.5 1.5 0 0 1-1.5 1.5H14"/>',
        refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4.5V11h-6.5"/>',
        close: '<path d="M6 6l12 12M18 6L6 18"/>',
    };
    const iconFor = (type) => {
        const ty = String(type || "").toLowerCase();
        if (/speaker|avr|audio_dongle|home_thing|cast_audio/.test(ty)) return "speaker";
        if (/computer|chromebook|laptop|desktop/.test(ty)) return "computer";
        if (/tablet/.test(ty)) return "tablet";
        if (/phone|smartwatch|watch/.test(ty)) return "smartphone";
        if (/tv|stb|game|cast_video|projector/.test(ty)) return "tv";
        if (/auto|car/.test(ty)) return "car";
        return "speaker";
    };
    const Glyph = ({ name, size = 18 }) => h("svg", {
        className: "ivlyrics-toolbar-icon",
        width: size, height: size, viewBox: "0 0 24 24",
        fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round",
        "aria-hidden": "true",
        dangerouslySetInnerHTML: { __html: ROW_ICONS[name] || ROW_ICONS.speaker },
    });

    // ---------- Spotify Connect ----------
    const getConnectAPI = () => Spicetify.Platform?.ConnectAPI || null;

    // 기기 객체 안에서 "무손실" 지원/사용 표시를 찾음 (Spotify 버전마다 이름이 달라 넓게 확인)
    function findLossless(dev) {
        const seen = new Set();
        const walk = (obj, depth) => {
            if (!obj || typeof obj !== "object" || depth > 2 || seen.has(obj)) return false;
            seen.add(obj);
            for (const [k, v] of Object.entries(obj)) {
                if (/lossless/i.test(k) && (v === true || v === "enabled" || v === "active")) return true;
                if (typeof v === "string" && /^lossless$/i.test(v)) return true;
                if (/lossless/i.test(k) && v && typeof v === "object" && (v.active === true || v.enabled === true)) return true;
                if (v && typeof v === "object" && walk(v, depth + 1)) return true;
            }
            return false;
        };
        try { return walk(dev, 0); } catch (e) { return false; }
    }

    function normalizeConnectDevice(d, activeId) {
        const id = d.id || d.deviceId || d.device_id;
        return {
            id,
            name: d.isLocal ? t("ivlDevice.thisComputer", "이 컴퓨터") : (d.name || "알 수 없는 기기"),
            rawName: d.name || "",
            type: d.type || d.deviceType || "",
            active: d.isActive === true || (activeId && id === activeId),
            local: !!d.isLocal,
            lossless: findLossless(d),
            source: "connect",
        };
    }

    async function fetchDevices() {
        const api = getConnectAPI();
        try {
            let state = api?.state;
            if ((!state || !Array.isArray(state.devices)) && typeof api?.getState === "function") {
                state = await api.getState();
            }
            if (state && Array.isArray(state.devices) && state.devices.length) {
                const activeId = state.activeDevice?.id || state.activeDevice?.deviceId || null;
                return state.devices.filter((d) => d && !d.isHidden).map((d) => normalizeConnectDevice(d, activeId));
            }
        } catch (e) {
            console.warn(LOG, "ConnectAPI 읽기 실패, Web API로 대신 읽음:", e?.message || e);
        }
        // 대체: Spotify Web API (공식 문서 기준)
        const res = await Spicetify.CosmosAsync.get("https://api.spotify.com/v1/me/player/devices");
        return (res?.devices || []).map((d) => ({
            id: d.id,
            name: d.name,
            rawName: d.name,
            type: d.type,
            active: !!d.is_active,
            local: false,
            lossless: false,
            source: "webapi",
        }));
    }

    async function transferTo(device) {
        const api = getConnectAPI();
        const wasPlaying = !!Spicetify.Player?.isPlaying?.();
        if (device.source === "connect" && api) {
            try {
                if (device.local && typeof api.pullToLocal === "function") await api.pullToLocal();
                else if (typeof api.transferPlayback === "function") await api.transferPlayback(device.id, {});
                else throw new Error("transferPlayback 없음");
                // 실제로 넘어갔는지 확인
                for (let i = 0; i < 8; i++) {
                    await new Promise((r) => setTimeout(r, 250));
                    const now = await fetchDevices().catch(() => []);
                    if (now.some((d) => d.active && (d.id === device.id || (device.local && d.local)))) return true;
                }
            } catch (e) {
                console.warn(LOG, "ConnectAPI 전환 실패, Web API로 재시도:", e?.message || e);
            }
        }
        // 대체: Web API (기기 id가 다르면 이름으로 찾음)
        let targetId = device.id;
        if (device.source !== "webapi") {
            const res = await Spicetify.CosmosAsync.get("https://api.spotify.com/v1/me/player/devices").catch(() => null);
            const match = (res?.devices || []).find((d) => d.id === device.id || d.name === device.rawName);
            if (match) targetId = match.id;
        }
        await Spicetify.CosmosAsync.put("https://api.spotify.com/v1/me/player", { device_ids: [targetId], play: wasPlaying });
        return true;
    }

    // 다른 기기에서 재생 중인지 (버튼 초록색 표시용)
    function isPlayingElsewhere() {
        try {
            const lc = lcState();
            if (lcAirplayView(lc)) return true; // LocalCast로 스피커에서 재생 중
            const st = getConnectAPI()?.state;
            const active = st?.activeDevice;
            if (active) return active.isLocal === false;
            const dev = (st?.devices || []).find((d) => d.isActive);
            return dev ? dev.isLocal === false : false;
        } catch (e) { return false; }
    }

    // ---------- LocalCast (로컬파일 AirPlay) ----------
    // localcast.js가 window.LocalCastAPI로 상태를 알려줌. 없으면(구버전) 일반 Connect 목록만 보여줌.
    const lcState = () => {
        try { return window.LocalCastAPI?.getState?.() || null; } catch (e) { return null; }
    };
    const normName = (s) => String(s || "").toLowerCase().replace(/\s+/g, "");
    const isSpeakerName = (name, lc) => !!lc?.configSpeakerName && normName(name).includes(normName(lc.configSpeakerName));
    const lcAirplayView = (lc) => !!lc && (lc.casting || !!lc.remote);

    // ---------- 패널 ----------
    const getTheme = () => document.querySelector(".ivl-tb[data-ui-theme]")?.getAttribute("data-ui-theme") || "dark";

    // 화면에 그릴 줄 목록 만들기 (Spotify Connect 창 + LocalCast가 바꾼 모습과 같게)
    function buildRows(devices, lc) {
        const list = devices || [];
        if (lcAirplayView(lc)) {
            // AirPlay 재생 중: 스피커를 현재 기기로, "이 컴퓨터"는 PC 스피커로 옮기기
            const current = {
                key: "lc-airplay", name: lc.speakerName, type: "speaker", active: true,
                sub: lc.remote ? `AirPlay로 재생 중 · ${lc.remote.host}` : "AirPlay로 재생 중", tone: "blue",
            };
            const pc = {
                key: "lc-pc", name: "이 컴퓨터", type: "computer",
                sub: "여기로 옮겨서 PC 스피커로 듣기",
                act: () => window.LocalCastAPI.moveToPc(),
                done: () => !lcAirplayView(lcState()),
            };
            // 같은 스피커(Connect 쪽)는 위에 이미 나오므로 빼기
            const others = list.filter((d) => !d.local && !d.active && !isSpeakerName(d.rawName || d.name, lc))
                .map((d) => ({ key: d.id, name: d.name, type: d.type, dev: d }));
            return { current, others: [pc, ...others] };
        }
        const activeDev = list.find((d) => d.active) || null;
        const current = activeDev ? {
            key: activeDev.id, name: activeDev.name, type: activeDev.type, active: true,
            sub: activeDev.lossless ? "무손실" : "재생 중",
        } : null;
        const others = list.filter((d) => !d.active).map((d) => {
            // 로컬파일 재생 중: 스피커는 LocalCast가 AirPlay로 이어서 재생
            if (lc?.canPickSpeaker && isSpeakerName(d.rawName || d.name, lc)) {
                return {
                    key: d.id, name: d.name, type: d.type, sub: "AirPlay로 재생", tone: "blue",
                    act: () => window.LocalCastAPI.pickSpeaker(),
                    done: () => !!lcState()?.casting,
                };
            }
            return { key: d.id, name: d.name, type: d.type, dev: d };
        });
        return { current, others };
    }

    const DevicePanel = ({ onClose }) => {
        const [devices, setDevices] = useState(null);
        const [error, setError] = useState(null);
        const [pending, setPending] = useState(null);
        const [lc, setLc] = useState(lcState);

        const load = useCallback(async () => {
            try {
                const list = await fetchDevices();
                setDevices(list);
                setError(null);
            } catch (e) {
                setError(e?.message || String(e));
            }
        }, []);

        useEffect(() => {
            load();
            try { getConnectAPI()?.discoverDevices?.(); } catch (e) { /* ignore */ }
            const timer = setInterval(load, 3000);
            // LocalCast 상태는 자주 확인 (AirPlay 시작/종료가 바로 보이게)
            const lcTimer = setInterval(() => {
                const next = lcState();
                setLc((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
            }, 400);
            return () => { clearInterval(timer); clearInterval(lcTimer); };
        }, [load]);

        const choose = async (row) => {
            if (row.active || row.disabled || pending) return;
            setPending(row.key);
            try {
                if (row.act) {
                    // LocalCast 동작: 결과가 화면에 반영될 때까지 "연결 중…" 표시 (최대 10초)
                    if (row.act() === false) throw new Error("LocalCast가 지금 전환할 수 없어요");
                    for (let i = 0; i < 40 && !row.done(); i++) await new Promise((r) => setTimeout(r, 250));
                } else {
                    await transferTo(row.dev);
                }
            } catch (e) {
                console.warn(LOG, "기기 전환 실패:", e);
                Spicetify.showNotification?.(`${row.name}(으)로 전환하지 못했어요`, true);
            } finally {
                setPending(null);
                setLc(lcState());
                load();
            }
        };

        const ready = devices !== null || lcAirplayView(lc);
        const { current, others } = buildRows(devices, lc);
        const subtitle = current ? `${current.name}에서 재생 중` : t("ivlDevice.pick", "재생할 기기를 고르세요");

        const rowEl = (row) => h("button", {
            key: row.key,
            type: "button",
            className: "ivl-tb-mi" + (row.active ? " ivl-dev-active" : "") + (row.disabled ? " ivl-dev-disabled" : ""),
            role: "menuitem",
            "aria-current": row.active ? "true" : undefined,
            disabled: row.disabled || (!!pending && pending !== row.key),
            onClick: () => choose(row),
        },
            h("span", { className: "ivl-tb-mi-ico" }, h(Glyph, { name: iconFor(row.type) })),
            h("span", { className: "ivl-tb-mi-main" },
                h("span", { className: "ivl-tb-mi-label ivl-tb-trunc" }, row.name),
                pending === row.key
                    ? h("small", null, "연결 중…")
                    : row.sub ? h("small", { className: row.tone === "blue" ? "ivl-dev-blue" : undefined }, row.sub) : null
            ),
            row.active ? h("span", { className: "ivl-dev-eq" + (row.tone === "blue" ? " is-blue" : ""), "aria-hidden": "true" }, h("i"), h("i"), h("i")) : null
        );

        return h("section", { className: "ivl-tb-fly ivl-dev-fly", role: "dialog", "aria-label": "기기에 연결하기" },
            h("header", { className: "ivl-tb-fly-head" },
                h("div", { className: "ivl-tb-fly-titles" },
                    h("h2", { className: "ivl-tb-fly-title" }, "기기에 연결하기"),
                    h("p", { className: "ivl-tb-fly-sub" }, subtitle)
                ),
                h("button", {
                    type: "button", className: "ivl-tb-icon-btn", "aria-label": "새로고침", title: "새로고침",
                    onClick: () => { try { getConnectAPI()?.discoverDevices?.(); } catch (e) { /* ignore */ } load(); },
                }, h(Glyph, { name: "refresh", size: 16 })),
                h("button", {
                    type: "button", className: "ivl-tb-icon-btn", "aria-label": t("buttons.close", "닫기"), title: t("buttons.close", "닫기"),
                    onClick: onClose,
                }, h(Glyph, { name: "close", size: 16 }))
            ),
            h("div", { className: "ivl-tb-fly-body" }, h("div", { className: "ivl-tb-stack" },
                !ready && !error ? h("div", { className: "ivl-dev-empty" }, "기기를 찾는 중…") : null,
                error && !devices && !lcAirplayView(lc) ? h("div", { className: "ivl-dev-empty" }, `기기 목록을 불러오지 못했어요 (${error})`) : null,
                current
                    ? h("section", { className: "ivl-tb-sec" },
                        h("h3", { className: "ivl-tb-sec-title" }, "현재 기기"),
                        h("div", { className: "ivl-tb-group ivl-tb-menu", role: "menu" }, rowEl(current)))
                    : null,
                ready && others.length
                    ? h("section", { className: "ivl-tb-sec" },
                        h("h3", { className: "ivl-tb-sec-title" }, "다른 기기"),
                        h("div", { className: "ivl-tb-group ivl-tb-menu", role: "menu" }, others.map(rowEl)))
                    : null,
                devices && devices.length === 0 && !lcAirplayView(lc)
                    ? h("div", { className: "ivl-dev-empty" }, "연결할 수 있는 기기가 없어요. 스피커가 켜져 있고 같은 Wi-Fi에 있는지 확인해 주세요.")
                    : null
            ))
        );
    };

    // ---------- 패널 열고 닫기 ----------
    let host = null;
    let anchorBtn = null;

    function placeHost() {
        if (!host || !anchorBtn) return;
        const rect = anchorBtn.getBoundingClientRect();
        const width = Math.min(360, window.innerWidth - 24);
        const left = Math.max(12, Math.min(rect.left + rect.width / 2 - width / 2, window.innerWidth - width - 12));
        host.style.left = `${Math.round(left)}px`;
        host.style.width = `${Math.round(width)}px`;
        host.style.bottom = `${Math.round(window.innerHeight - rect.top + 12)}px`;
        host.style.setProperty("--ivl-tb-fly-max-h", `${Math.round(Math.max(200, rect.top - 24))}px`);
    }

    function openPanel(btn) {
        if (host) return closePanel();
        anchorBtn = btn;
        host = document.createElement("div");
        host.className = "ivl-tb ivl-tb-dialog ivl-dev-host";
        host.setAttribute("data-ui-theme", getTheme());
        (document.getElementById("lyrics-fullscreen-container") || document.body).appendChild(host);
        placeHost();
        ReactDOM.render(h(DevicePanel, { onClose: closePanel }), host);
        btn.classList.add("active");
        btn.setAttribute("aria-expanded", "true");
    }

    function closePanel() {
        if (!host) return;
        try { ReactDOM.unmountComponentAtNode(host); } catch (e) { /* ignore */ }
        host.remove();
        host = null;
        if (anchorBtn) {
            anchorBtn.classList.remove("active");
            anchorBtn.setAttribute("aria-expanded", "false");
        }
        anchorBtn = null;
    }

    // 바깥 클릭 / Esc 로 닫기 (Esc가 ivLyrics 전체화면까지 끄지 않도록 먼저 가로챔)
    document.addEventListener("pointerdown", (e) => {
        if (!host) return;
        if (host.contains(e.target) || anchorBtn?.contains(e.target)) return;
        closePanel();
    }, true);
    window.addEventListener("keydown", (e) => {
        if (!host || e.key !== "Escape") return;
        e.preventDefault();
        e.stopImmediatePropagation();
        closePanel();
    }, true);
    window.addEventListener("resize", placeHost);

    // ---------- 버튼 넣기 ----------
    function ensureButton() {
        const rows = document.querySelectorAll(".fullscreen-control-main-row");
        for (const row of rows) {
            let btn = row.querySelector(":scope > .ivl-dev-btn");
            if (!btn) {
                btn = document.createElement("button");
                btn.type = "button";
                btn.className = "fullscreen-control-btn ivl-dev-btn";
                btn.title = "기기에 연결하기";
                btn.setAttribute("aria-label", "기기에 연결하기");
                btn.setAttribute("aria-haspopup", "dialog");
                btn.setAttribute("aria-expanded", "false");
                btn.innerHTML = `<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">${BUTTON_ICON}</svg>`;
                btn.addEventListener("click", (e) => {
                    e.stopPropagation();
                    openPanel(btn);
                });
                row.appendChild(btn);
            }
            // 옆의 반복 버튼과 같은 크기
            const sibling = Array.from(row.querySelectorAll(":scope > .fullscreen-control-btn:not(.ivl-dev-btn):not(.fullscreen-control-play)")).pop();
            const style = sibling?.getAttribute("style") || "";
            if (style && btn.getAttribute("style") !== style) btn.setAttribute("style", style);
            const elsewhere = isPlayingElsewhere();
            if (btn.classList.contains("ivl-dev-remote") !== elsewhere) btn.classList.toggle("ivl-dev-remote", elsewhere);
        }
        if (host && (!anchorBtn || !document.contains(anchorBtn))) closePanel();
        else placeHost();
    }
    setInterval(ensureButton, 700);

    // ---------- 스타일 ----------
    const style = document.createElement("style");
    style.id = "ivl-device-connect-style";
    style.textContent = `
/* 재생 버튼 줄 맨 오른쪽 "재생목록에 추가" 버튼 숨김 */
.fullscreen-control-main-row > .fullscreen-playlist-control { display: none !important; }

.ivl-dev-btn svg { width: 100%; height: 100%; }
.ivl-dev-btn.ivl-dev-remote { color: #1ed760 !important; }

/* 패널: ivLyrics "현재 곡" 패널과 같은 모양 */
.ivl-dev-host {
  --ivl-tb-ease: cubic-bezier(0.2, 0, 0, 1);
  --ivl-tb-t-fast: 120ms;
  --ivl-tb-t: 180ms;
  --ivl-tb-t-slow: 280ms;
  position: fixed;
  z-index: 2147483000;
  display: block;
  font-family: var(--ivl-tb-font);
  color: var(--ivl-tb-text);
}
.ivl-dev-host .ivl-tb-fly.ivl-dev-fly {
  position: relative;
  right: auto;
  bottom: auto;
  width: 100%;
}
.ivl-dev-fly .ivl-tb-fly-head .ivl-tb-icon-btn + .ivl-tb-icon-btn { margin-left: 2px; }
.ivl-dev-fly .ivl-tb-mi.ivl-dev-active { cursor: default; }
.ivl-dev-fly .ivl-tb-mi.ivl-dev-disabled { cursor: default; opacity: .45; }
.ivl-dev-fly .ivl-tb-mi small.ivl-dev-blue { color: #4fb3ff; }
.ivl-dev-eq.is-blue i { background: #4fb3ff; }
.ivl-dev-fly .ivl-tb-mi.ivl-dev-active .ivl-tb-mi-label,
.ivl-dev-fly .ivl-tb-mi.ivl-dev-active .ivl-tb-mi-ico { color: #1ed760; }
.ivl-dev-empty {
  padding: 14px 16px;
  color: var(--ivl-tb-text-3, rgba(255,255,255,.6));
  font-size: 13px;
  line-height: 1.5;
}
/* 재생 중 표시 (작은 막대 3개) */
.ivl-dev-eq { display: inline-flex; align-items: flex-end; gap: 2px; height: 14px; margin-left: auto; }
.ivl-dev-eq i { display: block; width: 3px; background: #1ed760; border-radius: 1px; animation: ivl-dev-eq 1s ease-in-out infinite; }
.ivl-dev-eq i:nth-child(1) { height: 60%; animation-delay: -.2s; }
.ivl-dev-eq i:nth-child(2) { height: 100%; animation-delay: -.5s; }
.ivl-dev-eq i:nth-child(3) { height: 40%; animation-delay: -.8s; }
@keyframes ivl-dev-eq { 0%,100% { transform: scaleY(.4); } 50% { transform: scaleY(1); } }
.ivl-dev-eq i { transform-origin: bottom; }
@media (prefers-reduced-motion: reduce) { .ivl-dev-eq i { animation: none; } }
`;
    document.head.appendChild(style);

    // ---------- 확인용 ----------
    window.ivlDeviceConnectDebug = async () => {
        const api = getConnectAPI();
        const st = api?.state;
        const info = {
            hasConnectAPI: !!api,
            connectMethods: api ? Object.keys(Object.getPrototypeOf(api) || {}).concat(Object.keys(api)).filter((k) => typeof api[k] === "function") : [],
            stateKeys: st ? Object.keys(st) : null,
            firstDevice: st?.devices?.[0] || null,
            localCast: lcState(),
            normalized: await fetchDevices().catch((e) => `error: ${e?.message || e}`),
        };
        console.log(LOG, info);
        return JSON.stringify(info, null, 1);
    };

    console.log(LOG, "적용 완료");
})();
