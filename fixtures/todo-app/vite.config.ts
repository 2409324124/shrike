import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // ponytail: plugin-react's Babel + Fast Refresh step prepends 19 lines before esbuild
  // compiles JSX, which shifts jsxDEV lineNumber (React _debugSource) by 19. Keeping .tsx out
  // of Babel gives exact lines; edits do a full reload instead of Fast Refresh.
  plugins: [react({ exclude: /\.tsx$/ })],
  server: {
    port: Number(process.env.APP_PORT ?? 5173), // Shrike sets these per worktree (W2)
    strictPort: true,
    proxy: { "/api": `http://localhost:${process.env.SERVER_PORT ?? 3001}` },
  },
});
