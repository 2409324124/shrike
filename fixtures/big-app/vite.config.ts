import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // Same as fixtures/todo-app: keep .tsx out of plugin-react's Babel step so React source lines are exact.
  plugins: [react({ exclude: /\.tsx$/ })],
  server: {
    port: Number(process.env.WEB_PORT ?? 5190), // Shrike sets these per worktree (W2)
    strictPort: true,
    proxy: { "/api": `http://localhost:${process.env.GATEWAY_PORT ?? 4400}` },
  },
});
