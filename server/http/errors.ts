import type { Response } from "express";

export function sendError(res: Response, error: unknown, status = 400): void {
  const message = error instanceof Error ? error.message : "Unknown error";
  res.status(status).json({ error: message });
}
