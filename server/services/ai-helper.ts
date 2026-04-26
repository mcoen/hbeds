import { HBedsStore } from "../store";

interface AiHelperConfig {
  apiBaseUrl: string;
  model: string;
  fallbackEnabled: boolean;
  getApiKey: () => string;
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

function toNumberValue(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

function toStringList(value: unknown, maxItems = 8): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim())
    .slice(0, maxItems);
}

function parsePossiblyFencedJson(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced?.[1] ?? trimmed).trim();
  return JSON.parse(candidate) as Record<string, unknown>;
}

function normalizeOpenAiMessageContent(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((part) => {
      if (!part || typeof part !== "object") {
        return "";
      }
      const maybeText = (part as { text?: unknown }).text;
      return typeof maybeText === "string" ? maybeText : "";
    })
    .join("\n")
    .trim();
}

async function requestOpenAiCompletion(
  config: AiHelperConfig,
  input: {
    model: string;
    systemPrompt: string;
    userPrompt: string;
    temperature?: number;
  }
): Promise<string> {
  const response = await fetch(`${config.apiBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.getApiKey()}`
    },
    body: JSON.stringify({
      model: input.model,
      temperature: input.temperature ?? 0.2,
      messages: [
        { role: "system", content: input.systemPrompt },
        { role: "user", content: input.userPrompt }
      ]
    })
  });

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`OpenAI request failed (${response.status}): ${raw || "no response body"}`);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error("OpenAI returned non-JSON output");
  }

  const content = normalizeOpenAiMessageContent(
    (payload as { choices?: Array<{ message?: { content?: unknown } }> }).choices?.[0]?.message?.content
  );
  if (!content) {
    throw new Error("OpenAI response did not include content");
  }

  return content;
}

function summarizeHbedsInsights(insights: unknown): Record<string, unknown> {
  const raw = toRecord(insights);
  const summary: Record<string, unknown> = {};
  const scalarKeys = [
    "facilityCount",
    "bedsTracked",
    "totalStaffedBeds",
    "totalOccupiedBeds",
    "totalAvailableBeds",
    "openStatusCount",
    "limitedStatusCount",
    "diversionStatusCount",
    "closedStatusCount",
    "nonCompliantFacilityCount",
    "revision"
  ];

  for (const key of scalarKeys) {
    const value = raw[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      summary[key] = value;
    } else if (typeof value === "boolean") {
      summary[key] = value;
    }
  }

  const topLaggingFacilities = Array.isArray(raw.topLaggingFacilities)
    ? raw.topLaggingFacilities.filter((value): value is string => typeof value === "string").slice(0, 8)
    : [];
  if (topLaggingFacilities.length) {
    summary.topLaggingFacilities = topLaggingFacilities;
  }

  const topConstrainedBedTypes = Array.isArray(raw.topConstrainedBedTypes)
    ? raw.topConstrainedBedTypes.filter((value): value is string => typeof value === "string").slice(0, 8)
    : [];
  if (topConstrainedBedTypes.length) {
    summary.topConstrainedBedTypes = topConstrainedBedTypes;
  }

  return summary;
}

export interface AiAnswer {
  answer: string;
  resolutionPlan: string;
  model?: string;
}

export interface AiHelperService {
  fallbackEnabled: boolean;
  buildFallbackInsights: () => Record<string, unknown>;
  buildAnswerFromOpenAi: (question: string, scopeLabel: string, insights: Record<string, unknown>) => Promise<AiAnswer>;
  buildFallbackAnswer: (question: string, scopeLabel: string, insights: Record<string, unknown>) => AiAnswer;
}

export function createAiHelperService(store: HBedsStore, config: AiHelperConfig): AiHelperService {
  function buildFallbackInsights(): Record<string, unknown> {
    const snapshot = store.summary();
    const statusCounts = Object.fromEntries(snapshot.statusCounts.map((entry) => [entry.label, entry.count]));

    return {
      facilityCount: snapshot.totalFacilities,
      bedsTracked: store.listBedStatuses().length,
      totalStaffedBeds: snapshot.totalStaffedBeds,
      totalOccupiedBeds: snapshot.totalOccupiedBeds,
      totalAvailableBeds: snapshot.totalAvailableBeds,
      openStatusCount: statusCounts.open ?? 0,
      limitedStatusCount: statusCounts.limited ?? 0,
      diversionStatusCount: statusCounts.diversion ?? 0,
      closedStatusCount: statusCounts.closed ?? 0,
      nonCompliantFacilityCount: 0,
      revision: snapshot.revision,
      topLaggingFacilities: [],
      topConstrainedBedTypes: snapshot.bedTypeCounts.map((item) => item.label)
    };
  }

  async function buildAnswerFromOpenAi(
    question: string,
    scopeLabel: string,
    insights: Record<string, unknown>
  ): Promise<AiAnswer> {
    const systemPrompt = [
      "You are the HBEDS AI Helper for California hospital bed and status operations.",
      "Use only provided context and do not fabricate data.",
      "Return strict JSON only: {\"answer\":\"...\",\"resolutionPlan\":\"...\"}.",
      "Write concise professional output for CDPH operators.",
      "In resolutionPlan, provide numbered steps with one step per line."
    ].join(" ");

    const userPrompt = [
      `Scope: ${scopeLabel}`,
      `Question: ${question}`,
      `HBEDS insights: ${JSON.stringify(summarizeHbedsInsights(insights))}`
    ].join("\n\n");

    const raw = await requestOpenAiCompletion(config, {
      model: config.model,
      systemPrompt,
      userPrompt,
      temperature: 0.2
    });
    const parsed = parsePossiblyFencedJson(raw);
    const answer = toStringValue(parsed.answer).trim();
    const resolutionPlan = toStringValue(parsed.resolutionPlan).trim();

    if (!answer || !resolutionPlan) {
      throw new Error("OpenAI response missing answer or resolutionPlan");
    }

    return {
      answer,
      resolutionPlan,
      model: config.model
    };
  }

  function buildFallbackAnswer(question: string, scopeLabel: string, insights: Record<string, unknown>): AiAnswer {
    const facilityCount = Math.round(toNumberValue(insights.facilityCount, 0));
    const bedsTracked = Math.round(toNumberValue(insights.bedsTracked, 0));
    const staffedBeds = Math.round(toNumberValue(insights.totalStaffedBeds, 0));
    const occupiedBeds = Math.round(toNumberValue(insights.totalOccupiedBeds, 0));
    const availableBeds = Math.round(toNumberValue(insights.totalAvailableBeds, 0));
    const nonCompliantCount = Math.round(toNumberValue(insights.nonCompliantFacilityCount, 0));
    const openCount = Math.round(toNumberValue(insights.openStatusCount, 0));
    const limitedCount = Math.round(toNumberValue(insights.limitedStatusCount, 0));
    const diversionCount = Math.round(toNumberValue(insights.diversionStatusCount, 0));
    const closedCount = Math.round(toNumberValue(insights.closedStatusCount, 0));
    const topLagging = toStringList(insights.topLaggingFacilities, 5);
    const topConstrained = toStringList(insights.topConstrainedBedTypes, 5);

    const questionLower = question.toLowerCase();
    const utilization = staffedBeds > 0 ? Math.round((occupiedBeds / staffedBeds) * 100) : 0;
    const hasComplianceIntent =
      questionLower.includes("15") ||
      questionLower.includes("compliance") ||
      questionLower.includes("late") ||
      questionLower.includes("overdue");
    const hasCapacityIntent =
      questionLower.includes("capacity") ||
      questionLower.includes("icu") ||
      questionLower.includes("available") ||
      questionLower.includes("beds");
    const hasStatusIntent =
      questionLower.includes("status") ||
      questionLower.includes("diversion") ||
      questionLower.includes("limited") ||
      questionLower.includes("closed");

    const findings: string[] = [];
    findings.push(
      `Scope ${scopeLabel}: ${facilityCount} facilities and ${bedsTracked} unit-level bed status records are currently tracked.`
    );
    findings.push(
      `Current statewide utilization is ${utilization}% (${occupiedBeds}/${staffedBeds} occupied staffed beds), with ${availableBeds} available beds reported.`
    );

    if (hasComplianceIntent) {
      findings.push(
        `15-minute cadence: ${nonCompliantCount} facilities are currently outside the upload requirement${
          topLagging.length > 0 ? ` (examples: ${topLagging.join(", ")}).` : "."
        }`
      );
    }

    if (hasStatusIntent) {
      findings.push(
        `Operational status mix: Open ${openCount}, Limited ${limitedCount}, Diversion ${diversionCount}, Closed ${closedCount}.`
      );
    }

    if (hasCapacityIntent || topConstrained.length > 0) {
      findings.push(
        `Most capacity-constrained bed categories${
          topConstrained.length > 0 ? ` include ${topConstrained.join(", ")}.` : " should be reviewed in the current dashboard."
        }`
      );
    }

    const resolutionPlanLines: string[] = [
      "1. Confirm the scope and isolate the affected facilities/bed categories in Facilities, Beds, and Statuses.",
      "2. Prioritize outreach for facilities missing 15-minute submissions and request immediate status refresh via FHIR, REST, or GraphQL ingestion.",
      "3. Review Limited/Diversion/Closed units for each affected facility and rebalance nearby capacity where possible.",
      "4. Validate that updates are reflected in Analytics and NHSN outbound submissions, then create a notification for unresolved items."
    ];

    if (nonCompliantCount === 0) {
      resolutionPlanLines[1] =
        "2. Maintain current cadence by monitoring the simulation and integration health dashboards for regressions.";
    }

    return {
      answer: findings.join("\n"),
      resolutionPlan: resolutionPlanLines.join("\n")
    };
  }

  return {
    fallbackEnabled: config.fallbackEnabled,
    buildFallbackInsights,
    buildAnswerFromOpenAi,
    buildFallbackAnswer
  };
}
