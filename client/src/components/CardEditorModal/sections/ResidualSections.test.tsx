import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_RENDER_PARAMS } from "../../CardCanvas";
import { darkenModeToInt } from "../../CardCanvas/types";
import { ColorEffectsSection } from "./ColorEffectsSection";
import { ColorReplaceSection } from "./ColorReplaceSection";
import { EnhanceSection } from "./EnhanceSection";
import { GammaSection } from "./GammaSection";
import { HolographicSection } from "./HolographicSection";

vi.mock("../../common/StyledSlider", () => ({
  StyledSlider: ({
    label,
    value,
    onChange,
  }: {
    label: string;
    value: number;
    onChange: (v: number) => void;
  }) => (
    <label>
      {label}
      <input
        aria-label={label}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  ),
}));

vi.mock("../../common/ColorPicker", () => ({
  ColorPicker: ({
    label,
    value,
    onChange,
  }: {
    label: string;
    value: string;
    onChange: (v: string) => void;
  }) => (
    <label>
      {label}
      <input
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  ),
}));

describe("residual CardEditor sections", () => {
  const updateParam = vi.fn();

  const selectByLabelText = (label: string) => {
    const select = screen
      .getByText(label)
      .parentElement?.querySelector("select");
    expect(select).toBeInstanceOf(HTMLSelectElement);
    return select as HTMLSelectElement;
  };

  const checkboxByText = (label: string) => {
    const checkbox = screen
      .getByText(label)
      .closest("label")
      ?.querySelector('input[type="checkbox"]');
    expect(checkbox).toBeInstanceOf(HTMLInputElement);
    return checkbox as HTMLInputElement;
  };

  beforeEach(() => {
    updateParam.mockClear();
  });

  it("renders color effect balance controls", () => {
    render(
      <ColorEffectsSection
        params={DEFAULT_RENDER_PARAMS}
        defaultParams={DEFAULT_RENDER_PARAMS}
        updateParam={updateParam}
      />
    );

    [
      ["Hue Shift", "12", "hueShift", 12],
      ["Sepia", "0.5", "sepia", 0.5],
      ["Tint Color", "#abcdef", "tintColor", "#abcdef"],
      ["Tint Amount", "0.75", "tintAmount", 0.75],
      ["Red", "10", "redBalance", 10],
      ["Green", "-10", "greenBalance", -10],
      ["Blue", "20", "blueBalance", 20],
      ["Cyan", "11", "cyanBalance", 11],
      ["Magenta", "-12", "magentaBalance", -12],
      ["Yellow", "13", "yellowBalance", 13],
      ["Black", "-14", "blackBalance", -14],
      ["Shadows", "15", "shadowsIntensity", 15],
      ["Midtones", "-16", "midtonesIntensity", -16],
      ["Highlights", "17", "highlightsIntensity", 17],
    ].forEach(([label, value, param, expected]) => {
      fireEvent.change(screen.getByLabelText(label as string), {
        target: { value },
      });
      expect(updateParam).toHaveBeenCalledWith(param, expected);
    });
  });

  it("maps darken modes for shader uniform consumers", () => {
    expect(darkenModeToInt("none")).toBe(0);
    expect(darkenModeToInt("darken-all")).toBe(1);
    expect(darkenModeToInt("contrast-edges")).toBe(2);
    expect(darkenModeToInt("contrast-full")).toBe(3);
    expect(darkenModeToInt("unexpected" as never)).toBe(0);
  });

  it("covers positive display branches for color balances", () => {
    render(
      <ColorEffectsSection
        params={{
          ...DEFAULT_RENDER_PARAMS,
          redBalance: 1,
          greenBalance: 2,
          blueBalance: 3,
          cyanBalance: 4,
          magentaBalance: 5,
          yellowBalance: 6,
          blackBalance: 7,
          shadowsIntensity: 8,
          midtonesIntensity: 9,
          highlightsIntensity: 10,
        }}
        defaultParams={DEFAULT_RENDER_PARAMS}
        updateParam={updateParam}
      />
    );

    expect(screen.getAllByDisplayValue(/[+]\d+/).length).toBeGreaterThanOrEqual(
      10
    );
  });

  it("renders stars-only holographic branches", () => {
    render(
      <HolographicSection
        params={{
          ...DEFAULT_RENDER_PARAMS,
          holoEffect: "stars",
          holoAreaMode: "full",
          holoAnimation: "none",
        }}
        defaultParams={DEFAULT_RENDER_PARAMS}
        updateParam={updateParam}
      />
    );

    expect(screen.getByLabelText("Star Size")).toBeInTheDocument();
    expect(screen.queryByLabelText("Glitter Size")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Blur")).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText("Brightness Threshold")
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Speed")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Band Width")).not.toBeInTheDocument();
    expect(screen.getByText("Twinkle")).toBeInTheDocument();
  });

  it("renders disabled color replacement and enables nested controls", () => {
    const { rerender } = render(
      <ColorReplaceSection
        params={DEFAULT_RENDER_PARAMS}
        defaultParams={DEFAULT_RENDER_PARAMS}
        updateParam={updateParam}
      />
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
    fireEvent.change(screen.getByLabelText("Source Color"), {
      target: { value: "#123456" },
    });
    fireEvent.change(screen.getByLabelText("Target Color"), {
      target: { value: "#654321" },
    });
    fireEvent.change(screen.getByLabelText("Threshold"), {
      target: { value: "44" },
    });

    expect(updateParam).toHaveBeenCalledWith("colorReplaceSource", "#123456");
    expect(updateParam).toHaveBeenCalledWith("colorReplaceTarget", "#654321");
    expect(updateParam).toHaveBeenCalledWith("colorReplaceThreshold", 44);
  });

  it("renders enhancement controls and CMYK toggle", () => {
    render(
      <EnhanceSection
        params={DEFAULT_RENDER_PARAMS}
        defaultParams={DEFAULT_RENDER_PARAMS}
        updateParam={updateParam}
      />
    );

    fireEvent.change(screen.getByLabelText("Sharpness"), {
      target: { value: "2" },
    });
    fireEvent.change(screen.getByLabelText("Pop"), { target: { value: "33" } });
    fireEvent.change(screen.getByLabelText("Noise Reduction"), {
      target: { value: "12" },
    });
    fireEvent.click(checkboxByText("CMYK Preview"));

    expect(updateParam).toHaveBeenCalledWith("sharpness", 2);
    expect(updateParam).toHaveBeenCalledWith("pop", 33);
    expect(updateParam).toHaveBeenCalledWith("noiseReduction", 12);
    expect(updateParam).toHaveBeenCalledWith("cmykPreview", true);
  });

  it("renders gamma control", () => {
    render(
      <GammaSection
        params={DEFAULT_RENDER_PARAMS}
        defaultParams={DEFAULT_RENDER_PARAMS}
        updateParam={updateParam}
      />
    );

    fireEvent.change(screen.getByLabelText("Gamma"), {
      target: { value: "1.75" },
    });

    expect(updateParam).toHaveBeenCalledWith("gamma", 1.75);
  });

  it("renders holographic conditional controls for glitter, bright areas, and sweep animation", () => {
    const params = {
      ...DEFAULT_RENDER_PARAMS,
      holoEffect: "glitter" as const,
      holoAreaMode: "bright" as const,
      holoAnimation: "sweep" as const,
    };
    render(
      <HolographicSection
        params={params}
        defaultParams={DEFAULT_RENDER_PARAMS}
        updateParam={updateParam}
      />
    );

    fireEvent.change(selectByLabelText("Effect Type"), {
      target: { value: "stars" },
    });
    fireEvent.change(screen.getByLabelText("Glitter Size"), {
      target: { value: "75" },
    });
    fireEvent.change(screen.getByLabelText("Amount"), {
      target: { value: "25" },
    });
    fireEvent.change(screen.getByLabelText("Shift Position"), {
      target: { value: "15" },
    });
    fireEvent.change(screen.getByLabelText("Blur"), {
      target: { value: "35" },
    });
    fireEvent.change(screen.getByLabelText("Strength"), {
      target: { value: "80" },
    });
    fireEvent.change(selectByLabelText("Apply To"), {
      target: { value: "full" },
    });
    fireEvent.change(screen.getByLabelText("Brightness Threshold"), {
      target: { value: "60" },
    });
    fireEvent.change(selectByLabelText("Animation"), {
      target: { value: "twinkle" },
    });
    fireEvent.change(screen.getByLabelText("Speed"), {
      target: { value: "8" },
    });
    fireEvent.change(screen.getByLabelText("Band Width"), {
      target: { value: "40" },
    });
    fireEvent.change(selectByLabelText("Export Mode"), {
      target: { value: "none" },
    });

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
    render(
      <HolographicSection
        params={DEFAULT_RENDER_PARAMS}
        defaultParams={DEFAULT_RENDER_PARAMS}
        updateParam={updateParam}
      />
    );

    expect(screen.getByText("Effect Type")).toBeInTheDocument();
    expect(screen.queryByLabelText("Strength")).not.toBeInTheDocument();
    expect(screen.queryByText("Twinkle")).not.toBeInTheDocument();
  });
});
