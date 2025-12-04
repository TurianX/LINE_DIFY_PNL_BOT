// api/line-webhook.ts
import crypto from "crypto";

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).send("Method Not Allowed");
    }

    // --- LINE signature verification ---
    const rawBody = JSON.stringify(req.body || {});
    const sigHeader = String(req.headers["x-line-signature"] || "");
    const secret = process.env.LINE_CHANNEL_SECRET || "";
    if (!secret) return res.status(500).send("Missing LINE_CHANNEL_SECRET");

    const expected = crypto
      .createHmac("sha256", secret)
      .update(rawBody)
      .digest("base64");
    if (expected !== sigHeader) return res.status(401).send("Invalid signature");

    // --- Parse event ---
    const event = (req.body?.events || [])[0];
    if (!event?.replyToken) return res.status(200).send("No event");

    const replyToken = event.replyToken;
    const userId = event?.source?.userId || "anon";
    const userText = (event?.message?.text || "").trim();
    if (!userText) return res.status(200).send("Empty user text");

    // --- Dify Chat API: send full text as query ---
    const difyKey = process.env.DIFY_API_KEY || "";
    if (!difyKey) return res.status(500).send("Missing DIFY_API_KEY");

    const difyResp = await fetch("https://api.dify.ai/v1/chat-messages", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${difyKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        inputs: {},
        query: userText, // full user text
        response_mode: "blocking",
        user: userId,
      }),
    });

    const difyJson = await difyResp.json();

    // --- Parse Dify answer into meta + results (supports 1 or 2 JSON blocks) ---
    const { meta, results } = parseDifyAnswer(difyJson.answer);

    // Text reply: prefer meta.reply, then clarify_question, then raw answer (string)
    const reply = (
      meta?.reply ??
      meta?.clarify_question ??
      (typeof difyJson.answer === "string" ? difyJson.answer : "")
    ).toString();

    // --- Build LINE messages ---
    const messages: any[] = [];

    // Always send text reply
    messages.push({ type: "text", text: reply });

    // Build dynamic carousel from results (1–3 items). If no results, no flex.
    const contents =
      Array.isArray(results) && results.length > 0
        ? buildCarouselFromResults(results)
        : null;

    if (contents) {
      messages.push({
        type: "flex",
        altText: "ข้อมูลผ้า",
        contents,
      });
    }

    // --- Reply to LINE ---
    const accessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN || "";
    if (!accessToken)
      return res.status(500).send("Missing LINE_CHANNEL_ACCESS_TOKEN");

    const lineResp = await fetch("https://api.line.me/v2/bot/message/reply", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ replyToken, messages }),
    });

    if (!lineResp.ok) {
      const txt = await lineResp.text();
      console.error("LINE error:", txt);
      return res.status(502).send(txt);
    }

    return res.status(200).send("OK");
  } catch (err) {
    console.error("Webhook crash:", err);
    return res.status(500).send("Internal Error");
  }
}

// ---- Types for parsed data ----
type MetaJson = {
  intent?: string;
  reply?: string;
  clarify_question?: string;
  ui_format?: string;
  reply_template_applied?: boolean;
  needs_clarification?: boolean;
  // other fields from meta are allowed but not required
};

type EnrichedItem = {
  pageId: string;
  url: string;
  code: string;
  pricePerYard: number;
  typeOfFabric: string[];
  characteristics: string;
  colorName: string;
  remainingYards: number;
  fabricSampleImageUrl?: string;
  // other fields are allowed; we just ignore them for display
};

// ---- Core parser: handle 1 or 2 JSON blocks in difyJson.answer ----
function parseDifyAnswer(
  answer: any
): { meta: MetaJson | null; results: EnrichedItem[] } {
  let meta: MetaJson | null = null;
  let results: EnrichedItem[] = [];

  // Case 1: answer is a string that may contain multiple JSON objects
  if (typeof answer === "string") {
    const jsonBlocks = splitJsonObjects(answer);

    for (const block of jsonBlocks) {
      try {
        const obj = JSON.parse(block);

        // If this block has results, treat as results container
        if (Array.isArray(obj.results)) {
          results = obj.results as EnrichedItem[];
        }

        // If this block looks like meta (intent/reply/clarify_question), treat as meta
        if (obj.intent || obj.reply || obj.clarify_question) {
          meta = obj as MetaJson;
        }
      } catch {
        // ignore parse error on this block
      }
    }

    // Fallback: if no meta yet and exactly one JSON block, treat that as meta
    if (!meta && jsonBlocks.length === 1) {
      try {
        const obj = JSON.parse(jsonBlocks[0]);
        meta = obj as MetaJson;
      } catch {
        // ignore
      }
    }

    return { meta, results };
  }

  // Case 2: answer is already an object (single JSON)
  if (answer && typeof answer === "object") {
    const obj = answer as any;
    if (Array.isArray(obj.results)) {
      results = obj.results as EnrichedItem[];
    }
    meta = obj as MetaJson;
    return { meta, results };
  }

  // Nothing usable
  return { meta: null, results: [] };
}

// ---- Split a string that may contain multiple JSON objects concatenated ----
function splitJsonObjects(str: string): string[] {
  const blocks: string[] = [];
  let depth = 0;
  let start = -1;

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];

    if (ch === "{") {
      if (depth === 0) {
        start = i;
      }
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && start !== -1) {
        blocks.push(str.slice(start, i + 1));
        start = -1;
      }
    }
  }

  // If no blocks detected but looks like one JSON, push whole trimmed string
  if (blocks.length === 0) {
    const trimmed = str.trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      blocks.push(trimmed);
    }
  }

  return blocks;
}

function buildCarouselFromResults(items: EnrichedItem[]) {
  if (!Array.isArray(items) || items.length === 0) return null;

  // Limit to 3 items
  const topItems = items.slice(0, 10);

  return {
    type: "carousel",
    contents: topItems.map((item) => {
      const material =
        Array.isArray(item.typeOfFabric) && item.typeOfFabric.length > 0
          ? item.typeOfFabric.join(", ")
          : "";

      const priceText =
        typeof item.pricePerYard === "number"
          ? `THB ${item.pricePerYard}`
          : "";

      const qtyText =
        typeof item.remainingYards === "number"
          ? `${item.remainingYards} หลา`
          : "";

      // Prefer url; fallback to Notion page from pageId; final fallback generic
      const notionUrl =
        (item.url && item.url.length > 0
          ? item.url
          : item.pageId
          ? `https://www.notion.so/${item.pageId.replace(/-/g, "")}`
          : "https://www.notion.so") as string;

      // Build bubble
      const bubble: any = {
        type: "bubble",
        body: {
          type: "box",
          layout: "vertical",
          spacing: "4px",
          contents: [
            {
              type: "text",
              text: `จำนวนคงเหลือ: ${qtyText}`, // Quantity
              wrap: true,
            },
            {
              type: "text",
              text: `Fabric Code: ${item.code ?? ""}`, // Fabric code
              wrap: true,
            },
            {
              type: "text",
              text: `สีผ้า: ${item.colorName ?? ""}`, // Color
              wrap: true,
            },
            {
              type: "text",
              text: `เนื้อผ้า: ${material}`, // Material
              wrap: true,
            },
            {
              type: "text",
              text: `ราคาต่อหลา: ${priceText}`, // Price
              wrap: true,
            },
          ],
        },
        footer: {
          type: "box",
          layout: "vertical",
          contents: [
            {
              type: "button",
              action: {
                type: "uri",
                label: "รายละเอียด",
                uri: notionUrl, // each item’s Notion URL
              },
            },
          ],
        },
      };

      // 🔥 Add hero image if we have fabricSampleImageUrl
      if (item.fabricSampleImageUrl) {
        bubble.hero = {
          type: "image",
          url: item.fabricSampleImageUrl,
          size: "full",
          aspectRatio: "3:1",
          aspectMode: "cover",
        };
      }

      return bubble;
    }),
  };
}
