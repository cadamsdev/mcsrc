import { crc32 } from "../workers/remap/crc32";
import { writeZip, type ZipEntryData } from "../workers/remap/zip";
import * as worker from "../workers/decompile/client";
import { DecompileJar } from "../workers/decompile/types";
import type { MinecraftJar } from "./MinecraftApi";
import type { ClassName } from "../utils/Names";

const encoder = new TextEncoder();

async function encodeEntry(name: string, source: string): Promise<ZipEntryData> {
    const bytes = encoder.encode(source);
    const checksum = crc32(bytes);

    if (typeof CompressionStream !== "function") {
        return { name, bytes, crc32: checksum, uncompressedSize: bytes.length, compressionMethod: 0 };
    }

    try {
        const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw"));
        const compressed = new Uint8Array(await new Response(stream).arrayBuffer());
        return { name, bytes: compressed, crc32: checksum, uncompressedSize: bytes.length, compressionMethod: 8 };
    } catch (error) {
        console.warn("Failed to deflate source entry, storing uncompressed", error);
        return { name, bytes, crc32: checksum, uncompressedSize: bytes.length, compressionMethod: 0 };
    }
}

// Every outer class that's already been decompiled and cached for this jar, keyed by its checksum.
async function getDecompiledClasses(jar: MinecraftJar): Promise<{ className: ClassName; source: string }[]> {
    const dJar = new DecompileJar(jar.jar);
    const classNames = dJar.classes.filter(n => !n.includes("$"));

    const lookups = classNames
        .map(className => ({ className, checksum: dJar.proxy[className]?.checksum }))
        .filter((e): e is { className: ClassName; checksum: number } => e.checksum !== undefined);

    const sources = await worker.getCachedSources(lookups);
    return lookups
        .map((e, i) => ({ className: e.className, source: sources[i] }))
        .filter((e): e is { className: ClassName; source: string } => e.source !== undefined);
}

export async function downloadSourceZip(
    jar: MinecraftJar,
    onProgress?: (current: number, total: number) => void,
): Promise<number> {
    const classes = await getDecompiledClasses(jar);

    const zipEntries: ZipEntryData[] = [];
    for (let i = 0; i < classes.length; i++) {
        zipEntries.push(await encodeEntry(`${classes[i].className}.java`, classes[i].source));
        onProgress?.(i + 1, classes.length);
    }

    const blob = writeZip(zipEntries);
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${jar.version}-source.zip`;
    link.click();
    URL.revokeObjectURL(url);

    return zipEntries.length;
}
