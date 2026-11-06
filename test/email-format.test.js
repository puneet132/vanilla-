const test = require("node:test");
const assert = require("node:assert");

let fmt;
test.before(async () => { ({ formatEmailBody: fmt } = await import("../email-format.mjs")); });

// The real flattened body a user got in their Gmail draft (Nov 2026).
const FLAT = "Hi Aneri, I am writing to express my interest in the Product Manager role at AdMedia Digital Labs. With 4 years of product experience spanning 0-to-1 launches, requirement ownership, and cross-functional execution, I am excited about the opportunity to contribute to your team. Here is how my background aligns with your requirements: - Launched mSpace, a 0-to-1 insurance app, driving 5,000+ customer activations and a 50% engagement uplift post-launch. - Authored 90+ detailed PRDs, BRDs, and user journeys, cutting cross-team requirement ambiguity by 40% and post-launch production incidents by 50%. - Collaborated closely with UI/UX teams using Figma for prototyping to improve feature ROI by 25%. - Leveraged data and analytics tools like Amplitude and Mixpanel to define KPIs, track metrics, and guide product roadmaps. - Partnered with 5+ Scrum teams using Jira and Confluence to align stakeholders and streamline delivery. While my background is in BFSI, e-commerce, and healthcare rather than digital media, my core product management frameworks, stakeholder alignment skills, and data-driven mindset transfer directly to building scalable B2B and B2C products. Please find my resume attached for more details on my experience. Best regards, Puneet Gupta";

test("formatEmailBody rebuilds a flattened email", async (t) => {
  const out = () => fmt(FLAT);

  await t.test("greeting on its own line", () => {
    assert.match(out(), /^Hi Aneri,\n\nI am writing/);
  });

  await t.test("each bullet on its own line, hyphenated words untouched", () => {
    const bullets = out().split("\n").filter(l => l.startsWith("- "));
    assert.strictEqual(bullets.length, 5);
    assert.match(bullets[0], /^- Launched mSpace, a 0-to-1 insurance app/);
    assert.match(out(), /post-launch\./);
    assert.match(out(), /requirements:\n\n- Launched/);
  });

  await t.test("the paragraph after the last bullet is pulled back out", () => {
    assert.match(out(), /streamline delivery\.\n\nWhile my background/);
  });

  await t.test("closing line and sign-off are separated", () => {
    assert.match(out(), /B2C products\.\n\nPlease find my resume attached/);
    assert.match(out(), /experience\.\n\nBest regards,\nPuneet Gupta$/);
  });

  await t.test("no words are lost or added", () => {
    const words = s => s.replace(/^- /gm, "").replace(/\s+-\s+/g, " ").split(/\s+/).join(" ");
    assert.strictEqual(words(out()), words(FLAT));
  });
});

test("formatEmailBody leaves good input alone", async (t) => {
  await t.test("a body that already has line breaks is returned unchanged", () => {
    const b = "Hi Sam,\n\nShort note.\n\n- One\n- Two\n\nThanks,\nPuneet";
    assert.strictEqual(fmt(b), b);
  });
  await t.test("a single sentence with no structure is unchanged", () => {
    assert.strictEqual(fmt("Just checking in on my application."), "Just checking in on my application.");
  });
  await t.test("non-strings and empty strings pass through", () => {
    assert.strictEqual(fmt(""), "");
    assert.strictEqual(fmt(undefined), undefined);
  });
  await t.test("en/em dashes inside prose are not treated as bullets", () => {
    const b = "Hi Sam, I led the launch – it went well. Regards, Puneet";
    assert.strictEqual(fmt(b), "Hi Sam,\n\nI led the launch – it went well.\n\nRegards,\nPuneet");
  });
});
