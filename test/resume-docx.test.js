// End-to-end regression for the reported bug: "the tailored resume, based on
// the master copy, opens with no details in it."
//
// Reproduction: the model returns a resume carrying only a title line, a
// summary and a skills list (which the old schema permitted, since `resume`
// and all its fields were optional). That went straight into the .docx and
// produced a file with no work history — nothing a recruiter would call a
// resume. These tests read the text back out of the generated .docx and
// assert the jobs are actually on the page.
const { test, describe } = require("node:test");
const assert = require("node:assert");
const { Packer } = require("docx");
const JSZip = require("jszip");

const { completeResume } = require("../api/_resume");
const { buildResumeDocument } = require("../api/job-resume-docx");

const MASTER_PROFILE = {
  identity: { name: "Alex Rivera", location: "Bristol, UK", phone: "555 0100", email: "alex@example.com", linkedin: "in/alexrivera" },
  resume: {
    experience: [
      {
        title: "Business Analyst", company: "Northwind Insurance", location: "Bristol", dates: "Mar 2022 – present",
        achievements: ["Cut policy issuance turnaround from 6 days to 2.", "Mapped the underwriting journey end to end."]
      },
      {
        title: "Associate Analyst", company: "Helio Systems", location: "Pune", dates: "Jul 2019 – Feb 2022",
        achievements: ["Automated a reconciliation report that took 3 days a month."]
      }
    ],
    education: [{ degree: "B.Tech, Computer Science", school: "Riverside University", dates: "2014 – 2018" }],
    skills: ["Requirement gathering", "SQL", "Process mapping"]
  }
};

// What the model actually returned when the bug was reported.
const THIN_MODEL_RESPONSE = {
  title_line: "Business Analyst | Insurance Operations",
  summary: "Business analyst with four years in life insurance operations.",
  skills: ["Requirement gathering", "SQL"]
};

async function docxText(resume, contact) {
  const buffer = await Packer.toBuffer(buildResumeDocument(resume, contact));
  const zip = await JSZip.loadAsync(buffer);
  const xml = await zip.file("word/document.xml").async("string");
  return [...xml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map(m => m[1]).join("\n");
}

describe("the downloaded .docx actually contains the resume", () => {
  test("a thin model response still produces a file with the full work history", async () => {
    const resume = completeResume(THIN_MODEL_RESPONSE, MASTER_PROFILE);
    const text = await docxText(resume, MASTER_PROFILE.identity);

    assert.match(text, /Alex Rivera/, "the name must be on the resume");
    assert.match(text, /Experience/, "there must be an experience section");
    assert.match(text, /Northwind Insurance/, "the current employer must appear");
    assert.match(text, /Helio Systems/, "the previous employer must appear");
    assert.match(text, /Mar 2022/, "dates must appear — a resume without them reads as evasive");
    assert.match(text, /Cut policy issuance turnaround from 6 days to 2\./, "the achievements must carry over");
    assert.match(text, /Automated a reconciliation report/);
    assert.match(text, /Education/);
    assert.match(text, /B\.Tech, Computer Science/);
  });

  test("the file is a real .docx, not a JSON blob", async () => {
    const resume = completeResume(THIN_MODEL_RESPONSE, MASTER_PROFILE);
    const buffer = await Packer.toBuffer(buildResumeDocument(resume, MASTER_PROFILE.identity));
    assert.ok(Buffer.isBuffer(buffer));
    assert.equal(buffer.slice(0, 2).toString(), "PK", "a .docx is a zip — Word rejects anything else");
    assert.ok(buffer.length > 5000, "a real resume is not a few hundred bytes");
  });

  test("tailored bullets the model did write are the ones that ship", async () => {
    const tailored = {
      ...THIN_MODEL_RESPONSE,
      experience: [{
        title: "Business Analyst", company: "Northwind Insurance", dates: "Mar 2022 – present",
        bullets: ["Rewrote the issuance flow against the JD's stated SLA targets."]
      }]
    };
    const text = await docxText(completeResume(tailored, MASTER_PROFILE), MASTER_PROFILE.identity);
    assert.match(text, /Rewrote the issuance flow/, "the model's tailoring must win");
    assert.doesNotMatch(text, /Cut policy issuance turnaround/, "it must not be pasted back alongside");
    assert.match(text, /Helio Systems/, "but the role the model dropped still comes back");
  });

  test("an empty master profile produces no invented content", async () => {
    const resume = completeResume(THIN_MODEL_RESPONSE, { resume: {} });
    const text = await docxText(resume, { name: "Someone" });
    assert.doesNotMatch(text, /Experience/, "no work history means no experience section");
    assert.doesNotMatch(text, /Northwind Insurance/);
  });
});
