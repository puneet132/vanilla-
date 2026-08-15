// Tests for api/_crypto.js — the AES-256-GCM envelope protecting every user's
// provider API key at rest. If this breaks silently, keys either stop decrypting
// (everyone has to re-add them) or, far worse, decrypt under the wrong owner.

const { test, describe } = require("node:test");
const assert = require("node:assert");

// Must be set before the module reads it.
process.env.ENCRYPTION_KEY = "a".repeat(64);
const { encrypt, decrypt } = require("../api/_crypto");

const AAD = "uid123_gemini";

describe("_crypto", () => {
  test("round-trips a value with matching associated data", () => {
    const secret = "AIzaSy-not-a-real-key-0123456789";
    const box = encrypt(secret, AAD);
    assert.strictEqual(decrypt(box, AAD), secret);
  });

  test("returns iv, ciphertext and tag as base64 strings", () => {
    const box = encrypt("hello", AAD);
    for (const field of ["iv", "ciphertext", "tag"]) {
      assert.strictEqual(typeof box[field], "string", `${field} should be a string`);
      assert.ok(box[field].length > 0, `${field} should not be empty`);
    }
    // 12-byte IV -> 16 base64 chars
    assert.strictEqual(Buffer.from(box.iv, "base64").length, 12);
    assert.strictEqual(Buffer.from(box.tag, "base64").length, 16);
  });

  test("never stores the plaintext in the ciphertext", () => {
    const secret = "super-secret-value";
    const box = encrypt(secret, AAD);
    assert.ok(!Buffer.from(box.ciphertext, "base64").toString("utf8").includes(secret));
  });

  test("uses a fresh IV each time, so identical inputs differ", () => {
    const a = encrypt("same", AAD);
    const b = encrypt("same", AAD);
    assert.notStrictEqual(a.iv, b.iv);
    assert.notStrictEqual(a.ciphertext, b.ciphertext);
  });

  // This is the property that stops a ciphertext blob copied onto a different
  // Firestore document from decrypting under the wrong account.
  test("refuses to decrypt under different associated data", () => {
    const box = encrypt("mine", "uid_AAA_gemini");
    assert.throws(() => decrypt(box, "uid_BBB_gemini"));
  });

  test("refuses to decrypt when the auth tag is tampered with", () => {
    const box = encrypt("mine", AAD);
    const tag = Buffer.from(box.tag, "base64");
    tag[0] ^= 0xff;
    assert.throws(() => decrypt({ ...box, tag: tag.toString("base64") }, AAD));
  });

  test("refuses to decrypt when the ciphertext is tampered with", () => {
    const box = encrypt("mine", AAD);
    const ct = Buffer.from(box.ciphertext, "base64");
    ct[0] ^= 0xff;
    assert.throws(() => decrypt({ ...box, ciphertext: ct.toString("base64") }, AAD));
  });

  test("rejects a malformed ENCRYPTION_KEY rather than encrypting weakly", () => {
    const good = process.env.ENCRYPTION_KEY;
    for (const bad of ["", "tooshort", "b".repeat(63), "c".repeat(65)]) {
      process.env.ENCRYPTION_KEY = bad;
      assert.throws(() => encrypt("x", AAD), /64-char hex/, `should reject key of length ${bad.length}`);
    }
    process.env.ENCRYPTION_KEY = good;
  });

  test("handles unicode and long values", () => {
    const secret = "ключ-🔑-" + "x".repeat(4000);
    assert.strictEqual(decrypt(encrypt(secret, AAD), AAD), secret);
  });
});
