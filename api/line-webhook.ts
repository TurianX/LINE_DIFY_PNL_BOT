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

        const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("base64");
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
                query: userText,          // full user text
                response_mode: "blocking",
                user: userId,
            }),
        });

        const difyJson = await difyResp.json();

        // Your app returns stringified JSON in `answer`
        let parsed: any = {};
        try {
            parsed = typeof difyJson?.answer === "string" ? JSON.parse(difyJson.answer) : difyJson?.answer;
        } catch {
            parsed = { reply: difyJson?.answer };
        }

        // Per your rule: send exactly what Dify says; no fallback if empty.
        const reply = (parsed?.reply ?? "").toString();

        // --- Build LINE messages ---
        const messages: any[] = [];
        messages.push({ type: "text", text: reply });

        // enriched results from Dify
        const enriched = parsed?.results || parsed?.data?.results || [];

        // Build dynamic carousel (1–3 items)
        const contents = buildCarouselFromResults(enriched);

        // Only send flex if at least 1 item exists
        if (contents) {
            messages.push({
                type: "flex",
                altText: "ข้อมูลผ้า",
                contents,
            });
        }


        // --- Reply to LINE ---
        const accessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN || "";
        if (!accessToken) return res.status(500).send("Missing LINE_CHANNEL_ACCESS_TOKEN");

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

type EnrichedItem = {
  pageId: string;
  url: string;
  code: string;
  pricePerYard: number;
  typeOfFabric: string[];
  characteristics: string;
  colorName: string;
  remainingYards: number;
};

function buildCarouselFromResults(items: EnrichedItem[]) {
  if (!items || items.length === 0) return null;

  const topItems = items.slice(0, 3);

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

      // If url exists, use it. If not, build from pageId.
      const notionUrl =
        item.url && item.url.length > 0
          ? item.url
          : item.pageId
          ? `https://www.notion.so/${item.pageId.replace(/-/g, "")}`
          : "https://www.notion.so";

      return {
        type: "bubble",
        body: {
          type: "box",
          layout: "vertical",
          spacing: "4px",
          contents: [
            {
              type: "text",
              text: `จำนวนคงเหลือ: ${qtyText}`,
              wrap: true,
            },
            {
              type: "text",
              text: `Fabric Code: ${item.code ?? ""}`,
              wrap: true,
            },
            {
              type: "text",
              text: `สีผ้า: ${item.colorName ?? ""}`,
              wrap: true,
            },
            {
              type: "text",
              text: `เนื้อผ้า: ${material}`,
              wrap: true,
            },
            {
              type: "text",
              text: `ราคาต่อหลา: ${priceText}`,
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
                uri: notionUrl,
              },
            },
          ],
        },
      };
    }),
  };
}


// --- Your original, fixed carousel (unchanged) ---
// function getMockCarousel() {
//     return {
//         type: "carousel",
//         contents: [
//             {
//                 type: "bubble",
//                 hero: {
//                     type: "image",
//                     url: "https://pnl-mockup-assets.vercel.app/images/fabric_mock_2.png",
//                     size: "full",
//                     aspectMode: "cover",
//                     aspectRatio: "3:1"
//                 },
//                 body: {
//                     type: "box",
//                     layout: "vertical",
//                     contents: [
//                         {
//                             type: "box",
//                             layout: "vertical",
//                             spacing: "2px",
//                             contents: [
//                                 { type: "text", text: "Fabric Code : PNA0814" },
//                                 { type: "text", text: "สีผ้า : Stripe (ลาย)" },
//                                 { type: "text", text: "ราคาต่อหลา : THB 75.00" }
//                             ]
//                         }
//                     ]
//                 },
//                 footer: {
//                     type: "box",
//                     layout: "vertical",
//                     paddingAll: "0px",
//                     contents: [
//                         {
//                             type: "button",
//                             action: { type: "uri", label: "รายละเอียด", uri: "http://linecorp.com/" }
//                         }
//                     ]
//                 }
//             },
//             {
//                 type: "bubble",
//                 hero: {
//                     type: "image",
//                     url: "https://pnl-mockup-assets.vercel.app/images/farbric_mock_1.png",
//                     size: "full",
//                     aspectMode: "cover",
//                     aspectRatio: "3:1"
//                 },
//                 body: {
//                     type: "box",
//                     layout: "vertical",
//                     contents: [
//                         {
//                             type: "box",
//                             layout: "vertical",
//                             spacing: "2px",
//                             contents: [
//                                 { type: "text", text: "Fabric Code : PNA0814" },
//                                 { type: "text", text: "สีผ้า : Stripe (ลาย)" },
//                                 { type: "text", text: "ราคาต่อหลา : THB 75.00" }
//                             ]
//                         }
//                     ]
//                 },
//                 footer: {
//                     type: "box",
//                     layout: "vertical",
//                     paddingAll: "0px",
//                     contents: [
//                         {
//                             type: "button",
//                             action: { type: "uri", label: "รายละเอียด", uri: "http://linecorp.com/" }
//                         }
//                     ]
//                 }
//             }
//         ]
//     };
// }