import crypto from "crypto";

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).send("Method Not Allowed");
    }

    // 1) Verify LINE signature
    const rawBody = JSON.stringify(req.body || {});
    const sigHeader = String(req.headers["x-line-signature"] || "");
    const secret = process.env.LINE_CHANNEL_SECRET || "";
    if (!secret) return res.status(500).send("Missing LINE_CHANNEL_SECRET");

    const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("base64");
    if (expected !== sigHeader) return res.status(401).send("invalid signature");

    // 2) Parse event
    const event = (req.body?.events || [])[0];
    if (!event?.replyToken) return res.status(200).send("no event");

    const replyToken = event.replyToken;
    const userId = event?.source?.userId || "anon";
    const userText = event?.message?.text || "";

    // 3) Call Dify
    const difyUrl = process.env.DIFY_WORKFLOW_URL || "";
    const difyKey = process.env.DIFY_API_KEY || "";
    if (!difyUrl || !difyKey) return res.status(500).send("Missing Dify env vars");

    const difyResp = await fetch(difyUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${difyKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        inputs: { user_text: userText },
        response_mode: "blocking",
        user: userId
      })
    }).then(r => r.json());

    const agent = difyResp?.data || difyResp || {};
    const reply =
      (agent.reply ?? agent?.outputs?.reply ?? agent?.conversation?.reply ?? "") + "";

    // 4) Flex carousel (mock)
    const contents = getMockCarousel();

    // 5) Reply to LINE
    const accessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN || "";
    if (!accessToken) return res.status(500).send("Missing LINE_CHANNEL_ACCESS_TOKEN");

    const lineResp = await fetch("https://api.line.me/v2/bot/message/reply", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        replyToken,
        messages: [
          { type: "text", text: reply },
          { type: "flex", altText: "ตัวอย่างแคโรเซลผ้า PN", contents }
        ]
      })
    });

    if (!lineResp.ok) {
      const txt = await lineResp.text();
      console.error("LINE error:", txt);
      return res.status(502).send(txt);
    }

    return res.status(200).send("OK");
  } catch (e) {
    console.error("Webhook crash:", e);
    return res.status(500).send("internal error");
  }
}

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
      }
    ]
  };
}
