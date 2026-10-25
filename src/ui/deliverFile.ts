// Hand a generated file to the user: the native share sheet on phones
// (Save to Files / AirDrop / another app), a plain download elsewhere.
export async function deliverFile(file: File, shareText?: string): Promise<void> {
  const nav = navigator as Navigator & { canShare?: (d: unknown) => boolean; share?: (d: unknown) => Promise<void> };
  if (nav.canShare && nav.share && nav.canShare({ files: [file] })) {
    try { await nav.share({ files: [file], title: file.name, text: shareText ?? file.name }); return; }
    catch (e) { if ((e as Error).name === "AbortError") return; /* else fall through to download */ }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url; a.download = file.name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
