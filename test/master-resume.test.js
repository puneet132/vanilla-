const test = require("node:test");
const assert = require("node:assert");

// master-resume.mjs is an ES module (the browser and Node both need to read it
// as one), so it's pulled in with a dynamic import from this CommonJS test file.
let mr;
test.before(async () => { mr = await import("../master-resume.mjs"); });

const SAMPLE = {
  experience_years: 4,
  domains: ["insurance"],
  headline_options: ["Business Analyst", "Web Project Manager"],
  skills: ["JIRA", "SQL", ""],
  experience: [
    {
      title: "Business Analyst",
      company: "Axis Max Life",
      location: "Gurugram",
      dates: "Mar 2022 – Present",
      achievements: ["Cut release defects by 40%", "Ran discovery for 3 squads"]
    },
    {
      title: "Associate BA",
      company: "Earlier Co",
      dates: "2020 – 2022",
      achievements: ["Owned the reporting backlog"]
    }
  ],
  education: [{ degree: "B.Tech", school: "Some University", dates: "2016 – 2020" }],
  projects: [{ name: "Vanilla", description: "Job application PWA" }]
};

test("the bullets survive the trip — the whole reason this module exists", async (t) => {
  await t.test("achievements become bullets, which is what the .docx builder reads", () => {
    const out = mr.masterResumeToDocxShape(SAMPLE);
    assert.deepStrictEqual(out.experience[0].bullets, [
      "Cut release defects by 40%",
      "Ran discovery for 3 squads"
    ]);
  });

  await t.test("no role is silently emptied", () => {
    const out = mr.masterResumeToDocxShape(SAMPLE);
    for (const job of out.experience) {
      assert.ok(job.bullets.length > 0, `${job.company} lost its bullets`);
    }
  });

  await t.test("every role is carried across — a dropped job reads as an employment gap", () => {
    const out = mr.masterResumeToDocxShape(SAMPLE);
    assert.strictEqual(out.experience.length, SAMPLE.experience.length);
    assert.strictEqual(out.experience[1].company, "Earlier Co");
  });

  await t.test("`achievements` is not left behind on the mapped role", () => {
    const out = mr.masterResumeToDocxShape(SAMPLE);
    assert.strictEqual(out.experience[0].achievements, undefined);
  });
});

test("it renames and drops — it never invents", async (t) => {
  await t.test("the title line is the user's own held title, not a generated one", () => {
    const out = mr.masterResumeToDocxShape(SAMPLE);
    assert.strictEqual(out.title_line, "Business Analyst");
  });

  await t.test("no summary is fabricated — the master resume has no summary to carry", () => {
    const out = mr.masterResumeToDocxShape(SAMPLE);
    assert.ok(!out.summary, "a summary appeared that the user never wrote");
  });

  await t.test("an empty master produces an empty document, not invented content", () => {
    const out = mr.masterResumeToDocxShape({});
    assert.deepStrictEqual(out.experience, []);
    assert.deepStrictEqual(out.education, []);
    assert.strictEqual(out.title_line, "");
  });

  await t.test("blank skills are dropped rather than rendered as gaps", () => {
    const out = mr.masterResumeToDocxShape(SAMPLE);
    assert.deepStrictEqual(out.skills, ["JIRA", "SQL"]);
  });
});

test("it survives whatever the profile editor allows", async (t) => {
  await t.test("null and undefined don't throw", () => {
    assert.doesNotThrow(() => mr.masterResumeToDocxShape(null));
    assert.doesNotThrow(() => mr.masterResumeToDocxShape(undefined));
  });

  await t.test("a role missing its achievements array yields no bullets, not a crash", () => {
    const out = mr.masterResumeToDocxShape({ experience: [{ title: "X", company: "Y", dates: "2020" }] });
    assert.deepStrictEqual(out.experience[0].bullets, []);
  });

  await t.test("non-array fields are treated as absent", () => {
    const out = mr.masterResumeToDocxShape({ skills: "JIRA, SQL", experience: null });
    assert.deepStrictEqual(out.skills, []);
    assert.deepStrictEqual(out.experience, []);
  });
});

test("masterResumeIsAttachable — don't offer to attach a blank file", async (t) => {
  await t.test("a real resume is attachable", () => {
    assert.strictEqual(mr.masterResumeIsAttachable(SAMPLE), true);
  });

  await t.test("an empty profile is not", () => {
    assert.strictEqual(mr.masterResumeIsAttachable({}), false);
    assert.strictEqual(mr.masterResumeIsAttachable(null), false);
  });

  await t.test("education alone still counts — early-career resumes are real", () => {
    const out = mr.masterResumeIsAttachable({ education: [{ degree: "B.Tech", school: "Some University" }] });
    assert.strictEqual(out, true);
  });

  await t.test("headline and skills alone are not a resume", () => {
    assert.strictEqual(
      mr.masterResumeIsAttachable({ headline_options: ["Business Analyst"], skills: ["SQL"] }),
      false
    );
  });
});
