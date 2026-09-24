import { describe, expect, it } from "vitest";
import {
  findCardNumbers,
  findSecrets,
  findSsns,
  HIDDEN_VALUE,
  isCardNumber,
  looksLikeSecret,
  luhnValid,
  maskSensitiveText,
  redactSensitiveInput,
} from "./sensitive";

// Public test numbers published by card networks and payment processors (not real cards).
const VISA = "4111111111111111";
const MASTERCARD = "5555555555554444";
const AMEX = "378282246310005";

describe("luhnValid", () => {
  it.each([VISA, MASTERCARD, AMEX, "4242424242424242", "79927398713"])("accepts %s", (n) => {
    expect(luhnValid(n)).toBe(true);
  });

  it.each(["4111111111111112", "1234567812345678", "79927398710", "abc", ""])("rejects %s", (n) => {
    expect(luhnValid(n)).toBe(false);
  });
});

describe("isCardNumber", () => {
  it("requires a known issuer prefix, a card length and a Luhn checksum", () => {
    expect(isCardNumber(VISA)).toBe(true);
    expect(isCardNumber(AMEX)).toBe(true);
    expect(isCardNumber("79927398713")).toBe(false); // Luhn-valid but too short
    expect(isCardNumber("1790000000006")).toBe(false); // epoch-ms-like, no issuer
    expect(isCardNumber("0000000000000000")).toBe(false);
  });
});

describe("findCardNumbers", () => {
  it("finds card numbers written with spaces or dashes", () => {
    expect(findCardNumbers("card: 4111 1111 1111 1111, exp 12/29")).toHaveLength(1);
    expect(findCardNumbers("5555-5555-5555-4444")).toHaveLength(1);
    expect(findCardNumbers(`amex ${AMEX}`)).toHaveLength(1);
  });

  it("ignores digit runs that are not cards", () => {
    expect(findCardNumbers("order 4111111111111112 shipped")).toEqual([]);
    expect(findCardNumbers("timestamp 1790000000006")).toEqual([]);
    expect(findCardNumbers("call +1 555 010 0199")).toEqual([]);
    expect(findCardNumbers(`${VISA}9`)).toEqual([]);
  });
});

describe("findSsns", () => {
  it("finds dashed SSNs and skips invalid area numbers", () => {
    expect(findSsns("SSN 123-45-6789")).toHaveLength(1);
    expect(findSsns("000-12-3456 or 666-12-3456")).toEqual([]);
    expect(findSsns("phone 555-010-1234")).toEqual([]);
  });
});

describe("secret detection", () => {
  const github = `ghp_${"a1B2".repeat(9)}`;
  const openrouter = `sk-or-v1-${"0123456789abcdef".repeat(4)}`;

  it("recognizes common token formats", () => {
    expect(findSecrets(`token=${github}`)[0]?.label).toBe("GitHub token");
    expect(findSecrets(openrouter)[0]?.label).toBe("API key");
    expect(findSecrets("https://user:hunter22@db.example.com/x")[0]?.label).toBe("URL credentials");
    expect(findSecrets("just some words")).toEqual([]);
  });

  it("flags long high-entropy single tokens but not prose, URLs or ids", () => {
    expect(looksLikeSecret("Xk29vLq8Zr0Tb7Wn4Yp1Hs6Jd3Fg5Mc2")).toBe(true);
    expect(looksLikeSecret(github)).toBe(true);
    expect(looksLikeSecret("flights from SFO to JFK next week")).toBe(false);
    expect(looksLikeSecret("https://example.com/a/very/long/path/here")).toBe(false);
    expect(looksLikeSecret("123e4567-e89b-12d3-a456-426614174000")).toBe(false);
    expect(looksLikeSecret("hunter2")).toBe(false);
  });
});

describe("masking", () => {
  it("masks cards (keeping the last four), secrets and SSNs in free text", () => {
    const masked = maskSensitiveText(
      `pay with ${VISA}, ssn 123-45-6789, key sk-or-v1-${"ab".repeat(24)}`,
    );
    expect(masked).toContain("•••• 1111");
    expect(masked).toContain("•••-••-••••");
    expect(masked).toContain("[hidden API key]");
    expect(masked).not.toContain(VISA);
    expect(masked).not.toContain("123-45-6789");
  });

  it("redacts sensitive keys and hidden fields in nested inputs", () => {
    const input = {
      element: "Password",
      text: "correct horse battery staple",
      nested: { password: "hunter2", apiKey: "k", cvv: 123, note: `card ${VISA}` },
      list: [{ token: "abc" }],
    };
    const redacted = redactSensitiveInput(input, { hideKeys: new Set(["text"]) }) as typeof input;
    expect(redacted.text).toBe(HIDDEN_VALUE);
    expect(redacted.element).toBe("Password");
    expect(redacted.nested.password).toBe(HIDDEN_VALUE);
    expect(redacted.nested.apiKey).toBe(HIDDEN_VALUE);
    expect(redacted.nested.cvv).toBe(HIDDEN_VALUE);
    expect(redacted.nested.note).toBe("card •••• 1111");
    expect(redacted.list[0]!.token).toBe(HIDDEN_VALUE);
    expect(input.text).toBe("correct horse battery staple");
  });

  it("truncates very long strings", () => {
    const redacted = redactSensitiveInput({ body: "x".repeat(50) }, { maxStringLength: 10 }) as {
      body: string;
    };
    expect(redacted.body).toBe(`${"x".repeat(10)}… (truncated)`);
  });
});
