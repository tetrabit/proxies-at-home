import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_RENDER_PARAMS } from "../../CardCanvas";
import { ColorReplaceSection } from "./ColorReplaceSection";
import { EnhanceSection } from "./EnhanceSection";
import { GammaSection } from "./GammaSection";
import { HolographicSection } from "./HolographicSection";

vi.mock("../../common/StyledSlider", () => ({
  StyledSlider: ({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) => (
    <label>
      {label}
      <input aria-label={label} value={value} onChange={(event) => onChange(Number(event.target.value))} />
    </label>
  ),
}));

vi.mock("../../common/ColorPicker", () => ({
  ColorPicker: ({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) => (
    <label>
      {label}
      <input aria-label={label} value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  ),
}));

describe("residual CardEditor sections", () => {
  const updateParam = vi.fn();

  beforeEach(() => {
    updateParam.mockClear();
  });

  it("renders disabled color replacement and enables nested controls", () => {
    const { rerender } = render(
      <ColorReplaceSection params={DEFAULT_RENDER_PARAMS} defaultParams={DEFAULT_RENDER_PARAMS} updateParam={updateParam} />
    );

    fireEvent.click(screen.getByLabelText("Enable Color Replace"));
    expect(updateParam).toHaveBeenCalledWith("colorReplaceEnabled", true);
    expect(screen.queryByLabelText("Source Color")).not.toBeInTheDocument();

    rerender(
      <ColorReplaceSection
        params={{ ...DEFAULT_RENDER_PARAMS, colorReplaceEnabled: true }}
        defaultParams={DEFAULT_RENDER_PARAMS}
        updateParam={updateParam}
      />
    );
    fireEvent.change(screen.getByLabelText("Source Color"), { target: { value: "#123456" } });
    fireEvent.change(screen.getByLabelText("Target Color"), { target: { value: "#654321" } });
    fireEvent.change(screen.getByLabelText("Threshold"), { target: { value: "44" } });

    expect(updateParam).toHaveBeenCalledWith("colorReplaceSource", "#123456");
    expect(updateParam).toHaveBeenCalledWith("colorReplaceTarget", "#654321");
    expect(updateParam).toHaveBeenCalledWith("colorReplaceThreshold", 44);
  });

  it("renders enhancement controls and CMYK toggle", () => {
    render(<EnhanceSection params={DEFAULT_RENDER_PARAMS} defaultParams={DEFAULT_RENDER_PARAMS} updateParam={updateParam} />);

    fireEvent.change(screen.getByLabelText("Sharpness"), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText("Pop"), { target: { value: "33" } });
    fireEvent.change(screen.getByLabelText("Noise Reduction"), { target: { value: "12" } });
    fireEvent.click(screen.getByLabelText("CMYK Preview"));

    expect(updateParam).toHaveBeenCalledWith("sharpness", 2);
    expect(updateParam).toHaveBeenCalledWith("pop", 33);
    expect(updateParam).toHaveBeenCalledWith("noiseReduction", 12);
    expect(updateParam).toHaveBeenCalledWith("cmykPreview", true);
  });

  it("renders gamma control", () => {
    render(<GammaSection params={DEFAULT_RENDER_PARAMS} defaultParams={DEFAULT_RENDER_PARAMS} updateParam={updateParam} />);

    fireEvent.change(screen.getByLabelText("Gamma"), { target: { value: "1.75" } });

    expect(updateParam).toHaveBeenCalledWith("gamma", 1.75);
  });

  it("renders holographic conditional controls for glitter, bright areas, and sweep animation", () => {
    const params = {
      ...DEFAULT_RENDER_PARAMS,
      holoEffect: "glitter" as const,
      holoAreaMode: "bright" as const,
      holoAnimation: "sweep" as const,
    };
    render(<HolographicSection params={params} defaultParams={DEFAULT_RENDER_PARAMS} updateParam={updateParam} />);

    fireEvent.change(screen.getByLabelText("Effect Type"), { target: { value: "stars" } });
    fireEvent.change(screen.getByLabelText("Star Size"), { target: { value: "75" } });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "25" } });
    fireEvent.change(screen.getByLabelText("Shift Position"), { target: { value: "15" } });
    fireEvent.change(screen.getByLabelText("Blur"), { target: { value: "35" } });
    fireEvent.change(screen.getByLabelText("Strength"), { target: { value: "80" } });
    fireEvent.change(screen.getByLabelText("Apply To"), { target: { value: "full" } });
    fireEvent.change(screen.getByLabelText("Brightness Threshold"), { target: { value: "60" } });
    fireEvent.change(screen.getByLabelText("Animation"), { target: { value: "twinkle" } });
    fireEvent.change(screen.getByLabelText("Speed"), { target: { value: "8" } });
    fireEvent.change(screen.getByLabelText("Band Width"), { target: { value: "40" } });
    fireEvent.change(screen.getByLabelText("Export Mode"), { target: { value: "none" } });

    expect(updateParam).toHaveBeenCalledWith("holoEffect", "stars");
    expect(updateParam).toHaveBeenCalledWith("holoStarSize", 75);
    expect(updateParam).toHaveBeenCalledWith("holoProbability", 25);
    expect(updateParam).toHaveBeenCalledWith("holoStarVariety", 15);
    expect(updateParam).toHaveBeenCalledWith("holoBlur", 35);
    expect(updateParam).toHaveBeenCalledWith("holoStrength", 80);
    expect(updateParam).toHaveBeenCalledWith("holoAreaMode", "full");
    expect(updateParam).toHaveBeenCalledWith("holoAreaThreshold", 60);
    expect(updateParam).toHaveBeenCalledWith("holoAnimation", "twinkle");
    expect(updateParam).toHaveBeenCalledWith("holoSpeed", 8);
    expect(updateParam).toHaveBeenCalledWith("holoSweepWidth", 40);
    expect(updateParam).toHaveBeenCalledWith("holoExportMode", "none");
  });

  it("hides holographic effect controls when no effect is selected", () => {
    render(<HolographicSection params={DEFAULT_RENDER_PARAMS} defaultParams={DEFAULT_RENDER_PARAMS} updateParam={updateParam} />);

    expect(screen.getByLabelText("Effect Type")).toBeInTheDocument();
    expect(screen.queryByLabelText("Strength")).not.toBeInTheDocument();
    expect(screen.queryByText("Twinkle")).not.toBeInTheDocument();
  });
});
