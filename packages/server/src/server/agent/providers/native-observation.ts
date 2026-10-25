import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";

export const NativeObservationOptionsSchema = z
  .object({
    actorId: z.string().uuid(),
    ownerClientMessageId: z.string().uuid(),
    path: z
      .string()
      .refine(
        (path) => isAbsolute(path) && resolve(path) === path,
        "Expected canonical absolute observation path",
      ),
  })
  .strict();

export type NativeObservationOptions = z.infer<typeof NativeObservationOptionsSchema>;

export function assertObservationActor(
  options: NativeObservationOptions,
  actorId: string | undefined,
): void {
  if (options.actorId !== actorId)
    throw new Error("Native observation actor does not match launch context");
}

export function writeNativeObservation(path: string, record: unknown, maxBytes: number): void {
  const bytes = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
  if (bytes.length > maxBytes) throw new Error("Native observation exceeds its byte limit");
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("Native observation custody requires POSIX ownership");
  const parent = dirname(path);
  if (realpathSync(parent) !== parent)
    throw new Error("Native observation directory contains a symlink");
  const before = lstatSync(parent);
  if (!before.isDirectory() || before.uid !== uid || (before.mode & 0o077) !== 0) {
    throw new Error("Native observation requires an owned private directory");
  }
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const file = fstatSync(fd);
    const openedParent = lstatSync(parent);
    if (
      !file.isFile() ||
      file.uid !== uid ||
      file.nlink !== 1 ||
      (file.mode & 0o777) !== 0o600 ||
      openedParent.dev !== before.dev ||
      openedParent.ino !== before.ino
    ) {
      throw new Error("Native observation custody changed during creation");
    }
    writeFileSync(fd, bytes);
    fsyncSync(fd);
    const after = lstatSync(parent);
    if (after.dev !== before.dev || after.ino !== before.ino || realpathSync(parent) !== parent) {
      throw new Error("Native observation directory changed during write");
    }
    const directoryFd = openSync(
      parent,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      fsyncSync(directoryFd);
    } finally {
      closeSync(directoryFd);
    }
  } finally {
    // Failed or partial attempted observations remain in custody; never overwrite or retry them.
    closeSync(fd);
  }
}
