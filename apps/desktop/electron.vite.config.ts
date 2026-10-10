import { resolve } from "node:path";
import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// electron-vite 4 bundles dependencies by default (workspace packages ship TS source, so they must be bundled).
export default defineConfig({
  main: {
    // The database clients (docs/13 DB, src/main/datasources) load from node_modules at run time; they don't bundle cleanly.
    // scripts/release/build-mac.sh installs them into the packaged app.
    // node-llama-cpp (V9 planner) ships prebuilt native bindings: loaded from node_modules, never bundled.
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, "src/main/index.ts"), "voice-planner-worker": resolve(__dirname, "src/main/voice-planner-worker.ts") },
        external: [/^(pg|pg-native|mysql2|mongodb|redis|@redis\/.*|@aws-sdk\/client-dynamodb|node-llama-cpp|@node-llama-cpp\/.*)(\/.*)?$/],
      },
    },
  },
  preload: {
    build: {
      rollupOptions: { input: resolve(__dirname, "src/preload/index.ts"), output: { format: "cjs", entryFileNames: "[name].cjs" } },
    },
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    build: { rollupOptions: { input: resolve(__dirname, "src/renderer/index.html") } },
    plugins: [react(), tailwindcss()],
    // Keep Shrike's own UI off 5173/3000: those belong to the user's app.
    server: { port: 47321, strictPort: false },
  },
});
