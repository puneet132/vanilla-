// The bug these cover: a tailored resume that downloaded as a blank-looking
// .docx. The builder was fine — the model had returned a `resume` with a
// summary and skills but no work history, because the generate schema made
// every part of `resume` optional. A resume with no jobs on it is not a resume.
const { test, describe } = require("node:test");
const assert = require("node:assert");

const { completeResume, resumeIsSubstantive } = require("../api/_resume");

const MASTER = {
  resume: {
    experience: [
      {
        title: "Business Analyst",
        company: "Northwind Insurance",
        location: "Bristol",
        dates: "Mar 2022 – present",
        achievements: ["Cut policy issuance turnaround from 6 days to 2.", "Mapped the underwriting journey end to end."]
      },
      {
        title: "Associate Analyst",
        company: "Helio Systems",
        location: "Pune",
        dates: "Jul 2019 – Feb 2022",
        achievements: ["Automated a reconciliation report that took 3 days a month."]
      }
    ],
    education: [{ degree: "B.Tech, Computer Science", school: "Riverside University", dates: "2014 – 2018" }],
    skills: ["Requirement gathering", "SQL", "Process mapping"]
  }
};

describe("completeResume — the work history always survives", () => {
  test("a model that returned no experience gets the full master history", () => {
    const out = completeResume({ summary: "Analyst.", skills: ["SQL"] }, MASTER);
    assert.equal(out.experience.length, 2);
    assert.equal(out.experience[0].company, "Northwind Insurance");
    // achievements is the master's key; the .docx builder reads `bullets`.
    assert.deepEqual(out.experience[0].bullets, [
      "Cut policy issuance turnaround from 6 days to 2.",
      "Mapped the underwriting journey end to end."
    ]);
    assert.equal(out.experience[1].dates, "Jul 2019 – Feb 2022");
  });

  test("a role the model returned with no bullets is backfilled from the master", () => {
    const out = completeResume({
      experience: [{ title: "Business Analyst", company: "Northwind Insurance", dates: "Mar 2022 – present" }]
    }, MASTER);
    assert.deepEqual(out.experience[0].bullets, [
      "Cut policy issuance turnaround from 6 days to 2.",
      "Mapped the underwriting journey end to end."
    ]);
  });

  test("the model's own tailored bullets are kept, not overwritten", () => {
    const tailored = ["Rewrote the issuance flow against the JD's SLA language."];
    const out = completeResume({
      experience: [{ title: "Business Analyst", company: "Northwind Insurance", dates: "Mar 2022 – present", bullets: tailored }]
    }, MASTER);
    assert.deepEqual(out.experience[0].bullets, tailored);
  });

  test("a job the model silently dropped is restored — resumes must not grow gaps", () => {
    const out = completeResume({
      experience: [{ title: "Business Analyst", company: "Northwind Insurance", dates: "Mar 2022 – present", bullets: ["x"] }]
    }, MASTER);
    assert.equal(out.experience.length, 2, "the Helio Systems role must come back");
    assert.equal(out.experience[1].company, "Helio Systems");
  });

  test("the model's ordering is respected for the roles it did return", () => {
    const out = completeResume({
      experience: [
        { title: "Associate Analyst", company: "Helio Systems", dates: "Jul 2019 – Feb 2022", bullets: ["a"] },
        { title: "Business Analyst", company: "Northwind Insurance", dates: "Mar 2022 – present", bullets: ["b"] }
      ]
    }, MASTER);
    assert.equal(out.experience[0].company, "Helio Systems");
    assert.equal(out.experience[1].company, "Northwind Insurance");
  });

  test("missing education and skills fall back to the master copy", () => {
    const out = completeResume({ summary: "Analyst." }, MASTER);
    assert.equal(out.education[0].school, "Riverside University");
    assert.deepEqual(out.skills, ["Requirement gathering", "SQL", "Process mapping"]);
  });

  test("nothing is invented when the master copy is empty", () => {
    const out = completeResume({ summary: "Analyst." }, { resume: {} });
    assert.deepEqual(out.experience, []);
    assert.deepEqual(out.education, []);
  });

  test("a null resume from the model still yields the master history", () => {
    const out = completeResume(null, MASTER);
    assert.equal(out.experience.length, 2);
  });
});

describe("resumeIsSubstantive — never hand over a blank file", () => {
  test("a resume with work history is substantive", () => {
    assert.equal(resumeIsSubstantive({ experience: [{ title: "BA", company: "X", bullets: ["y"] }] }), true);
  });

  test("summary plus skills alone is substantive", () => {
    assert.equal(resumeIsSubstantive({ summary: "Analyst.", skills: ["SQL"] }), true);
  });

  test("an empty object is not", () => {
    assert.equal(resumeIsSubstantive({}), false);
  });

  test("null is not", () => {
    assert.equal(resumeIsSubstantive(null), false);
  });

  test("empty arrays and blank strings are not", () => {
    assert.equal(resumeIsSubstantive({ summary: "   ", skills: [], experience: [], education: [] }), false);
  });

  test("education alone still counts — early-career resumes are real", () => {
    assert.equal(resumeIsSubstantive({ education: [{ degree: "B.Tech", school: "Riverside University" }] }), true);
  });
});
