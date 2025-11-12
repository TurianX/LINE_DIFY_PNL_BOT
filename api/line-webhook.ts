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

    // ALWAYS use your original static mock (ignore Dify actions to keep visuals unchanged)
    const contents = getMockCarousel();
    messages.push({
      type: "flex",
      altText: "ข้อมูลผ้า",
      contents,
    });

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

// --- Your original, fixed carousel (unchanged) ---
function getMockCarousel() {
  return {
    type: "carousel",
    contents: [
      {
        type: "bubble",
        hero: {
          type: "image",
          url: "https://pnl-mockup-assets.vercel.app/images/fabric_mock_2.png",
          size: "full",
          aspectMode: "cover",
          aspectRatio: "3:1"
        },
        body: {
          type: "box",
          layout: "vertical",
          contents: [
            {
              type: "box",
              layout: "vertical",
              spacing: "2px",
              contents: [
                { type: "text", text: "Fabric Code : PNA0814" },
                { type: "text", text: "สีผ้า : Stripe (ลาย)" },
                { type: "text", text: "ราคาต่อหลา : THB 75.00" }
              ]
            }
          ]
        },
        footer: {
          type: "box",
          layout: "vertical",
          paddingAll: "0px",
          contents: [
            {
              type: "button",
              action: { type: "uri", label: "รายละเอียด", uri: "http://linecorp.com/" }
            }
          ]
        }
      },
      {
        type: "bubble",
        hero: {
          type: "image",
          url: "https://pnl-mockup-assets.vercel.app/images/farbric_mock_1.png",
          size: "full",
          aspectMode: "cover",
          aspectRatio: "3:1"
        },
        body: {
          type: "box",
          layout: "vertical",
          contents: [
            {
              type: "box",
              layout: "vertical",
              spacing: "2px",
              contents: [
                { type: "text", text: "Fabric Code : PNA0814" },
                { type: "text", text: "สีผ้า : Stripe (ลาย)" },
                { type: "text", text: "ราคาต่อหลา : THB 75.00" }
              ]
            }
          ]
        },
        footer: {
          type: "box",
          layout: "vertical",
          paddingAll: "0px",
          contents: [
            {
              type: "button",
              action: { type: "uri", label: "รายละเอียด", uri: "http://linecorp.com/" }
            }
          ]
        }
      }
    ]
  };
}
