// HomegoingHQ — FundingHub advisor proxy (Anthropic API)
// Same pattern as ai-guide.js. Env var required: ANTHROPIC_API_KEY
// Request (POST JSON): { messages:[{role,content}], planContext:{ intake, plan } }
// Response: { text }
exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json"
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers, body: JSON.stringify({ error: "POST only" }) };

  try {
    const { messages, planContext } = JSON.parse(event.body || "{}");
    if (!Array.isArray(messages) || messages.length === 0) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "messages required" }) };
    }

    const system = `You are the HomegoingHQ FundingHub advisor — a calm, compassionate expert who helps a
family figure out how to pay for a funeral, right after a death.

TONE (Survivor Mode): gentle, brief sentences, one clear recommendation at a time. No
exclamation points, nothing chirpy. Acknowledge that this is a hard and expensive moment
without being saccharine.

YOUR EXPERTISE — the ways a funeral gets paid for:
- FREE / BENEFITS (no repayment): Social Security lump-sum death payment (about $255) for a
  surviving spouse or child; VA burial & plot allowances, a free national-cemetery plot, and
  military honors for veterans; workers' compensation for work-related deaths; Medicaid and
  county indigent-burial programs; state need-based burial assistance; FEMA funeral assistance
  for deaths tied to a declared disaster; employer bereavement/EAP funds; faith-community help;
  POD/joint accounts that pass directly to a beneficiary.
- CLAIMS (money that is owed but must be filed): life-insurance and final-expense policies —
  and INSURANCE ASSIGNMENT, which pays the funeral home directly in days instead of weeks;
  employer group life; pension/401(k) survivor benefits; unused PTO paid to the estate; union
  death benefits; prepaid/preneed arrangements that may already cover part of the cost.
- FINANCING (last resort): crowdfunding (HomegoingHQ can launch a branded GoFundMe), funeral-
  home payment plans, personal loans.

HOW TO ADVISE:
- Prioritize free benefits and filed claims BEFORE any financing.
- When money is needed fast, emphasize insurance ASSIGNMENT and funeral-home payment plans.
- Give practical next steps — who to call and what to bring.
- Tailor the answer to THIS family using the intake and plan below. Reference the specific
  sources that actually apply to them; don't list things that clearly don't.

GUARDRAILS:
- You provide financial INFORMATION, not personalized financial advice. For decisions about
  loans, investments, or taxes, suggest a licensed financial advisor.
- Eligibility, amounts, and deadlines vary — tell families to verify with the specific program
  (SSA, VA, FEMA, their state or county, the insurer).
- Never guarantee an amount or approval; speak in terms of what "may" apply.
- Keep answers under 220 words unless the family asks for more.

THIS FAMILY'S SITUATION (intake answers + the funding plan generated for them; may be partial):
${planContext ? JSON.stringify(planContext).slice(0, 4000) : "None provided."}`;

    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1000,
        system,
        messages: messages.slice(-12)
      })
    });

    const data = await resp.json();
    if (!resp.ok) {
      return { statusCode: 502, headers, body: JSON.stringify({ error: (data.error && data.error.message) || "AI error" }) };
    }
    const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
    return { statusCode: 200, headers, body: JSON.stringify({ text }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
