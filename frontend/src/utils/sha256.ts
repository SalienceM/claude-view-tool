const INITIAL = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

const ROUND = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
  0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
  0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
  0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotateRight(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

/** Small incremental SHA-256 fallback for non-secure LAN HTTP origins. */
export class IncrementalSha256 {
  private readonly state = new Uint32Array(INITIAL);
  private readonly schedule = new Uint32Array(64);
  private readonly pending = new Uint8Array(64);
  private pendingLength = 0;
  private bytesHashed = 0;
  private finished = false;

  update(input: Uint8Array): this {
    if (this.finished) throw new Error('SHA-256 digest already finalized');
    this.bytesHashed += input.byteLength;
    let offset = 0;

    if (this.pendingLength > 0) {
      const take = Math.min(64 - this.pendingLength, input.byteLength);
      this.pending.set(input.subarray(0, take), this.pendingLength);
      this.pendingLength += take;
      offset += take;
      if (this.pendingLength === 64) {
        this.compress(this.pending, 0);
        this.pendingLength = 0;
      }
    }

    while (offset + 64 <= input.byteLength) {
      this.compress(input, offset);
      offset += 64;
    }
    if (offset < input.byteLength) {
      const rest = input.subarray(offset);
      this.pending.set(rest, 0);
      this.pendingLength = rest.byteLength;
    }
    return this;
  }

  digestHex(): string {
    if (this.finished) throw new Error('SHA-256 digest already finalized');
    this.finished = true;

    this.pending[this.pendingLength++] = 0x80;
    if (this.pendingLength > 56) {
      this.pending.fill(0, this.pendingLength);
      this.compress(this.pending, 0);
      this.pendingLength = 0;
    }
    this.pending.fill(0, this.pendingLength, 56);

    const bitLength = this.bytesHashed * 8;
    const high = Math.floor(bitLength / 0x100000000);
    const low = bitLength >>> 0;
    this.pending[56] = high >>> 24;
    this.pending[57] = high >>> 16;
    this.pending[58] = high >>> 8;
    this.pending[59] = high;
    this.pending[60] = low >>> 24;
    this.pending[61] = low >>> 16;
    this.pending[62] = low >>> 8;
    this.pending[63] = low;
    this.compress(this.pending, 0);

    return Array.from(this.state)
      .map((value) => value.toString(16).padStart(8, '0'))
      .join('');
  }

  private compress(block: Uint8Array, offset: number): void {
    const words = this.schedule;
    for (let index = 0; index < 16; index++) {
      const cursor = offset + index * 4;
      words[index] = (
        (block[cursor] << 24)
        | (block[cursor + 1] << 16)
        | (block[cursor + 2] << 8)
        | block[cursor + 3]
      ) >>> 0;
    }
    for (let index = 16; index < 64; index++) {
      const x = words[index - 15];
      const y = words[index - 2];
      const sigma0 = rotateRight(x, 7) ^ rotateRight(x, 18) ^ (x >>> 3);
      const sigma1 = rotateRight(y, 17) ^ rotateRight(y, 19) ^ (y >>> 10);
      words[index] = (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0;
    }

    let a = this.state[0]; let b = this.state[1];
    let c = this.state[2]; let d = this.state[3];
    let e = this.state[4]; let f = this.state[5];
    let g = this.state[6]; let h = this.state[7];
    for (let index = 0; index < 64; index++) {
      const choice = (e & f) ^ (~e & g);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const temp1 = (h + sum1 + choice + ROUND[index] + words[index]) >>> 0;
      const temp2 = (sum0 + majority) >>> 0;
      h = g; g = f; f = e; e = (d + temp1) >>> 0;
      d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    this.state[0] = (this.state[0] + a) >>> 0;
    this.state[1] = (this.state[1] + b) >>> 0;
    this.state[2] = (this.state[2] + c) >>> 0;
    this.state[3] = (this.state[3] + d) >>> 0;
    this.state[4] = (this.state[4] + e) >>> 0;
    this.state[5] = (this.state[5] + f) >>> 0;
    this.state[6] = (this.state[6] + g) >>> 0;
    this.state[7] = (this.state[7] + h) >>> 0;
  }
}

export async function sha256BlobHex(blob: Blob): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  // Native Web Crypto is much faster. Limit full-buffer use so a large archive does
  // not briefly duplicate hundreds of MB on a memory-constrained tablet.
  if (subtle && blob.size <= 64 * 1024 * 1024) {
    const digest = await subtle.digest('SHA-256', await blob.arrayBuffer());
    return Array.from(new Uint8Array(digest))
      .map((value) => value.toString(16).padStart(2, '0'))
      .join('');
  }
  const hasher = new IncrementalSha256();
  const chunkSize = 1024 * 1024;
  for (let offset = 0; offset < blob.size; offset += chunkSize) {
    hasher.update(new Uint8Array(await blob.slice(offset, offset + chunkSize).arrayBuffer()));
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
  return hasher.digestHex();
}
