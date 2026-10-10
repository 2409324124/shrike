import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/600.css";
import "@fontsource/space-grotesk/400.css";
import "@fontsource/space-grotesk/500.css";
import "@fontsource/space-grotesk/600.css";
import "./theme.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { installTheme } from "./themes/store.ts";

async function boot(): Promise<void> {
  installTheme(); // the design tokens as CSS variables, for the saved theme
  if (!window.shrike) (await import("./dev/mock-api.ts")).installMockApi();
  const { App } = location.hash === "#app-window" ? { App: (await import("./appwindow/AppWindow.tsx")).AppWindow } : await import("./app.tsx");
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void boot();
