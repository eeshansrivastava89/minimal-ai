import { pc } from "./ui.mjs";

export const BACKEND_INSTALLERS = {
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
  { value: "skip", label: "Skip for now", hint: "I'll set up models myself" },
];