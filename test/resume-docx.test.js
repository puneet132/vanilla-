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

// The generated file used to inherit Word's built-in Heading 2 style — blue
// Calibri Light — and Word's default one-inch margins, which is why it read as
// "a Word document with words in it" rather than as a resume.
describe("the document is actually formatted", () => {
  const { buildResumeDocument, safeFileName } = require("../api/job-resume-docx");

  async function parts(resume, contact) {
    const buffer = await Packer.toBuffer(buildResumeDocument(resume, contact));
    const zip = await JSZip.loadAsync(buffer);
    return {
      styles: await zip.file("word/styles.xml").async("string"),
      doc: await zip.file("word/document.xml").async("string")
    };
  }

  test("section headings are explicitly styled, not Word's blue default", async () => {
    const { styles } = await parts(completeResume(THIN_MODEL_RESPONSE, MASTER_PROFILE), MASTER_PROFILE.identity);
    const h2 = styles.match(/<w:style [^>]*w:styleId="Heading2".*?<\/w:style>/s);
    assert.ok(h2, "a Heading2 style must be defined rather than inherited");
    assert.match(h2[0], /w:color w:val="1A1A1A"/, "headings must be near-black, not Word's blue");
    assert.match(h2[0], /<w:b\/>/, "headings must be bold");
    assert.match(h2[0], /<w:caps\/>/, "headings are uppercase");
    assert.match(h2[0], /<w:pBdr>/, "headings carry a rule beneath them");
    assert.doesNotMatch(h2[0], /Calibri Light/, "Word's Heading 2 face must not survive");
  });

  test("the page uses resume margins, not Word's one-inch default", async () => {
    const { doc } = await parts(completeResume(THIN_MODEL_RESPONSE, MASTER_PROFILE), MASTER_PROFILE.identity);
    const pgMar = doc.match(/<w:pgMar[^>]*\/>/);
    assert.ok(pgMar, "page margins must be set");
    const top = Number(pgMar[0].match(/w:top="(\d+)"/)[1]);
    const left = Number(pgMar[0].match(/w:left="(\d+)"/)[1]);
    assert.ok(top < 1440, `top margin ${top} must be tighter than Word's 1440 default`);
    assert.ok(left < 1440, `left margin ${left} must be tighter than Word's 1440 default`);
  });

  test("a body font is declared so the file doesn't inherit whatever Word opens with", async () => {
    const { styles } = await parts(completeResume(THIN_MODEL_RESPONSE, MASTER_PROFILE), MASTER_PROFILE.identity);
    assert.match(styles, /Calibri/);
  });
});

describe("safeFileName — the recruiter sees the candidate's name", () => {
  const { safeFileName } = require("../api/job-resume-docx");

  test("keeps a normal name and adds the extension once", () => {
    assert.equal(safeFileName("Alex Rivera_Resume_2026", "Resume"), "Alex Rivera_Resume_2026.docx");
    assert.equal(safeFileName("Alex Rivera_Resume_2026.docx", "Resume"), "Alex Rivera_Resume_2026.docx");
  });

  test("strips CR/LF so a crafted name can't inject a response header", () => {
    const out = safeFileName("resume\r\nX-Evil: injected", "Resume");
    assert.doesNotMatch(out, /[\r\n]/);
  });

  test("strips characters the filesystem rejects", () => {
    assert.equal(safeFileName('a/b:c*d?e<f>g|h"i', "Resume"), "abcdefghi.docx");
  });

  test("falls back rather than producing a bare extension", () => {
    assert.equal(safeFileName("", "Resume"), "Resume.docx");
    assert.equal(safeFileName("   ", "Resume"), "Resume.docx");
  });
});
