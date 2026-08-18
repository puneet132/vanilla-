// Guarantees the tailored resume actually contains the user's work history.
//
// Why this exists: the generate schema left every field of `resume` optional,
// so models routinely returned a title line, a summary and a skills list and
// stopped there. That produced a .docx with a name, a summary and nothing a
// recruiter would recognise as a resume — the file "opened empty". Tightening
// the schema makes that far less likely; this makes it impossible.
//
// Nothing here invents anything. Every value it fills in is copied from the
// user's own master profile, which is the same source of truth the model was
// given. Reordering and rephrasing stay the model's job; keeping the jobs on
// the page is ours.

// The master profile stores bullets under `achievements`; the .docx builder
// reads `bullets`. Translating here means neither side has to know about the
// other's vocabulary.
function masterRoleToResumeRole(role) {
  return {
    title: role.title || "",
    company: role.company || "",
    location: role.location || "",
    dates: role.dates || "",
    bullets: (role.achievements || []).filter(b => String(b).trim())
  };
}

function roleKey(role) {
  return `${String(role.company || "").trim().toLowerCase()}|${String(role.title || "").trim().toLowerCase()}`;
}

// Match on company+title first, then company alone — a model that retitles a
// role to match the JD's language is doing its job, and shouldn't cause the
// role's bullets to be treated as a different job.
function findMasterRole(role, masterRoles) {
  const key = roleKey(role);
  const exact = masterRoles.find(m => roleKey(m) === key);
  if (exact) return exact;
  const company = String(role.company || "").trim().toLowerCase();
  if (!company) return null;
  return masterRoles.find(m => String(m.company || "").trim().toLowerCase() === company) || null;
}

function completeResume(generated, profile) {
  const master = (profile && profile.resume) || {};
  const masterRoles = Array.isArray(master.experience) ? master.experience : [];
  const out = { ...(generated || {}) };

  const genRoles = Array.isArray(out.experience) ? out.experience : [];

  if (!genRoles.length) {
    out.experience = masterRoles.map(masterRoleToResumeRole);
  } else {
    const used = new Set();
    const kept = genRoles.map(role => {
      const match = findMasterRole(role, masterRoles);
      if (match) used.add(roleKey(match));
      const bullets = (role.bullets || []).filter(b => String(b).trim());
      return {
        title: role.title || match?.title || "",
        company: role.company || match?.company || "",
        // Location and dates are facts the model has no reason to restate and
        // frequently drops; a resume without dates reads as evasive.
        location: role.location || match?.location || "",
        dates: role.dates || match?.dates || "",
        bullets: bullets.length ? bullets : (match ? masterRoleToResumeRole(match).bullets : [])
      };
    });
    // Anything the model left out entirely goes back on the end. A tailored
    // resume may reorder and de-emphasise, but a dropped job is an unexplained
    // employment gap, which costs the user more than the tailoring gains.
    const dropped = masterRoles.filter(m => !used.has(roleKey(m))).map(masterRoleToResumeRole);
    out.experience = kept.concat(dropped);
  }

  if (!Array.isArray(out.education) || !out.education.length) {
    out.education = Array.isArray(master.education) ? master.education.slice() : [];
  }
  if (!Array.isArray(out.skills) || !out.skills.length) {
    out.skills = Array.isArray(master.skills) ? master.skills.slice() : [];
  }
  if (!Array.isArray(out.projects) || !out.projects.length) {
    out.projects = Array.isArray(master.projects) ? master.projects.slice() : [];
  }

  return out;
}

// The last line of defence before a file reaches the user. A document with a
// name and nothing else is worse than an honest error, because the user only
// finds out after they've attached it to an application.
function resumeIsSubstantive(resume) {
  if (!resume || typeof resume !== "object") return false;
  const hasText = v => typeof v === "string" && v.trim().length > 0;
  const hasRows = v => Array.isArray(v) && v.length > 0;

  if (hasRows(resume.experience)) return true;
  if (hasRows(resume.education)) return true;
  if (hasRows(resume.projects)) return true;
  if (hasRows(resume.bullet_sections)) return true;
  if (hasText(resume.summary) && hasRows(resume.skills)) return true;
  return false;
}

module.exports = { completeResume, resumeIsSubstantive, masterRoleToResumeRole };
