import { styleText } from "node:util";
import {
  text,
  confirm,
  select,
  isCancel,
  limitOptions,
  symbol,
  symbolBar,
  S_BAR,
  S_RADIO_ACTIVE,
  S_RADIO_INACTIVE,
  SELECT_INSTRUCTIONS,
  formatInstructionFooter,
} from "@clack/prompts";
import { SelectPrompt, settings, wrapTextWithPrefix } from "@clack/core";
import { visibleLen, termWidth } from "./layout.mjs";

// Frame overhead of the clack select frame: left bar + gap + option marker
// + gap. Derived from Clack's own symbols so picker rows can be sized to
// exactly the space the frame leaves them (no magic numbers).
const FRAME_GUTTER = visibleLen(`${S_BAR}  `) + visibleLen(`${S_RADIO_ACTIVE} `);

/** Columns available to option content inside the select frame. */
export function promptContentWidth() {
  return Math.max(20, termWidth() - FRAME_GUTTER);
}

function guard(value) {
  if (isCancel(value)) return null;
  return value;
}

/** Clack validate convention: undefined = valid, string = error message.
 * Accept Inquirer-style `true` from callers and normalize it. */
function wrapValidate(validate) {
  if (!validate) return undefined;
  return (input) => {
    const result = validate(input);
    return result === true ? undefined : result;
  };
}

export async function promptText({ message, defaultValue, validate, placeholder }) {
  const value = await text({ message, placeholder, defaultValue, validate: wrapValidate(validate) });
  return guard(value);
}

export async function promptConfirm({ message, initialValue = true }) {
  const value = await confirm({ message, initialValue });
  return guard(value);
}

export async function promptNumber({ message, defaultValue, min, max, float = false }) {
  const value = await text({
    message,
    defaultValue: defaultValue !== undefined ? String(defaultValue) : undefined,
    initialValue: defaultValue !== undefined ? String(defaultValue) : undefined,
    validate(input) {
      if (input === "" && defaultValue !== undefined) return undefined;
      const num = float ? parseFloat(input) : parseInt(input, 10);
      if (!Number.isFinite(num)) return "Enter a valid number.";
      if (min !== undefined && num < min) return `Must be at least ${min}.`;
      if (max !== undefined && num > max) return `Must be at most ${max}.`;
      return undefined;
    },
  });
  if (isCancel(value)) return null;
  if (value === "" && defaultValue !== undefined) return defaultValue;
  return float ? parseFloat(value) : parseInt(value, 10);
}

export async function promptSelect({ message, choices, defaultValue }) {
  const options = choices.map((c) => ({
    value: c.value,
    label: c.label,
    hint: c.hint,
    disabled: c.disabled,
  }));
  const value = await select({ message, options, initialValue: defaultValue });
  return guard(value);
}

export async function promptSelectModel({ message, groups, defaultKey }) {
  // Clack's high-level select() has no group concept: it forces every row
  // through the same radio-marker style and paints disabled rows gray.
  // Build the picker from the same primitives Clack uses (SelectPrompt +
  // limitOptions) so group headers can render as real headers: a blank
  // line plus the caller-styled label, no marker. Header rows stay
  // `disabled` so arrow-key navigation skips them, and everything else
  // (hints, submit/cancel states, footer, viewport) matches native select.
  const options = [];
  let headerIndex = 0;
  for (const group of groups) {
    if (group.separator) {
      options.push({ value: `__group_${headerIndex++}`, label: group.separator, disabled: true, header: true });
    }
    for (const item of group.items) {
      options.push({
        value: item.value,
        label: item.label,
        hint: item.description,
        disabled: item.disabled,
      });
    }
  }
  const value = await groupSelect({
    message,
    options,
    initialValue: defaultKey,
    maxItems: Math.max((process.stdout.rows ?? 24) - 8, 8),
  });
  return guard(value);
}

const perLine = (value, fn) => value.split("\n").map((line) => fn(line)).join("\n");

/** Row styling identical to Clack's native select(). */
function styleOption(option, state) {
  if (option === undefined) return "";
  const label = option.label ?? String(option.value);
  switch (state) {
    case "disabled":
      return `${styleText("gray", S_RADIO_INACTIVE)} ${perLine(label, (l) => styleText("gray", l))}${option.hint ? ` ${styleText("dim", `(${option.hint})`)}` : ""}`;
    case "selected":
      return perLine(label, (l) => styleText("dim", l));
    case "active":
      return `${styleText("green", S_RADIO_ACTIVE)} ${label}${option.hint ? ` ${styleText("dim", `(${option.hint})`)}` : ""}`;
    case "cancelled":
      return perLine(label, (l) => styleText(["strikethrough", "dim"], l));
    default:
      return `${styleText("dim", S_RADIO_INACTIVE)} ${perLine(label, (l) => styleText("dim", l))}`;
  }
}

async function groupSelect({ message, options, initialValue, maxItems }) {
  const prompt = new SelectPrompt({
    options,
    initialValue,
    render() {
      const withGuide = settings.withGuide;
      const title = wrapTextWithPrefix(undefined, message, `${symbolBar(this.state)}  `, `${symbol(this.state)}  `);
      const prefix = `${withGuide ? `${styleText("gray", S_BAR)}\n` : ""}${title}\n`;
      switch (this.state) {
        case "submit": {
          const bar = withGuide ? `${styleText("gray", S_BAR)}  ` : "";
          const body = wrapTextWithPrefix(undefined, styleOption(this.options[this.cursor], "selected"), bar);
          return `${prefix}${body}`;
        }
        case "cancel": {
          const bar = withGuide ? `${styleText("gray", S_BAR)}  ` : "";
          const body = wrapTextWithPrefix(undefined, styleOption(this.options[this.cursor], "cancelled"), bar);
          return `${prefix}${body}${withGuide ? `\n${styleText("gray", S_BAR)}` : ""}`;
        }
        default: {
          const bar = withGuide ? `${styleText("cyan", S_BAR)}  ` : "";
          const headerLines = prefix.split("\n").length;
          const footer = formatInstructionFooter(SELECT_INSTRUCTIONS, withGuide);
          const rows = limitOptions({
            cursor: this.cursor,
            options: this.options,
            maxItems,
            columnPadding: visibleLen(bar),
            rowPadding: headerLines + footer.length + 1,
            style: (option, isActive) => {
              if (option.header) return `\n${option.label ?? ""}`;
              return styleOption(option, option.disabled ? "disabled" : isActive ? "active" : "inactive");
            },
          });
          return `${prefix}${bar}${rows.join(`\n${bar}`)}\n${footer.join("\n")}\n`;
        }
      }
    },
  });
  return await prompt.prompt();
}

export async function promptChoice({ message, choices, defaultValue }) {
  const options = choices.map((c) => ({
    value: c.value,
    label: c.label,
    hint: c.hint,
    disabled: c.disabled,
  }));
  const value = await select({ message, options, initialValue: defaultValue });
  return guard(value);
}

export async function promptMultiSelect({ message, choices }) {
  // Clack multiselect is a reasonable default for multi-select.
  const { multiselect } = await import("@clack/prompts");
  const value = await multiselect({
    message,
    options: choices.map((c) => ({ value: c.value, label: c.label, hint: c.hint })),
    required: false,
  });
  return guard(value) ?? [];
}
