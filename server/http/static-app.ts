import { existsSync } from "node:fs";
import path from "node:path";
import express, { type Express } from "express";

export function mountStaticApp(app: Express): void {
  const distPath = path.resolve(process.cwd(), "dist");
  if (!existsSync(distPath)) {
    return;
  }

  app.use(express.static(distPath));
  app.get("*", (_req, res) => {
    res.sendFile(path.join(distPath, "index.html"));
  });
}
