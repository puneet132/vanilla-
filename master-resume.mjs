// Maps the master resume onto the shape the .docx builder reads.
//
// These two shapes are close enough to look interchangeable and are not. The
// master resume — what the upload parser writes and what the user edits — keeps
// each role's bullets under `achievements`. The .docx builder reads `bullets`.
// Handing it the master resume unmapped produces a document listing every job
// title and company with nothing underneath: no error, no empty-document guard
// tripped, just a resume that quietly lost its content on the way to a recruiter.
//
// .mjs so the browser and Node both read it as an ES module: the repo has no
// build step and package.json has no "type": "module", so a plain .js file
// would be CommonJS to Node and break the tests.

const arr = (v) => (Array.isArray(v) ? v : []);
const str = (v) => (typeof v === "string" ? v.trim() : "");

/**
 * Master resume -> the resume object /api/job-resume-docx expects.
 *
 * Deterministic and lossless in one direction only: it renames and drops, it
 * never adds. There is no summary here because the master resume has no summary
 * field, and writing one would mean inventing a claim the user never made —
 * the same rule the generation prompt is held to.
 */
export function masterResumeToDocxShape(master) {
  const m = master && typeof master === "object" ? master : {};

  return {
    // The user's own held title, not a generated one.
    title_line: str(arr(m.headline_options)[0]),

    skills: arr(m.skills).map(str).filter(Boolean),

    experience: arr(m.experience).map((job) => {
      const j = job && typeof job === "object" ? job : {};
      return {
        title: str(j.title),
        company: str(j.company),
        location: str(j.location),
        dates: str(j.dates),
        // The rename this whole module exists for.
        bullets: arr(j.achievements).map(str).filter(Boolean)
      };
    }),

    education: arr(m.education).map((e) => {
      const ed = e && typeof e === "object" ? e : {};
      return { degree: str(ed.degree), school: str(ed.school), dates: str(ed.dates) };
    }),

    projects: arr(m.projects).map((p) => {
      const pr = p && typeof p === "object" ? p : {};
      return { name: str(pr.name), description: str(pr.description) };
    })
  };
}

/** True when the mapped master resume carries enough to be worth attaching. */
export function masterResumeIsAttachable(master) {
  const r = masterResumeToDocxShape(master);
  const hasExperience = r.experience.some((j) => j.title || j.company || j.bullets.length);
  return hasExperience || r.education.length > 0;
}
