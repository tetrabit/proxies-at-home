export type CollatedDuplexStep = { src: "front" | "back"; index: number };

export function buildCollatedDuplexPageOrder(frontPages: number, backPages: number): CollatedDuplexStep[] {
  const max = Math.max(frontPages, backPages);
  const out: CollatedDuplexStep[] = [];
  for (let i = 0; i < max; i++) {
    if (i < frontPages) out.push({ src: "front", index: i });
    if (i < backPages) out.push({ src: "back", index: i });
  }
  return out;
}

export function splitInterleavedDuplexPageIndices(frontPages: number, backPages: number): {
  frontPageIndices: number[];
  backPageIndices: number[];
} {
  const frontPageIndices: number[] = [];
  const backPageIndices: number[] = [];

  buildCollatedDuplexPageOrder(frontPages, backPages).forEach((step, outputIndex) => {
    if (step.src === "front") {
      frontPageIndices.push(outputIndex);
      return;
    }
    backPageIndices.push(outputIndex);
  });

  return { frontPageIndices, backPageIndices };
}
