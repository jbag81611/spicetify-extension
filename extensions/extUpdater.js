// NAME: 확장 업데이트
// AUTHOR: 지훈
// DESCRIPTION: GitHub 저장소에 확장 새 버전이 올라오면 알려주고, 버튼 한 번으로 PowerShell 업데이트를 실행합니다.
// VERSION: 1.1.1
//
// - Spotify를 켤 때, 그 뒤 1분마다, Spotify 창으로 돌아올 때 GitHub 저장소의 manifest.json을 확인합니다.
//   (바뀌지 않았으면 GitHub가 304로 답해서 확인 횟수 제한에 걸리지 않음)
// - 새 버전이 있으면: 안내 창(새 버전마다 한 번), 프로필 아이콘의 파란 점, 프로필 메뉴 "내 업데이트" 칸에 목록.
// - [업데이트]를 누르면 브라우저가 열리고 jihoon-updater:// 로 PowerShell 업데이트가 실행됩니다.
//   (처음 한 번 installer/install.ps1 로 설치해야 합니다)
// - manifest.packages: 확장 말고 PC에 따로 깔리는 프로그램(예: C:\LocalCast 보조 프로그램)도 같은 방식으로 업데이트.
//   지금 버전은 그 프로그램이 켜져 있으면 http://127.0.0.1:<port>/config 의 version 으로 읽음.

(function extUpdater() {
    "use strict";
    if (!document.body || !window.Spicetify) {
        setTimeout(extUpdater, 300);
        return;
    }
    if (window.__extUpdaterLoaded) return;
    window.__extUpdaterLoaded = true;

    const OWNER = "jbag81611";
    const REPO = "spicetify-extension";
    const BRANCH = "main";
    const API_URL = `https://api.github.com/repos/${OWNER}/${REPO}/contents/manifest.json?ref=${BRANCH}`;
    const RAW_URL = `https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}/manifest.json`;
    const UPDATE_PAGE = `https://${OWNER.toLowerCase()}.github.io/${REPO}/`;
    const CHECK_MS = 60 * 1000;
    const SEEN_KEY = "extUpdater:seen";
    const LOG = "[확장 업데이트]";

    let updates = [];
    let lastCheck = 0;
    let checking = null;

    // ---------- 버전 ----------
    const parseVersion = (text) => {
        const m = /^\s*\/\/\s*VERSION:\s*v?(\d+(?:\.\d+)*)/m.exec(text) ||
            /\bVERSION\s*=\s*["']v?(\d+(?:\.\d+)*)/.exec(text);
        return m ? m[1] : null;
    };
    const cmp = (a, b) => {
        const x = String(a).split(".").map(Number);
        const y = String(b).split(".").map(Number);
        for (let i = 0; i < Math.max(x.length, y.length); i++) {
            const d = (x[i] || 0) - (y[i] || 0);
            if (d) return d > 0 ? 1 : -1;
        }
        return 0;
    };

    // Spicetify가 Spotify 안에 복사해 둔 확장 파일에서 지금 버전을 읽음 (없으면 설치 안 된 것)
    async function installedVersion(file) {
        try {
            const res = await fetch(`extensions/${file}?t=${Date.now()}`, { cache: "no-store" });
            if (!res.ok) return null;
            return parseVersion(await res.text()) || "0";
        } catch (e) {
            return null;
        }
    }

    // PC에 깔린 패키지 버전 (보조 프로그램이 꺼져 있으면 모름 → null)
    const PKG_VERSION_URL = { localcast: "http://127.0.0.1:8765/config" };
    async function installedPackageVersion(id) {
        const url = PKG_VERSION_URL[id];
        if (!url) return null;
        try {
            const ctl = new AbortController();
            const t = setTimeout(() => ctl.abort(), 2500);
            const res = await fetch(url, { cache: "no-store", signal: ctl.signal });
            clearTimeout(t);
            if (!res.ok) return null;
            const m = /v?(\d+(?:\.\d+)*)/.exec(String((await res.json()).version || ""));
            return m ? m[1] : null;
        } catch (e) {
            return null;
        }
    }

    // 바뀐 게 없으면 GitHub API가 304로 답함 (ETag 조건부 요청은 시간당 60회 제한에 포함되지 않음) → 전에 받은 것 사용
    let etag = null;
    let lastManifest = null;
    async function fetchManifest() {
        try {
            const headers = { Accept: "application/vnd.github.raw+json" };
            if (etag && lastManifest) headers["If-None-Match"] = etag;
            const res = await fetch(API_URL, { cache: "no-store", headers });
            if (res.status === 304 && lastManifest) return lastManifest;
            if (res.ok) {
                etag = res.headers.get("ETag");
                lastManifest = await res.json();
                return lastManifest;
            }
        } catch (e) { /* 아래 raw로 */ }
        const res = await fetch(`${RAW_URL}?t=${Date.now()}`, { cache: "no-store" });
        if (!res.ok) throw new Error(`manifest ${res.status}`);
        return await res.json();
    }

    function check() {
        if (checking) return checking;
        checking = (async () => {
            try {
                const manifest = await fetchManifest();
                const list = [];
                for (const ext of manifest.extensions || []) {
                    if (!ext?.file || !ext.version) continue;
                    const cur = await installedVersion(ext.file);
                    if (cur === null) list.push({ ...ext, from: null, isNew: true });
                    else if (cmp(ext.version, cur) > 0) list.push({ ...ext, from: cur, isNew: false });
                }
                for (const pkg of manifest.packages || []) {
                    if (!pkg?.file || !pkg.version) continue;
                    const cur = await installedPackageVersion(pkg.id);
                    if (cur !== null && cmp(pkg.version, cur) > 0) list.push({ ...pkg, from: cur, isNew: false });
                }
                updates = list;
                lastCheck = Date.now();
                render();
                maybePopup();
            } catch (e) {
                console.warn(LOG, "확인 실패:", e);
            } finally {
                lastCheck = Date.now(); // 실패해도 1분 뒤에 다시
                checking = null;
            }
        })();
        return checking;
    }

    // ---------- 업데이트 실행 ----------
    function runUpdate(files) {
        const only = files && files.length ? `?only=${encodeURIComponent(files.join(","))}` : "";
        const a = document.createElement("a");
        a.href = UPDATE_PAGE + only;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.style.display = "none";
        document.body.appendChild(a);
        a.click();
        a.remove();
        Spicetify.showNotification?.("브라우저에서 'jihoon-updater 열기'를 허용하면 PowerShell이 업데이트를 시작해요", false, 6000);
        closePopup();
    }

    // ---------- 스타일 ----------
    const style = document.createElement("style");
    style.id = "ext-updater-style";
    style.textContent = `
html.ext-upd-has [data-testid="user-widget-link"] { position: relative; overflow: visible !important; }
html.ext-upd-has [data-testid="user-widget-link"]::after {
    content: ""; position: absolute; top: 0; right: 0; width: 10px; height: 10px; border-radius: 50%;
    background: #3d91f4; box-shadow: 0 0 0 2px #000; pointer-events: none; z-index: 2;
}
.ext-upd-menu { padding: 4px 12px 8px; display: flex; flex-direction: column; gap: 6px; }
.ext-upd-row { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 8px; background: rgba(255,255,255,.06); }
.ext-upd-row-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.ext-upd-name { font-size: 14px; font-weight: 700; color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ext-upd-ver { font-size: 12px; color: #4fb3ff; }
.ext-upd-notes { font-size: 12px; color: #b3b3b3; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ext-upd-btn { flex: none; border: 0; border-radius: 999px; padding: 6px 12px; font: inherit; font-size: 12px; font-weight: 700;
    background: #3d91f4; color: #fff; cursor: pointer; }
.ext-upd-btn:hover { filter: brightness(1.12); }
.ext-upd-btn.is-ghost { background: rgba(255,255,255,.1); }
.ext-upd-all { display: flex; justify-content: flex-end; }
.ext-upd-overlay { position: fixed; inset: 0; z-index: 2147483000; background: rgba(0,0,0,.55);
    display: flex; align-items: center; justify-content: center; animation: ext-upd-fade .15s ease; }
.ext-upd-dialog { width: min(420px, calc(100vw - 32px)); max-height: calc(100vh - 64px); display: flex; flex-direction: column;
    background: #121212; color: #fff; border: 1px solid rgba(255,255,255,.1); border-radius: 16px;
    box-shadow: 0 24px 60px rgba(0,0,0,.5); overflow: hidden; }
.ext-upd-head { display: flex; align-items: flex-start; gap: 12px; padding: 18px 18px 14px; border-bottom: 1px solid rgba(255,255,255,.08); }
.ext-upd-titles { flex: 1; min-width: 0; }
.ext-upd-title { margin: 0; font-size: 17px; font-weight: 800; }
.ext-upd-sub { margin: 4px 0 0; font-size: 13px; color: #a7a7a7; }
.ext-upd-x { border: 0; background: transparent; color: #b3b3b3; width: 30px; height: 30px; border-radius: 8px; cursor: pointer; font-size: 18px; line-height: 1; }
.ext-upd-x:hover { background: rgba(255,255,255,.08); color: #fff; }
.ext-upd-body { padding: 14px 18px; overflow: auto; display: flex; flex-direction: column; gap: 8px; }
.ext-upd-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 18px 16px; }
.ext-upd-foot .ext-upd-btn { padding: 9px 16px; font-size: 13px; }
@keyframes ext-upd-fade { from { opacity: 0; } to { opacity: 1; } }
`;
    document.head.appendChild(style);

    const el = (tag, cls, text) => {
        const n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text != null) n.textContent = text;
        return n;
    };
    const verText = (u) => (u.isNew ? `새 확장 · ${u.version}` : `${u.from} → ${u.version}`);

    function rowEl(u, withButton) {
        const row = el("div", "ext-upd-row");
        const main = el("div", "ext-upd-row-main");
        main.append(el("div", "ext-upd-name", u.name || u.file), el("div", "ext-upd-ver", verText(u)));
        if (u.notes) {
            const notes = el("div", "ext-upd-notes", u.notes);
            notes.title = u.notes;
            main.append(notes);
        }
        row.append(main);
        if (withButton) {
            const b = el("button", "ext-upd-btn", u.isNew ? "설치" : "업데이트");
            b.type = "button";
            b.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); runUpdate([u.file]); });
            row.append(b);
        }
        return row;
    }

    // ---------- 파란 점 ----------
    function render() {
        document.documentElement.classList.toggle("ext-upd-has", updates.length > 0);
        document.querySelectorAll(".ext-upd-menu").forEach(fillMenu);
    }

    // ---------- 프로필 메뉴 "내 업데이트" ----------
    const HEADINGS = ["내 업데이트", "What's new", "What’s new", "What's New", "새로운 소식"];
    function fillMenu(box) {
        box.textContent = "";
        box.style.display = updates.length ? "" : "none";
        for (const u of updates) box.append(rowEl(u, true));
        if (updates.length > 1) {
            const all = el("div", "ext-upd-all");
            const b = el("button", "ext-upd-btn", "모두 업데이트");
            b.type = "button";
            b.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); runUpdate(null); });
            all.append(b);
            box.append(all);
        }
    }
    function findHeading(root) {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let n;
        while ((n = walker.nextNode())) {
            if (HEADINGS.includes((n.nodeValue || "").trim())) return n.parentElement;
        }
        return null;
    }
    function patchMenus() {
        const roots = document.querySelectorAll("[data-tippy-root], #context-menu, [role='dialog']");
        for (const root of roots) {
            if (root.querySelector(".ext-upd-menu")) continue;
            const heading = findHeading(root);
            let anchor = heading;
            if (!anchor) {
                // "내 업데이트"가 없는 메뉴: 프로필 메뉴(LocalCast/로그아웃 항목이 있는 메뉴)면 맨 아래에 붙임
                const isProfile = /로그아웃|Log out/.test(root.textContent || "");
                const menu = isProfile && root.querySelector("ul[role='menu'], [role='menu']");
                if (!menu || !updates.length) continue;
                const box = el("div", "ext-upd-menu");
                fillMenu(box);
                menu.append(box);
                continue;
            }
            // 제목 줄 전체 다음에 넣음
            while (anchor.parentElement && anchor.parentElement !== root && anchor.parentElement.children.length === 1) anchor = anchor.parentElement;
            const box = el("div", "ext-upd-menu");
            fillMenu(box);
            anchor.insertAdjacentElement("afterend", box);
        }
        // 확장 업데이트가 있으면 Spotify의 "모든 업데이트를 확인했습니다" 문구는 숨김
        for (const root of roots) {
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
            let n;
            while ((n = walker.nextNode())) {
                if (CAUGHT_UP.includes((n.nodeValue || "").trim()) && n.parentElement && !n.parentElement.closest(".ext-upd-menu")) {
                    n.parentElement.style.display = updates.length ? "none" : "";
                }
            }
        }
    }
    const CAUGHT_UP = ["모든 업데이트를 확인했습니다", "You're all caught up", "You’re all caught up"];
    let patchTimer = null;
    new MutationObserver(() => {
        if (patchTimer) return;
        patchTimer = setTimeout(() => { patchTimer = null; try { patchMenus(); } catch (e) { /* 무시 */ } }, 60);
    }).observe(document.body, { childList: true, subtree: true });

    // ---------- 안내 창 (새 버전 묶음마다 한 번) ----------
    let overlay = null;
    const keyOf = () => updates.map((u) => `${u.file}@${u.version}`).sort().join("|");
    function maybePopup() {
        if (!updates.length) return;
        let seen = "";
        try { seen = localStorage.getItem(SEEN_KEY) || ""; } catch (e) { /* 무시 */ }
        if (seen === keyOf()) return;
        openPopup();
    }
    function closePopup() {
        if (!overlay) return;
        try { localStorage.setItem(SEEN_KEY, keyOf()); } catch (e) { /* 무시 */ }
        overlay.remove();
        overlay = null;
        window.removeEventListener("keydown", onKey, true);
    }
    function onKey(e) {
        if (e.key === "Escape" && overlay) { e.preventDefault(); e.stopImmediatePropagation(); closePopup(); }
    }
    function openPopup() {
        if (overlay || !updates.length) return;
        overlay = el("div", "ext-upd-overlay");
        const dialog = el("section", "ext-upd-dialog");
        dialog.setAttribute("role", "dialog");
        const head = el("header", "ext-upd-head");
        const titles = el("div", "ext-upd-titles");
        titles.append(el("h2", "ext-upd-title", "업데이트가 있어요"),
            el("p", "ext-upd-sub", `확장 ${updates.length}개에 새 버전이 나왔어요`));
        const x = el("button", "ext-upd-x", "✕");
        x.type = "button";
        x.setAttribute("aria-label", "닫기");
        x.addEventListener("click", closePopup);
        head.append(titles, x);
        const body = el("div", "ext-upd-body");
        for (const u of updates) body.append(rowEl(u, false));
        const foot = el("footer", "ext-upd-foot");
        const later = el("button", "ext-upd-btn is-ghost", "나중에");
        later.type = "button";
        later.addEventListener("click", closePopup);
        const go = el("button", "ext-upd-btn", "업데이트");
        go.type = "button";
        go.addEventListener("click", () => runUpdate(null));
        foot.append(later, go);
        dialog.append(head, body, foot);
        overlay.append(dialog);
        overlay.addEventListener("pointerdown", (e) => { if (e.target === overlay) closePopup(); });
        document.body.append(overlay);
        window.addEventListener("keydown", onKey, true);
    }

    // ---------- 시작 ----------
    setTimeout(check, 4000);
    setInterval(() => { if (Date.now() - lastCheck >= CHECK_MS) check(); }, 15 * 1000);
    // Spotify 창으로 돌아오면 바로 확인 (15초 안에 확인했으면 건너뜀)
    const onBack = () => { if (!document.hidden && Date.now() - lastCheck >= 15 * 1000) check(); };
    window.addEventListener("focus", onBack);
    document.addEventListener("visibilitychange", onBack);

    // 개발자 도구용: extUpdater.check(), extUpdater.show()
    window.extUpdater = {
        check,
        show: openPopup,
        get updates() { return updates.slice(); },
        update: runUpdate,
    };
})();
