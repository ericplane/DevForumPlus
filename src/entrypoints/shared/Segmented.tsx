import { useId } from "preact/hooks";
import type { JSX } from "preact";

/**
 * A row of mutually exclusive choices, one of them pressed.
 *
 * This lived as a private function in Popup.tsx until the Options page needed
 * the same control. The two settings surfaces were disjoint — the popup had
 * the appearance knobs and no feature switches, Options had the switches and
 * no appearance knobs, and neither pointed at the other — and closing that gap
 * by copying the component would have meant two segmented controls drifting
 * apart, one per page. Its styles are in segmented.css beside this file,
 * imported by both pages' stylesheets; the variables it reads are listed there.
 *
 * `aria-pressed` buttons in a labelled group rather than radio inputs: the
 * pick applies on click with nothing to submit, and a pressed button is what a
 * screen reader should announce for a control that looks like this.
 *
 * The group's label used to be wired by `id="lbl-${label}"`. A label with a
 * space in it — "Text size" — put a space in the id, and `aria-labelledby` is a
 * space-separated list of ids, so the group pointed at two ids that did not
 * exist and had no accessible name at all. `useId` cannot produce that, and
 * two pages rendering the same label cannot collide.
 */
export function Segmented<T extends string>(props: {
  label: string;
  options: readonly T[];
  value: T;
  onPick: (value: T) => void;
  /**
   * A gloss for an option whose own text does not say enough — "XL" wants its
   * percentage, "full" wants the caveat that the pinned post has no margin to
   * borrow there. Return undefined for options that explain themselves.
   *
   * Rendered twice: as `title`, which only a hovering pointer ever sees, and
   * as `aria-description`, so a screen reader hears "S, pressed, 90%" rather
   * than "S, pressed" and nothing. As a description and not part of the name
   * on purpose — "full" is the name, the caveat is a sentence, and a name
   * that long is read out before every press.
   */
  describe?: (option: T) => string | undefined;
}): JSX.Element {
  const labelId = useId();
  return (
    <div class="seg-field">
      <span class="seg-label" id={labelId}>
        {props.label}
      </span>
      <div class="seg" role="group" aria-labelledby={labelId}>
        {props.options.map((opt) => {
          const gloss = props.describe?.(opt);
          return (
            <button
              key={opt}
              type="button"
              aria-pressed={opt === props.value}
              aria-description={gloss}
              title={gloss}
              onClick={() => props.onPick(opt)}
            >
              {opt}
            </button>
          );
        })}
      </div>
    </div>
  );
}
