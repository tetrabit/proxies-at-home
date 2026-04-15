const COLOR_BINS = 6;
const HISTOGRAM_WEIGHT = 0.85;
const MEAN_WEIGHT = 0.15;

export interface ColorProfile {
  histogram: Float32Array;
  mean: [number, number, number];
}

export function computeColorProfile(channels: Float32Array[]): ColorProfile {
  const [red, green, blue] = channels;
  const pixelCount = red.length;
  const histogram = new Float32Array(COLOR_BINS * 3);
  const mean: [number, number, number] = [0, 0, 0];

  for (let index = 0; index < pixelCount; index += 1) {
    const values = [red[index], green[index], blue[index]];
    for (let channel = 0; channel < values.length; channel += 1) {
      const value = values[channel];
      mean[channel] += value;
      const bin = Math.min(COLOR_BINS - 1, Math.floor(value * COLOR_BINS));
      histogram[channel * COLOR_BINS + bin] += 1;
    }
  }

  for (let channel = 0; channel < mean.length; channel += 1) {
    mean[channel] /= pixelCount;
    for (let bin = 0; bin < COLOR_BINS; bin += 1) {
      histogram[channel * COLOR_BINS + bin] /= pixelCount;
    }
  }

  return { histogram, mean };
}

export function computeColorProfileSimilarity(
  left: ColorProfile,
  right: ColorProfile
): number {
  if (left.histogram.length !== right.histogram.length) {
    return 0;
  }

  let histogramDifference = 0;
  for (let index = 0; index < left.histogram.length; index += 1) {
    histogramDifference += Math.abs(
      left.histogram[index] - right.histogram[index]
    );
  }

  const normalizedHistogramScore = Math.max(0, 1 - histogramDifference / 6);

  let meanDifference = 0;
  for (let index = 0; index < left.mean.length; index += 1) {
    meanDifference += Math.abs(left.mean[index] - right.mean[index]);
  }

  const normalizedMeanScore = Math.max(0, 1 - meanDifference / 3);

  return (
    normalizedHistogramScore * HISTOGRAM_WEIGHT +
    normalizedMeanScore * MEAN_WEIGHT
  );
}
