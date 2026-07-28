// Lobee background service worker.
//
// Its ONLY job is opening the side panel (on the toolbar action or the keyboard command). The panel
// itself talks to the Lobster sidecar's loopback agent bridge directly (the manifest allows
// `connect-src http://127.0.0.1:*`), so there is no long-lived relay here to be recycled by MV3 — a
// run can't drop just because this worker went idle.
//
// Stealth: NO content scripts, NO web-accessible resources — a visited page can't see or probe Lobee.

chrome.runtime.onInstalled.addListener(() => {
  if (chrome.sidePanel?.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  }
});

chrome.action?.onClicked.addListener((tab) => {
  if (chrome.sidePanel?.open && tab?.windowId != null) {
    chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
  }
});

chrome.commands?.onCommand.addListener((command) => {
  if (command !== 'open_lobee' || !chrome.sidePanel?.open) return;
  chrome.windows
    .getLastFocused()
    .then((w) => chrome.sidePanel.open({ windowId: w.id }))
    .catch(() => {});
});
