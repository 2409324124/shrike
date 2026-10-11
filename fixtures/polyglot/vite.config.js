import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react({ exclude: /\.jsx$/ })],
  server: {
    port: Number(process.env.WEB_PORT ?? 4610),
    strictPort: true,
    proxy: { "/api": `http://localhost:${process.env.GATEWAY_PORT ?? 4611}` },
  },
});
