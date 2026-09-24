import { describe, expect, it } from "vitest";
import { toLocalPhone, toPhoneSearchTerm } from "./formatPhone";

describe("toLocalPhone", () => {
  it("converts canonical 972 mobile to 05X", () => {
    expect(toLocalPhone("972538888872")).toBe("0538888872");
  });
  it("handles a leading +", () => {
    expect(toLocalPhone("+972538888872")).toBe("0538888872");
  });
  it("leaves non-Israeli / malformed numbers untouched", () => {
    expect(toLocalPhone("14155550100")).toBe("14155550100");
    expect(toLocalPhone("9725")).toBe("9725");
  });
  it("tolerates null", () => {
    expect(toLocalPhone(null)).toBe("");
  });
});

describe("toPhoneSearchTerm", () => {
  it("maps a local-zero prefix to 972", () => {
    expect(toPhoneSearchTerm("0538")).toBe("972538");
  });
  it("passes names and non-zero digits through", () => {
    expect(toPhoneSearchTerm("אורן")).toBe("אורן");
    expect(toPhoneSearchTerm("538888")).toBe("538888");
  });
});
