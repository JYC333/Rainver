import { describe, expect, it } from "vitest";
import { isBlockedAddress, isLoopbackAddress } from "../src/blockList.js";

describe("isBlockedAddress", () => {
  it("blocks this instance's own IPv4 networks", () => {
    for (const address of [
      "0.0.0.0", "10.0.0.5", "127.0.0.1", "169.254.169.254", "172.17.0.2",
      "192.168.1.1", "100.64.0.1", "198.18.0.1", "192.0.0.1", "224.0.0.1", "255.255.255.255",
    ]) {
      expect(isBlockedAddress(address), address).toBe(true);
    }
  });

  it("blocks every IPv6 spelling that reaches an IPv4 destination", () => {
    for (const address of [
      "::1", "::", "fd00::1", "fe80::1", "fd00:ec2::254",
      // IPv4-mapped and IPv4-compatible.
      "::ffff:10.0.0.5", "::ffff:127.0.0.1", "::7f00:1",
      // NAT64 (well-known and local-use prefixes), 6to4, Teredo.
      "64:ff9b::7f00:1", "64:ff9b:1:ffff::1", "2002:7f00:1::", "2001:0:4136:e378:8000:63bf:3fff:fdd2",
      // Site-local (deprecated) and multicast.
      "fec0::1", "ff02::1",
    ]) {
      expect(isBlockedAddress(address), address).toBe(true);
    }
  });

  it("allows ordinary public addresses", () => {
    // `::ffff:8.8.8.8` among them: IPv4-mapped is judged by the IPv4 rules, so
    // a mapped *public* address stays allowed.
    for (const address of ["93.184.216.34", "8.8.8.8", "::ffff:8.8.8.8", "2606:4700::1111", "2001:4860:4860::8888"]) {
      expect(isBlockedAddress(address), address).toBe(false);
    }
  });

  it("fails closed on anything it cannot parse as an address", () => {
    for (const value of ["", "localhost", "127.0.0.1:80", null, undefined]) {
      expect(isBlockedAddress(value as string | null | undefined), String(value)).toBe(true);
    }
  });
});

describe("isLoopbackAddress", () => {
  it("accepts every spelling of this machine", () => {
    for (const address of ["127.0.0.1", "127.0.0.53", "127.255.255.254", "::1", "0:0:0:0:0:0:0:1", "::ffff:127.0.0.1"]) {
      expect(isLoopbackAddress(address), address).toBe(true);
    }
  });

  it("accepts the short forms getaddrinfo resolves to 127.0.0.1", () => {
    // Not addresses `isIP` accepts, but `http://127.1/` reaches loopback and is
    // what somebody types.
    for (const address of ["127.1", "127.0.1"]) {
      expect(isLoopbackAddress(address), address).toBe(true);
    }
  });

  it("refuses a hostname that merely starts with 127.", () => {
    // The defect this replaced: `startsWith("127.")` was true of a domain
    // somebody else controls and can point anywhere, which is exactly what
    // plain HTTP must not be allowed for.
    for (const value of ["127.evil.com", "127.0.0.1.evil.com", "localhost", "1270.0.0.1", "", null, undefined]) {
      expect(isLoopbackAddress(value as string | null | undefined), String(value)).toBe(false);
    }
  });

  it("refuses addresses that are private but not this machine", () => {
    for (const address of ["10.0.0.1", "192.168.1.1", "169.254.169.254", "fd00::1", "8.8.8.8"]) {
      expect(isLoopbackAddress(address), address).toBe(false);
    }
  });
});
