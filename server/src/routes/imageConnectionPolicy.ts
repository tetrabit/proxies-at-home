import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from "node:dns";
import https from "node:https";
import { isIP } from "node:net";

export type ResolveAll = (
  hostname: string,
  options: { all: true; verbatim: true },
  callback: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
) => void;

type PinnedLookup = (
  hostname: string,
  options: number | LookupOptions,
  callback: (error: NodeJS.ErrnoException | null, address: string, family: number) => void,
) => void;

const IPV4_DENY_RANGES: Array<[number, number]> = ([
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.31.196.0", 24],
  ["192.52.193.0", 24],
  ["192.88.99.0", 24],
  ["192.175.48.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as Array<[string, number]>).map(([address, prefix]) => [ipv4ToNumber(address), prefix]);

const IPV6_DENY_RANGES: Array<[bigint, number]> = ([
  ["::", 128],
  ["::1", 128],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["3fff::", 20],
  ["5f00::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as Array<[string, number]>).map(([address, prefix]) => [ipv6ToBigInt(address), prefix]);

export class AddressPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AddressPolicyError";
  }
}

function ipv4ToNumber(address: string): number {
  return address.split(".").reduce((value, part) => (value << 8) + Number(part), 0) >>> 0;
}

function belongsToIpv4Range(address: number, network: number, prefix: number): boolean {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (address & mask) === (network & mask);
}

function expandIpv6Parts(parts: string[]): string[] | null {
  if (parts.length === 0) return [];
  const expanded = [...parts];
  const last = expanded.at(-1);
  if (last?.includes(".")) {
    if (isIP(last) !== 4) return null;
    const ipv4 = ipv4ToNumber(last);
    expanded.splice(-1, 1, ((ipv4 >>> 16) & 0xffff).toString(16), (ipv4 & 0xffff).toString(16));
  }
  return expanded.every(part => /^[0-9a-f]{1,4}$/i.test(part)) ? expanded : null;
}

function ipv6ToBigInt(address: string): bigint {
  const [beforeCompression, afterCompression, ...extra] = address.toLowerCase().split("::");
  if (extra.length > 0) throw new Error(`Invalid IPv6 address: ${address}`);

  const before = expandIpv6Parts(beforeCompression ? beforeCompression.split(":") : []);
  const after = expandIpv6Parts(afterCompression ? afterCompression.split(":") : []);
  if (!before || !after) throw new Error(`Invalid IPv6 address: ${address}`);

  const parts = afterCompression === undefined
    ? before
    : [...before, ...Array(8 - before.length - after.length).fill("0"), ...after];
  if (parts.length !== 8) throw new Error(`Invalid IPv6 address: ${address}`);

  return parts.reduce((value, part) => (value << 16n) + BigInt(`0x${part}`), 0n);
}

function belongsToIpv6Range(address: bigint, network: bigint, prefix: number): boolean {
  const mask = prefix === 0 ? 0n : ((1n << BigInt(prefix)) - 1n) << BigInt(128 - prefix);
  return (address & mask) === (network & mask);
}

function isPublicIpv4Number(address: number): boolean {
  return !IPV4_DENY_RANGES.some(([network, prefix]) => belongsToIpv4Range(address, network, prefix));
}

function embeddedIpv4(address: bigint): number | null {
  if (belongsToIpv6Range(address, ipv6ToBigInt("::ffff:0:0"), 96)
    || belongsToIpv6Range(address, 0n, 96)
    || belongsToIpv6Range(address, ipv6ToBigInt("64:ff9b::"), 96)) {
    return Number(address & 0xffffffffn);
  }
  if (belongsToIpv6Range(address, ipv6ToBigInt("2002::"), 16)) {
    return Number((address >> 80n) & 0xffffffffn);
  }
  return null;
}

/** Returns true only for globally routable unicast addresses. */
export function isPublicIpAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPublicIpv4Number(ipv4ToNumber(address));
  if (family !== 6 || address.includes("%")) return false;

  const numericAddress = ipv6ToBigInt(address);
  if (IPV6_DENY_RANGES.some(([network, prefix]) => belongsToIpv6Range(numericAddress, network, prefix))) {
    return false;
  }

  const embedded = embeddedIpv4(numericAddress);
  return embedded === null || isPublicIpv4Number(embedded);
}

export function createPinnedLookup(resolveAll: ResolveAll = dnsLookup as unknown as ResolveAll): PinnedLookup {
  return (hostname, _options, callback) => {
    resolveAll(hostname, { all: true, verbatim: true }, (error, records) => {
      if (error) {
        callback(error, "", 0);
        return;
      }
      if (!records.length) {
        callback(new AddressPolicyError("DNS returned no addresses"), "", 0);
        return;
      }
      if (records.some(record => record.family !== isIP(record.address) || !isPublicIpAddress(record.address))) {
        callback(new AddressPolicyError("DNS returned a prohibited address"), "", 0);
        return;
      }

      const pinned = records[0];
      callback(null, pinned.address, pinned.family);
    });
  };
}

/**
 * A fresh agent pins Node's socket lookup to a just-validated DNS answer.  The
 * request URL remains hostname-based, so Node keeps that hostname for SNI and
 * certificate verification instead of substituting the selected IP literal.
 */
export function createPinnedHttpsAgent(options: { resolveAll?: ResolveAll } = {}): https.Agent {
  return new https.Agent({
    keepAlive: false,
    lookup: createPinnedLookup(options.resolveAll),
  });
}
