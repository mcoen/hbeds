import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const webPort = Number.parseInt(env.WEB_PORT || "5280", 10);
  const apiPort = Number.parseInt(env.API_PORT || "4110", 10);

  return {
    plugins: [react()],
    server: {
      port: Number.isFinite(webPort) ? webPort : 5280,
      proxy: {
        "/api": {
          target: `http://localhost:${Number.isFinite(apiPort) ? apiPort : 4110}`,
          changeOrigin: true
        },
        "/graphql": {
          target: `http://localhost:${Number.isFinite(apiPort) ? apiPort : 4110}`,
          changeOrigin: true
        }
      }
    }
  };
});
