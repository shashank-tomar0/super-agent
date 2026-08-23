import { useState } from "react";

interface OnboardingProps {
  onComplete: (openSettings?: boolean) => void;
}

const STEPS = [
  {
    title: "Welcome to VLESS",
    description:
      "A privacy-preserving browser agent that perceives your screen, understands your intent, and fills forms — without sending a single pixel to the cloud.",
    badge: "0 KB Egress",
  },
  {
    title: "100% On-Device Perception",
    description:
      "Every vision model (PP-OCR, Florence-2 ViT) runs locally inside WebGPU/WASM. Screenshots never leave your browser memory.",
    badge: "Local WASM / WebGPU",
  },
  {
    title: "Connect AI Provider",
    description:
      "VLESS connects to Ollama (free local execution) or cloud planners (Claude, OpenAI, OpenRouter) with device-encrypted key storage.",
    badge: "Multi-Provider Planner",
  },
  {
    title: "Real-Time Visual Debug",
    description:
      "Inspect bounding boxes, confidence metrics, and full reasoning traces for complete auditability.",
    badge: "DevTools Verifiable",
  },
  {
    title: "Ready to Automate",
    description:
      "Open the side panel on any website, state your goal in natural language, and let VLESS safely plan and execute.",
    badge: "Ready",
  },
];

export function Onboarding({ onComplete }: OnboardingProps) {
  const [currentStep, setCurrentStep] = useState(0);
  const [isExiting, setIsExiting] = useState(false);

  const step = STEPS[currentStep];
  const isLast = currentStep === STEPS.length - 1;

  const handleNext = () => {
    if (isLast) {
      setIsExiting(true);
      setTimeout(() => onComplete(true), 300);
    } else {
      setCurrentStep((s) => s + 1);
    }
  };

  const handleSkip = () => {
    setIsExiting(true);
    setTimeout(onComplete, 300);
  };

  return (
    <div
      className={`fixed inset-0 z-50 flex items-center justify-center bg-[#090a0f] transition-opacity duration-300 font-sans ${
        isExiting ? "opacity-0" : "opacity-100"
      }`}
    >
      <div className="relative max-w-sm w-full mx-4 hallmark-card p-6 border-[#222636] space-y-6">
        {!isLast && (
          <button
            onClick={handleSkip}
            className="absolute top-4 right-4 text-[10px] font-mono uppercase text-gray-500 hover:text-white transition-colors"
          >
            Skip
          </button>
        )}

        <div className="space-y-3 text-center">
          <div className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 text-[10px] font-mono uppercase font-medium">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse-dot" />
            {step.badge}
          </div>

          <h1 className="text-3xl text-white font-serif-title tracking-tight leading-tight">
            {step.title}
          </h1>

          <p className="text-xs text-gray-400 font-light leading-relaxed">
            {step.description}
          </p>
        </div>

        {/* Progress bar dots */}
        <div className="flex justify-center gap-1.5">
          {STEPS.map((_, i) => (
            <div
              key={i}
              className={`h-1 rounded transition-all duration-300 ${
                i === currentStep
                  ? "w-6 bg-white"
                  : i < currentStep
                    ? "w-1.5 bg-gray-500"
                    : "w-1.5 bg-gray-800"
              }`}
            />
          ))}
        </div>

        {/* Action Button */}
        <button
          onClick={handleNext}
          className={`w-full py-2.5 text-xs font-mono uppercase font-semibold transition-all ${
            isLast
              ? "hallmark-button-primary"
              : "hallmark-button text-gray-200 hover:text-white"
          }`}
        >
          {isLast ? "Setup AI Provider" : "Continue"}
        </button>
      </div>
    </div>
  );
}
