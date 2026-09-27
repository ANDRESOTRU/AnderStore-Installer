import test from "node:test";
import assert from "node:assert/strict";

export function registerAppleErrorTests({ isCertificateLimitError, isAppleRateLimitError, isAnisetteConnectionError, getErrorSuggestions }) {
  const certificate = "● Failed to retrieve certificate identity\n● Developer error 7460: Maximum number of certificates reached";
  const apple429 = "● Failed to get xcode token from Apple account\n● HTTP status client error (429 Too Many Requests) for url (https://gsa.apple.com/grandslam/GsService2)";
  test("Apple certificate limit is recognized without mistaking file paths or unrelated developer errors", () => {
    assert.equal(isCertificateLimitError(certificate), true);
    assert.equal(isCertificateLimitError("C:/build/7460/cert.rs:415\nDeveloper error 1102"), false);
    assert.equal(isCertificateLimitError(apple429), false);
  });
  test("Apple 429 guidance replaces generic advice to repeatedly retry or change accounts", () => {
    assert.equal(isAppleRateLimitError(apple429), true);
    assert.equal(isAppleRateLimitError(apple429.replace("gsa.apple.com", "example.com")), false);
    assert.equal(isAppleRateLimitError(certificate), false);
    const t = (key) => [key];
    for (const type of ["auth", "developer", "misc"]) {
      assert.deepEqual(getErrorSuggestions(t, type, "windows", "anisette.andresot.uk", apple429), ["error.suggestions.apple_rate_limit"]);
      assert.deepEqual(getErrorSuggestions(t, type, "windows", "anisette.andresot.uk", certificate), ["error.suggestions.certificate_limit"]);
    }
  });
  test("anisette transport failures remain distinct from Apple's sign-in rate limit", () => {
    const message = "Failed to get anisette data for login\nerror sending request for url (https://anisette.andresot.uk/v3/get_headers)";
    assert.equal(isAnisetteConnectionError(message), true);
    assert.equal(isAppleRateLimitError(message), false);
    assert.equal(isAnisetteConnectionError(apple429), false);
  });
}
