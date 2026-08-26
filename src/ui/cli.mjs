import { Command } from "commander";
import { FangHelp } from "./help.mjs";
import { theme } from "./theme.mjs";

class FangCommand extends Command {
  createCommand(name) {
    return new FangCommand(name);
  }
  createHelp() {
    return new FangHelp();
  }
}

export function createCli({
  name,
  description,
  version,
  usage = "[command] [--flags]",
  examples = [],
  commands = [],
  globalOptions = [],
  rootAction,
}) {
  const program = new FangCommand();
  program
    .name(name)
    .description(description)
    .usage(usage)
    .helpOption("-h, --help", "Show help")
    .addHelpCommand("help [command]", "Show help for a command")
    .showHelpAfterError(false)
    .allowExcessArguments();

  if (version) {
    program.option("-v, --version", "Show version");
  }

  for (const opt of globalOptions) {
    program.option(opt.flags, opt.description, opt.defaultValue);
  }

  program.examples = examples;

  if (rootAction) {
    program.action(rootAction);
  }

  for (const cmd of commands) {
    const command = program
      .command(cmd.name)
      .description(cmd.description)
      .action((...passed) => {
        const command = passed[passed.length - 1];
        const options = passed[passed.length - 2] ?? {};
        return cmd.action({ args: command.args, options, command });
      });

    if (cmd.allowUnknownOption) {
      command.allowUnknownOption();
    }
    if (cmd.allowExcessArguments) {
      command.allowExcessArguments();
    }
  }

  return program;
}

export async function runCli(program, argv) {
  program.exitOverride();
  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (err) {
    if (err.code && String(err.code).startsWith("commander.")) {
      // Commander has already printed help, version, or usage error.
      return;
    }
    throw err;
  }
}

export function formatError(message) {
  return `${theme.error("error:")} ${message}`;
}
