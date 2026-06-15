import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

export async function sha256File(filePath) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(filePath), async function* (source) {
    for await (const chunk of source) hash.update(chunk);
  });
  return hash.digest('hex');
}

export async function sha256Buffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

export async function splitFile(filePath, chunkBytes, { outDir, baseName }) {
  await mkdir(outDir, { recursive: true });
  const buffer = await readFile(filePath);
  const chunks = [];
  let index = 0;
  for (let offset = 0; offset < buffer.length; offset += chunkBytes) {
    const part = buffer.subarray(offset, offset + chunkBytes);
    const name = `${baseName}.ch${String(index).padStart(3, '0')}`;
    const chunkPath = path.join(outDir, name);
    await writeFile(chunkPath, part);
    chunks.push({
      index,
      path: chunkPath,
      bytes: part.length,
      sha256: await sha256Buffer(part),
    });
    index += 1;
  }
  return {
    chunkCount: chunks.length,
    chunks,
    fileSha256: await sha256Buffer(buffer),
    totalBytes: buffer.length,
  };
}

export async function mergeChunks(chunkPaths, outputPath, { expectedSha256 = null } = {}) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  const parts = [];
  for (const chunkPath of chunkPaths) {
    parts.push(await readFile(chunkPath));
  }
  const merged = Buffer.concat(parts);
  if (expectedSha256 && (await sha256Buffer(merged)) !== expectedSha256) {
    throw new Error(`Merged file sha256 mismatch (expected ${expectedSha256})`);
  }
  await writeFile(outputPath, merged);
  return { bytes: merged.length, sha256: await sha256Buffer(merged) };
}

export async function withTempDir(prefix, fn) {
  const dir = path.join(process.cwd(), '.tmp', `${prefix}-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
