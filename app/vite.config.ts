import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: process.env.APP_API_URL
    ? {
        proxy: {
          "/api": {
            target: process.env.APP_API_URL,
            changeOrigin: true,
            secure: true,
          },
        },
      }
    : undefined,
});
