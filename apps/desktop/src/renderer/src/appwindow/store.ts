import { useEffect } from "react";
import { create } from "zustand";
import { api, call } from "../lib/api.ts";

/** True while the user's app is in its own window (main's app-window). */
export const useAppWindow = create<{ open: boolean }>(() => ({ open: false }));

export function useAppWindowBridge(): void {
  useEffect(() => {
    const a = api();
    void a.appWindowOpen().then((open) => useAppWindow.setState({ open })).catch(() => {});
    return a.on("app:window", (open) => useAppWindow.setState({ open: open === true }));
  }, []);
}

export const toggleAppWindow = (): void =>
  void (useAppWindow.getState().open ? call((a) => a.dockApp(), "Couldn't bring your app back") : call((a) => a.popOutApp(), "Couldn't open your app in its own window"));
