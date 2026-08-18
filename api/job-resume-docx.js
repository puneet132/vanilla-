// Vercel serverless function — builds an ATS-safe .docx from tailored resume content.
// No tables for layout, no text boxes, no images: just headings and paragraphs so
// applicant tracking systems parse it cleanly.
const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, BorderStyle, convertInchesToTwip } = require("docx");
const { verifyIdToken } = require("./_firebaseAdmin");
const { resumeIsSubstantive } = require("./_resume");

function textParagraph(text, opts = {}) {
  return new Paragraph({ spacing: { after: 100 }, ...opts, children: [new TextRun({ text, ...opts.run })] });
}

function bulletParagraph(text) {
  return new Paragraph({
    text,
    bullet: { level: 0 },
    spacing: { after: 60 },
    // Without an explicit indent the bullet glyph and the wrapped second line
    // fight each other; this keeps wrapped text aligned under the first word.
    indent: { left: 260, hanging: 200 }
  });
}

// The client picks the filename (it knows the user's name); this decides what
// is safe to echo into a Content-Disposition header. Strips CR/LF and quotes so
// a crafted name can't inject headers, plus the characters Windows and macOS
// reject in a filename so the download doesn't silently fail on save.
function safeFileName(raw, fallback) {
  const cleaned = String(raw || "")
    .replace(/[\r\n"\\]/g, "")
    .replace(/[/:*?<>|]/g, "")
    .replace(/\.docx$/i, "")
    .trim()
    .slice(0, 120)
    .trim();
  return (cleaned || fallback) + ".docx";
}

// HEADING_2 is kept because it gives the document real structure, which is what
// ATS parsers walk. Its *appearance* is overridden in the style sheet below —
// left alone, Word renders its built-in Heading 2 as blue Calibri Light, which
// is what made the generated resume look nothing like a resume.
function heading(text) {
  return new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun(text)] });
}

// One place for every measurement, so the document reads as a designed page
// rather than a stack of defaults.
const FONT = "Calibri";
const INK = "1A1A1A";
const MUTED = "595959";

const DOC_STYLES = {
  default: {
    document: {
      run: { font: FONT, size: 21, color: INK },          // 10.5pt body
      paragraph: { spacing: { line: 264, after: 0 } }      // ~1.1 line spacing
    },
    // Section headings: small, bold, uppercase, with a hairline rule under
    // them. Black, not Word's blue.
    heading2: {
      run: { font: FONT, size: 22, bold: true, color: INK, allCaps: true },
      paragraph: {
        spacing: { before: 260, after: 120 },
        border: { bottom: { color: "BFBFBF", style: BorderStyle.SINGLE, size: 6, space: 3 } }
      }
    }
  }
};

const PAGE = {
  margin: {
    top: convertInchesToTwip(0.5),
    bottom: convertInchesToTwip(0.5),
    left: convertInchesToTwip(0.65),
    right: convertInchesToTwip(0.65)
  }
};

// Exported so the decision about what lands in the file can be tested without
// standing up a request. The bug this guards against — a resume that opened
// with no work history in it — was invisible from the handler's perspective.
function buildResumeDocument(resume, contact) {
  const children = [];
  resume = resume || {};

  children.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 40 },
    // No hardcoded fallback name: this used to default to the original
    // author's name, so any other account with a blank profile name got a
    // resume with a stranger's name on it.
    children: [new TextRun({ text: contact?.name || "", bold: true, size: 40, color: INK, characterSpacing: 12 })]
  }));

  if (resume.title_line) {
    children.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 80 },
      children: [new TextRun({ text: resume.title_line, size: 21, color: MUTED })]
    }));
  }

  const contactLine = [contact?.location, contact?.phone, contact?.email, contact?.linkedin].filter(Boolean).join(" · ");
  if (contactLine) {
    children.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 200 },
      children: [new TextRun({ text: contactLine, size: 19, color: MUTED })]
    }));
  }

  if (resume.summary) {
    children.push(heading("Summary"));
    children.push(textParagraph(resume.summary));
  }

  if (Array.isArray(resume.skills) && resume.skills.length) {
    children.push(heading("Skills"));
    children.push(textParagraph(resume.skills.join(" · ")));
  }

  if (Array.isArray(resume.bullet_sections) && resume.bullet_sections.length) {
    for (const section of resume.bullet_sections) {
      if (!section.header) continue;
      children.push(heading(section.header));
      for (const b of section.bullets || []) children.push(bulletParagraph(b));
    }
  }

  if (Array.isArray(resume.experience) && resume.experience.length) {
    children.push(heading("Experience"));
    for (const job of resume.experience) {
      const titleLine = [job.title, job.company].filter(Boolean).join(" — ");
      const metaLine = [job.location, job.dates].filter(Boolean).join(" · ");
      children.push(new Paragraph({
        spacing: { before: 200, after: 0 },
        children: [new TextRun({ text: titleLine, bold: true, size: 22 })]
      }));
      if (metaLine) children.push(new Paragraph({ spacing: { after: 80 }, children: [new TextRun({ text: metaLine, italics: true, size: 19, color: MUTED })] }));
      for (const b of job.bullets || []) children.push(bulletParagraph(b));
    }
  }

  if (Array.isArray(resume.projects) && resume.projects.length) {
    children.push(heading("Projects"));
    for (const p of resume.projects) {
      children.push(new Paragraph({ spacing: { before: 160, after: 0 }, children: [new TextRun({ text: p.name, bold: true, size: 22 })] }));
      if (p.description) children.push(textParagraph(p.description));
    }
  }

  if (Array.isArray(resume.education) && resume.education.length) {
    children.push(heading("Education"));
    for (const e of resume.education) {
      children.push(textParagraph([e.degree, e.school, e.dates].filter(Boolean).join(" — ")));
    }
  }

  return new Document({
    styles: DOC_STYLES,
    sections: [{ properties: { page: PAGE }, children }]
  });
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  try {
    await verifyIdToken((req.body || {}).idToken);
  } catch (e) {
    return res.status(401).json({ error: "please sign in again" });
  }

  const { resume, contact } = req.body || {};
  if (!resume) return res.status(400).json({ error: "missing resume" });

  // Refuse to produce a document with nothing in it. This used to sail
  // straight through: a resume object carrying only a summary built a .docx
  // the user discovered was blank only after attaching it to an application.
  // An error they can act on beats a file they can't.
  if (!resumeIsSubstantive(resume)) {
    return res.status(422).json({
      error: "The AI returned no resume content to put in the file. Try generating again, or pick a different model in the dropdown.",
      code: "empty_resume"
    });
  }
  if (!String(contact?.name || "").trim()) {
    return res.status(422).json({
      error: "Your profile has no name on it, and a resume needs one. Add it in Profile → Identity.",
      code: "missing_name"
    });
  }

  try {
    const buffer = await Packer.toBuffer(buildResumeDocument(resume, contact));
    const fileName = safeFileName(req.body.fileName || req.body.fileNameHint, "Resume");
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    return res.status(200).send(buffer);
  } catch (err) {
    return res.status(500).json({ error: "docx build failed", detail: String(err) });
  }
};

module.exports.buildResumeDocument = buildResumeDocument;
module.exports.safeFileName = safeFileName;
