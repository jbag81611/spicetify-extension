// NAME: ivLyrics Hide Credits
// AUTHOR: 지훈
// DESCRIPTION: ivLyrics 가사 화면 하단의 "가사 제공자 · 싱크 제작자" 표시를 숨김 (프로필 메뉴에서 켜고 끄기)
// VERSION: 1.1.1
//
// ivLyrics는 이 표시를 .lyrics-credit-footer 요소 하나로 그립니다
// (일반 화면, ivLyrics 전체화면, Fullscreen 확장 안 모두 같은 요소).
// 이 확장은 그 요소만 CSS로 숨기며, ivLyrics 파일은 수정하지 않습니다.
// 오른쪽 위 프로필 버튼 → "가사 제공자 숨기기"로 켜고 끌 수 있고, 설정은 저장됩니다.

(function ivLyricsHideCredits() {
    if (!document.head || !window.Spicetify?.LocalStorage) {
        setTimeout(ivLyricsHideCredits, 300);
        return;
    }
    if (window.__ivlHideCreditsLoaded) return;
    window.__ivlHideCreditsLoaded = true;

    const STORAGE_KEY = "ivl-hide-credits:enabled";
    const MENU_LABEL = "가사 제공자 숨기기";

    const readEnabled = () => {
        try {
            const v = Spicetify.LocalStorage.get(STORAGE_KEY);
            return v === null || v === undefined ? true : v === "true"; // 처음엔 숨김(켜짐)
        } catch (e) { return true; }
    };
    const saveEnabled = (v) => {
        try { Spicetify.LocalStorage.set(STORAGE_KEY, String(v)); } catch (e) { /* ignore */ }
    };

    const style = document.createElement("style");
    style.id = "ivl-hide-credits-style";
    style.textContent = `
.lyrics-credit-footer {
    display: none !important;
}
`;

    function apply(enabled) {
        if (enabled) {
            if (!style.isConnected) document.head.appendChild(style);
        } else {
            style.remove();
        }
    }

    let enabled = readEnabled();
    apply(enabled);

    // 프로필 메뉴 토글 (켜져 있으면 체크 표시)
    // Spicetify.Menu는 일찍 생기지만, 메뉴 항목을 그리는 부품(ReactJSX, ContextMenuV2, MenuItem)은
    // 나중에 준비됨. 너무 일찍 만들면 오류로 끝나서 메뉴에 안 나타나므로 준비될 때까지 기다림.
    let tries = 0;
    function registerMenu() {
        tries += 1;
        const ready = Spicetify.Menu?.Item
            && Spicetify.ReactJSX?.jsx
            && Spicetify.ContextMenuV2?.Item
            && Spicetify.ReactComponent?.MenuItem;
        if (!ready) {
            if (tries < 240) setTimeout(registerMenu, 500);
            return;
        }
        try {
            const item = new Spicetify.Menu.Item(MENU_LABEL, enabled, (self) => {
                enabled = !enabled;
                self.setState(enabled);
                saveEnabled(enabled);
                apply(enabled);
            });
            item.register();
            console.log("[ivLyrics Hide Credits] 프로필 메뉴에 등록됨");
        } catch (e) {
            console.warn("[ivLyrics Hide Credits] 메뉴 등록 재시도:", e);
            if (tries < 240) setTimeout(registerMenu, 500);
        }
    }
    registerMenu();
})();
