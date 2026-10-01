import { describe, expect, it } from "vitest";
import { normaliseBaseUrl } from "../src/config";

describe("normaliseBaseUrl", () => {
  it("adds https:// to a bare domain (the value that broke every ad link)", () => {
    expect(normaliseBaseUrl("cuepoint-production.up.railway.app")).toBe("https://cuepoint-production.up.railway.app");
  });
  it("keeps a scheme, and drops trailing slashes and spaces", () => {
    expect(normaliseBaseUrl(" https://api.example.com// ")).toBe("https://api.example.com");
    expect(normaliseBaseUrl("http://localhost:4000")).toBe("http://localhost:4000");
  });
  it("uses http:// for localhost without a scheme", () => {
    expect(normaliseBaseUrl("localhost:4000")).toBe("http://localhost:4000");
  });
});
