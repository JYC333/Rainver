/** Linux seccomp cBPF consumed by bubblewrap through an anonymous pipe.
 * Deny Unix clients and io_uring, while keeping Node's stream socketpair IPC.
 * TCP/UDP remain unchanged: this is not mandatory network isolation.
 */
export function readOnlyIpcFilter(): Buffer {
  const arch = process.arch === 'x64'
    ? { audit: 0xc000003e, socket: 41, pair: 53 }
    : process.arch === 'arm64'
      ? { audit: 0xc00000b7, socket: 198, pair: 199 }
      : null;
  if (!arch) throw new Error('Read-only local IPC protection requires Linux x64 or arm64');

  // struct sock_filter: u16 code, u8 jt, u8 jf, u32 k. Returns EPERM, not a
  // fatal signal, so a runtime can report an unsupported local IPC operation.
  const allow = 0x7fff0000;
  const deny = 0x00050001;
  const rows = [
    [0x20, 0, 0, 4], // seccomp_data.arch
    [0x15, 1, 0, arch.audit],
    [0x06, 0, 0, deny], // Foreign ABI, including legacy socketcall.
    [0x20, 0, 0, 0], // seccomp_data.nr
    [0x35, 0, 1, 0x40000000],
    [0x06, 0, 0, deny], // x32 alternate syscall numbering.
    [0x15, 0, 1, 425],
    [0x06, 0, 0, deny], // io_uring_setup: do not permit a second socket API.
    [0x15, 3, 0, arch.socket], // -> socket domain check (12).
    [0x15, 6, 0, arch.pair], // -> socketpair domain check (16).
    [0x06, 0, 0, allow],
    [0x06, 0, 0, deny],
    [0x20, 0, 0, 16], // args[0]: socket domain
    [0x15, 0, 1, 1], // AF_UNIX
    [0x06, 0, 0, deny],
    [0x06, 0, 0, allow],
    [0x20, 0, 0, 16], // args[0]: socketpair domain
    [0x15, 0, 4, 1],
    [0x20, 0, 0, 24], // args[1]: socketpair type, ignoring CLOEXEC/NONBLOCK.
    [0x54, 0, 0, 15],
    [0x15, 1, 0, 1], // SOCK_STREAM: Node child IPC. Other Unix pairs denied.
    [0x06, 0, 0, deny],
    [0x06, 0, 0, allow],
  ];
  const buffer = Buffer.alloc(rows.length * 8);
  rows.forEach(([code, jt, jf, k], i) => {
    buffer.writeUInt16LE(code!, i * 8);
    buffer[i * 8 + 2] = jt!;
    buffer[i * 8 + 3] = jf!;
    buffer.writeUInt32LE(k! >>> 0, i * 8 + 4);
  });
  return buffer;
}
