import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  // В архиве Яндекс Игр ассеты должны разрешаться относительно index.html.
  base: "./",
  plugins: [react(), tailwindcss()],
  server: {
    host: "0.0.0.0",
    port: 3000,
    strictPort: true,
    hmr: {
      port: 3000,
    },
    // На сервере Яндекса /sdk.js предоставляется платформой. Локально
    // проксируем тот же файл, не меняя production-разметку.
    proxy: {
      "/sdk.js": {
        target: "https://sdk.games.s3.yandex.net",
        changeOrigin: true,
      },
    },
  },
});
