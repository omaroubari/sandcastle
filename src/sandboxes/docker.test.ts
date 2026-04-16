import { describe, expect, it } from "vitest";
import { docker } from "./docker.js";

describe("docker()", () => {
  it("returns a SandboxProvider with tag 'bind-mount' and name 'docker'", () => {
    const provider = docker();
    expect(provider.tag).toBe("bind-mount");
    expect(provider.name).toBe("docker");
  });

  it("accepts an imageName option", () => {
    const provider = docker({ imageName: "my-image:latest" });
    expect(provider.tag).toBe("bind-mount");
    expect(provider.name).toBe("docker");
  });

  it("has a create function", () => {
    const provider = docker();
    expect(typeof provider.create).toBe("function");
  });

  it("does not have a branchStrategy property", () => {
    const provider = docker();
    expect("branchStrategy" in provider).toBe(false);
  });

  it("accepts a mounts option with valid paths", () => {
    const provider = docker({
      mounts: [{ hostPath: "~", sandboxPath: "/mnt/home" }],
    });
    expect(provider.tag).toBe("bind-mount");
  });

  it("throws at construction time if a mount hostPath does not exist", () => {
    expect(() =>
      docker({
        mounts: [
          {
            hostPath: "/nonexistent/path/does/not/exist",
            sandboxPath: "/mnt/cache",
          },
        ],
      }),
    ).toThrow("Mount hostPath does not exist");
  });

  it("expands tilde in mount hostPath at construction time", () => {
    // This succeeds because ~ resolves to the home directory which exists
    const provider = docker({
      mounts: [{ hostPath: "~", sandboxPath: "/mnt/home", readonly: true }],
    });
    expect(provider.tag).toBe("bind-mount");
  });

  it("resolves relative hostPath against process.cwd()", () => {
    // "src" directory exists relative to cwd (the repo root)
    const provider = docker({
      mounts: [{ hostPath: "src", sandboxPath: "/mnt/src" }],
    });
    expect(provider.tag).toBe("bind-mount");
  });

  it("resolves dot-prefixed relative hostPath against process.cwd()", () => {
    const provider = docker({
      mounts: [{ hostPath: "./src", sandboxPath: "/mnt/src" }],
    });
    expect(provider.tag).toBe("bind-mount");
  });

  it("throws for relative hostPath that does not exist", () => {
    expect(() =>
      docker({
        mounts: [{ hostPath: "nonexistent_dir_xyz", sandboxPath: "/mnt/data" }],
      }),
    ).toThrow("Mount hostPath does not exist");
  });

  it("resolves relative sandboxPath against sandbox workspace dir", () => {
    const provider = docker({
      mounts: [{ hostPath: "src", sandboxPath: "data" }],
    });
    expect(provider.tag).toBe("bind-mount");
  });

  it("accepts an env option", () => {
    const provider = docker({ env: { MY_VAR: "hello" } });
    expect(provider.tag).toBe("bind-mount");
    expect(provider.env).toEqual({ MY_VAR: "hello" });
  });

  it("defaults env to empty object when not provided", () => {
    const provider = docker();
    expect(provider.env).toEqual({});
  });

  it("accepts a network option as a string", () => {
    const provider = docker({ network: "my-network" });
    expect(provider.tag).toBe("bind-mount");
  });

  it("accepts a network option as an array", () => {
    const provider = docker({ network: ["net1", "net2"] });
    expect(provider.tag).toBe("bind-mount");
  });
});
