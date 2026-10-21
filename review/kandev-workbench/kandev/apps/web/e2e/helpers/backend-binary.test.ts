import path from "node:path";
import { describe, expect, it } from "vitest";
import { backendBinaryPath } from "./backend-binary";

describe("原生 E2E 宿主二进制", () => {
  it("Windows 使用 Make 实际产出的 exe，不绕过新鲜度检查", () => {
    expect(backendBinaryPath("checkout", "kandev", "win32")).toBe(
      path.join("checkout", "bin", "kandev.exe"),
    );
    expect(backendBinaryPath("checkout", "mock-agent", "win32")).toBe(
      path.join("checkout", "bin", "mock-agent.exe"),
    );
  });
  it("其他平台继续使用原生无后缀名称", () => {
    expect(backendBinaryPath("checkout", "kandev", "linux")).toBe(
      path.join("checkout", "bin", "kandev"),
    );
  });
});
