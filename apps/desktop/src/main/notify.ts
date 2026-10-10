import { BrowserWindow, Notification } from "electron";
import { automated, headless } from "./headless.ts";

// O9: a native notification only when Shrike isn't the window you're looking at.
export function notify(title: string, body: string): void {
  const win = BrowserWindow.getAllWindows()[0];
  if (headless || automated || !win || win.isDestroyed() || (win.isFocused() && win.isVisible()) || !Notification.isSupported()) return;
  const n = new Notification({ title, body: body.length > 180 ? `${body.slice(0, 179)}…` : body, silent: false });
  n.on("click", () => {
    if (win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
  n.show();
}
