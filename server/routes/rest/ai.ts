import { Router } from "express";
import { sendError } from "../../http/errors";
import type { AiHelperService } from "../../services/ai-helper";

interface CreateAiRestRouterOptions {
  aiHelper: AiHelperService;
}

function toRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function toStringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function createAiRestRouter(options: CreateAiRestRouterOptions): Router {
  const router = Router();

  router.post("/ai/hbeds-helper", async (req, res) => {
    const question = toStringValue(req.body?.question).trim();
    if (!question) {
      res.status(400).json({ error: "question is required" });
      return;
    }

    const scopeLabel = toStringValue(req.body?.scopeLabel, "All Facilities").trim() || "All Facilities";
    const insights = toRecord(req.body?.insights);

    try {
      const generated = await options.aiHelper.buildAnswerFromOpenAi(question, scopeLabel, insights);
      res.json(generated);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      if (message.includes("OPENAI_API_KEY")) {
        if (!options.aiHelper.fallbackEnabled) {
          sendError(res, error, 503);
          return;
        }

        const fallback = options.aiHelper.buildFallbackAnswer(
          question,
          scopeLabel,
          options.aiHelper.buildFallbackInsights()
        );
        res.json({
          answer: `${fallback.answer}\n\n[Local rule-based guidance used because OpenAI credentials are not available.]`,
          resolutionPlan: fallback.resolutionPlan,
          model: "hbeds-local-fallback"
        });
        return;
      }

      sendError(res, error, message.includes("OPENAI_API_KEY") ? 503 : 502);
    }
  });

  return router;
}
