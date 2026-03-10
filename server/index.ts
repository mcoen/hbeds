import { createAppRuntime } from "./app";

const runtime = createAppRuntime();

const server = runtime.app.listen(runtime.port, () => {
  // eslint-disable-next-line no-console
  console.log(`HBEDS OpenAI config: ${runtime.openAiKeyStatus()}`);
  console.log(`HBEDS AI fallback enabled: ${runtime.openAiFallbackEnabled ? "true" : "false"}`);
  runtime.startSimulationEngine();
  // eslint-disable-next-line no-console
  console.log(`CDPH HBEDS API listening on http://localhost:${runtime.port}`);
});

server.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE") {
    // eslint-disable-next-line no-console
    console.error(
      `Port ${runtime.port} is already in use. Set a different API port, for example: API_PORT=4111 npm run dev`
    );
    process.exit(1);
  }

  throw error;
});

process.on("SIGINT", () => {
  runtime.stopSimulationEngine();
  process.exit(0);
});

process.on("SIGTERM", () => {
  runtime.stopSimulationEngine();
  process.exit(0);
});
