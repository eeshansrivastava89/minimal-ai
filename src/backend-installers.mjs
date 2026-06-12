import { pc } from "./ui.mjs";

export const BACKEND_INSTALLERS = {
  lmstudio: {
    label: "LM Studio",
    choiceLabel: "LM Studio (recommended)",
    hint: "brew install --cask lm-studio — visual model browser + CLI",
    commands: [["brew", ["install", "--cask", "lm-studio"], "LM Studio"]],
    success(model) {
      console.log(pc.green("✓ LM Studio installed"));
      console.log(pc.yellow("\nOpen LM Studio and download a model to get started."));
      console.log(pc.dim(`Recommended for your machine: ${model.label}`));
      console.log(pc.dim("Then run offgrid-ai again to pick and run a model."));
    },
    failure: "Download it manually from https://lmstudio.ai",
    allFailure: "✗ LM Studio installation failed. Download from https://lmstudio.ai",
  },
  ollama: {
    label: "Ollama",
    choiceLabel: "Ollama",
    hint: "brew install ollama — models download on demand",
    commands: [["brew", ["install", "ollama"], "Ollama"]],
    success(model) {
      console.log(pc.green("✓ Ollama installed"));
      console.log(pc.yellow("\nStart Ollama and pull a model:"));
      console.log(pc.bold(`  ollama serve &   ollama pull ${model.ollama}`));
      console.log(pc.dim(`Recommended for your machine: ${model.label}`));
      console.log(pc.dim("Then run offgrid-ai again to pick and run a model."));
    },
    failure: "Install it manually from https://ollama.com",
    allFailure: "✗ Ollama installation failed. Install manually from https://ollama.com",
  },
  omlx: {
    label: "oMLX",
    choiceLabel: "oMLX",
    hint: "brew tap jundot/omlx && brew install omlx — Apple Silicon optimized",
    commands: [
      ["brew", ["tap", "jundot/omlx", "https://github.com/jundot/omlx"], "oMLX tap"],
      ["brew", ["install", "omlx"], "oMLX"],
    ],
    success(model) {
      console.log(pc.green("✓ oMLX installed"));
      console.log(pc.yellow("\nStart oMLX and download a model:"));
      console.log(pc.bold("  omlx start"));
      console.log(pc.dim(`Recommended for your machine: ${model.label}`));
      console.log(pc.dim("Then run offgrid-ai again to pick and run a model."));
    },
    failure: "Install manually: brew tap jundot/omlx && brew install omlx",
    allFailure: "✗ oMLX installation failed. Install manually: brew tap jundot/omlx && brew install omlx",
  },
};

export const BACKEND_INSTALL_CHOICES = [
  ...Object.entries(BACKEND_INSTALLERS).map(([value, installer]) => ({ value, label: installer.choiceLabel, hint: installer.hint })),
  { value: "all", label: "Install all three", hint: "LM Studio + Ollama + oMLX" },
  { value: "skip", label: "Skip for now", hint: "I'll set up models myself" },
];
