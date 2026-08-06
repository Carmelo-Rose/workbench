import { afterEach, describe, expect, it } from "vitest";
import { clearedSessionCookie, sessionCookie } from "./tenant";

const originalNodeEnv = process.env.NODE_ENV;
const originalPublicUrl = process.env.WORKBENCH_PUBLIC_URL;

afterEach(() => {
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
  if (originalPublicUrl === undefined) delete process.env.WORKBENCH_PUBLIC_URL;
  else process.env.WORKBENCH_PUBLIC_URL = originalPublicUrl;
});

describe("session cookies", () => {
  it("keeps production HTTP sessions usable on the LAN", () => {
    process.env.NODE_ENV = "production";
    process.env.WORKBENCH_PUBLIC_URL = "http://192.168.1.198:3020";

    expect(sessionCookie("token")).not.toContain("; Secure");
    expect(clearedSessionCookie()).not.toContain("; Secure");
  });

  it("marks production HTTPS sessions as Secure", () => {
    process.env.NODE_ENV = "production";
    process.env.WORKBENCH_PUBLIC_URL = "https://workbench.example.test";

    expect(sessionCookie("token")).toContain("; Secure");
    expect(clearedSessionCookie()).toContain("; Secure");
  });
});
